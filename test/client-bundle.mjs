// 验证 lib/client.js 具备 __ModuleLoader__.load 形态、导出 apply/inject，
// 且 apply 能向 slots 注册设置页与 dock 中继（用 React 桩替换）。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const code = readFileSync(join(root, 'lib', 'client.js'), 'utf8');

let loaded = null;
const windowStub = {
  __ModuleLoader__: {
    load(record) { loaded = record; },
  },
};
new Function('window', code)(windowStub);

if (loaded === null || loaded.id !== 'dsh-gb') {
  console.error('FAIL 未捕获 load 调用');
  process.exit(1);
}

const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol('Fragment'),
  useState: (v) => [Array.isArray(v) ? v : v, () => {}],
  useEffect: (fn) => { try { fn(); } catch { /* noop */ } },
  useRef: (v) => ({ current: v }),
};
const req = (name) => {
  if (name === 'react') return reactStub;
  throw new Error('unexpected require: ' + name);
};
let moduleObj;
try {
  moduleObj = loaded.factory(req);
} catch (e) {
  console.error('FAIL factory 抛错:', e && e.stack ? e.stack : String(e));
  process.exit(1);
}

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

check('导出 apply/inject', typeof moduleObj.apply === 'function' && Array.isArray(moduleObj.inject));
check('inject 声明 slots/sessions/workspaces', moduleObj.inject.join(',') === 'slots,sessions,workspaces');

// 真实 URL 形态的 QR 生成（复现设置页路径）
const url = 'http://192.168.1.5:7788/?t=0123456789abcdef0123456789abcdef';
let qrResult = null;
try {
  const qr = moduleObj._qr.encodeQr(url, 'L');
  if (Array.isArray(qr.lines) && qr.size > 0) qrResult = qr;
} catch (e) {
  qrResult = 'THREW: ' + e.message;
}
check('bundle 内 QR 编码器可用（真实 URL 形态）', qrResult !== null && qrResult !== 'THREW', String(qrResult).slice(0, 80));
if (qrResult !== null && qrResult !== 'THREW') {
  const svg = moduleObj._qr.qrSvg(qrResult.lines, qrResult.size, 4, 4);
  check('bundle 内 qrSvg 输出 SVG', typeof svg === 'string' && svg.startsWith('<svg') && svg.includes('<rect'));
}

const registrations = [];
const slotsFake = {
  inject: (name, cb) => { cb(); },
  register: (options, component) => { registrations.push({ options, component }); },
};
const ctxFake = {
  get: (name) => {
    if (name === 'slots') return slotsFake;
    if (name === 'sessions') return { open: () => {}, list: {} };
    if (name === 'workspaces') return { connectWorkspace: () => Promise.resolve('sid') };
    return undefined;
  },
};
moduleObj.apply(ctxFake);

const settings = registrations.find((r) => r.options.name === 'settings.section' && r.options.id === 'dsh-gb');
const dock = registrations.find((r) => r.options.name === 'conversation.composer.dock' && r.options.id === 'dsh-gb');
check('注册了设置页 settings.section', settings !== undefined);
check('注册了 dock 中继 conversation.composer.dock', dock !== undefined);

// 渲染 dock（session 为空时返回 null 且不抛错）
let rendered;
try {
  rendered = dock.component({
    session: null,
    input: null,
    useSessions: () => ({}),
    useWorkspaces: () => ({}),
  });
} catch (e) {
  rendered = 'THREW: ' + e.message;
}
check('dock 空会话渲染为 null', rendered === null, String(rendered));

// 设置页在 fetch 不可用时不应崩溃：直接调用（其内部 fetch 会失败 → 组件仍返回节点）
let page;
try {
  page = settings.component();
} catch (e) {
  page = 'THREW: ' + e.message;
}
check('设置页组件可渲染（无服务时降级）', typeof page === 'object' && page !== null, String(page));

process.exit(failures === 0 ? 0 : 1);
