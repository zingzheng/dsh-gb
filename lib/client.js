// dsh-gb client bundle — rebuilt by scripts/build-client.mjs
window.__ModuleLoader__.load({
  id: 'dsh-gb',
  factory: (require) => {
    'use strict';
    var module = { exports: {} };
    var exports = module.exports;
    //#region lib/qr.js (inlined)
// dsh-gb — 轻量 QR 编码器（byte 模式，版本 1-4，纠错 L/M/Q/H）。
// 纯 ES module，无依赖；Client bundle 构建时内联进 lib/client.js。
// 遵循 ISO/IEC 18004：数据编码、Reed-Solomon 纠错、分块交织、功能图形、
// 格式信息（BCH 15,5 + 0x5412 掩码）、8 种数据掩码与 4 条惩罚规则选优。

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function generatorPoly(n) {
  // product of (x - α^i), i = 0..n-1；系数按 x^0 升序存放
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], EXP[i]); // × α^i（x 项）
      next[j + 1] ^= poly[j];            // × x
    }
    poly = next;
  }
  return poly.slice(0, n + 1);
}

function rsEcc(data, ecCount) {
  const gen = generatorPoly(ecCount); // gen[j] ↔ x^j，gen[ecCount] = 1
  const rem = new Uint8Array(ecCount);
  for (const b of data) {
    const factor = b ^ rem[0];
    rem.copyWithin(0, 1);
    rem[ecCount - 1] = 0;
    // 余数寄存器 rem[i] 存放 x^(ecCount-1-i) 的系数 → 与 gen 低 ecCount 项（按幂对齐）相乘
    for (let i = 0; i < ecCount; i++) rem[i] ^= gfMul(gen[ecCount - 1 - i], factor);
  }
  return rem;
}

// 版本 1-4：每格 [数据码字数, 纠错码字数, 块数]（全部为均匀分块）
const EC_TABLE = {
  L: [null, [19, 7, 1], [34, 10, 1], [55, 15, 1], [80, 20, 1]],
  M: [null, [16, 10, 1], [28, 16, 1], [44, 26, 1], [64, 18, 2]],
  Q: [null, [13, 13, 1], [22, 22, 1], [34, 18, 2], [48, 26, 2]],
  H: [null, [9, 17, 1], [16, 28, 1], [26, 22, 2], [36, 16, 4]],
};

// 格式信息中的纠错级别位
const EC_BITS = { L: 1, M: 0, Q: 3, H: 2 };

const ALIGN = [null, [], [6, 18], [6, 22], [6, 26]];

function byteCapacity(version, ec) {
  const [data, , blocks] = EC_TABLE[ec][version];
  const dataBits = data * blocks * 8;
  return Math.floor((dataBits - 12 - 4) / 8);
}

function chooseVersion(len, ec) {
  for (let v = 1; v <= 4; v++) if (byteCapacity(v, ec) >= len) return v;
  throw new Error(`QR 内容过长（${len} 字节），当前支持版本 1-4`);
}

function drawFinder(modules, size, cx, cy) {
  for (let y = -4; y <= 4; y++) {
    for (let x = -4; x <= 4; x++) {
      const px = cx + x;
      const py = cy + y;
      if (px < 0 || py < 0 || px >= size || py >= size) continue;
      const dist = Math.max(Math.abs(x), Math.abs(y));
      modules[py][px] = dist !== 2 && dist !== 4;
    }
  }
}

function drawAlignment(modules, size, cx, cy) {
  for (let y = -2; y <= 2; y++) {
    for (let x = -2; x <= 2; x++) {
      const dist = Math.max(Math.abs(x), Math.abs(y));
      modules[cy + y][cx + x] = dist !== 1;
    }
  }
}

function makeFunctionMap(size, version) {
  const fn = Array.from({ length: size }, () => new Uint8Array(size));
  const mark = (x, y) => { fn[y][x] = 1; };
  // 三个定位图形及其分隔符（4 格外边界即分隔符区域）
  const centers = [[3, 3], [size - 4, 3], [3, size - 4]];
  for (const [cx, cy] of centers) {
    for (let y = -4; y <= 4; y++) for (let x = -4; x <= 4; x++) {
      const px = cx + x, py = cy + y;
      if (px >= 0 && py >= 0 && px < size && py < size) mark(px, py);
    }
  }
  // 校准图形（排除与三个定位图形重叠的角落：顶左、顶右、底左）
  const aligns = ALIGN[version];
  for (let yi = 0; yi < aligns.length; yi++) {
    for (let xi = 0; xi < aligns.length; xi++) {
      const cx = aligns[xi];
      const cy = aligns[yi];
      const isCorner = (xi === 0 && yi === 0) || (xi === aligns.length - 1 && yi === 0) || (xi === 0 && yi === aligns.length - 1);
      if (isCorner) continue;
      for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) mark(cx + x, cy + y);
    }
  }
  // 时序
  for (let i = 8; i < size - 8; i++) { mark(6, i); mark(i, 6); }
  // 格式信息预留区 + 暗模块
  for (let i = 0; i < 9; i++) { if (i !== 6) mark(i, 8); if (i !== 6) mark(8, i); }
  mark(8, size - 8);
  for (let i = 0; i < 8; i++) { mark(size - 1 - i, 8); mark(8, size - 1 - i); }
  return fn;
}

function formatBits(mask, ec) {
  const data = (EC_BITS[ec] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10 | rem) ^ 0x5412) & 0x7fff;
}

function drawFormat(modules, size, mask, ec) {
  const bits = formatBits(mask, ec);
  const get = (i) => ((bits >>> i) & 1) !== 0;
  const set = (x, y, v) => { modules[y][x] = v; };
  // 副本 1（左上）
  for (let i = 0; i < 6; i++) set(8, i, get(i));
  set(8, 7, get(6));
  set(8, 8, get(7));
  set(7, 8, get(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, get(i));
  // 副本 2（右上 + 左下）
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, get(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, get(i));
  set(size - 8, 8, true); // 暗模块
}

function maskBit(mask, r, c) {
  // r 行 / c 列
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  }
}

function drawCodewords(modules, fn, size, cw) {
  let i = 0;
  const total = cw.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fn[y][x] && i < total) {
          modules[y][x] = ((cw[i >> 3] >>> (7 - (i & 7))) & 1) !== 0;
          i++;
        }
      }
    }
  }
}

function penalty(modules, size) {
  let score = 0;
  // 行 / 列游程
  const runs = (line) => {
    let s = 0, run = 1;
    for (let i = 1; i < size; i++) {
      if (line[i] === line[i - 1]) run++;
      else { if (run >= 5) s += 3 + (run - 5); run = 1; }
    }
    if (run >= 5) s += 3 + (run - 5);
    return s;
  };
  for (let y = 0; y < size; y++) score += runs(modules[y]);
  for (let x = 0; x < size; x++) {
    const col = new Uint8Array(size);
    for (let y = 0; y < size; y++) col[y] = modules[y][x];
    score += runs(col);
  }
  // 2×2 同色
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
    const v = modules[y][x];
    if (v === modules[y][x + 1] && v === modules[y + 1][x] && v === modules[y + 1][x + 1]) score += 3;
  }
  // 类定位图案 1011101（两侧各 4 个浅格）
  const patternScore2 = (line) => {
    let s = 0;
    const p1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const p2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    const runsOf11 = [];
    for (let i = 0; i + 11 <= size; i++) runsOf11.push(i);
    for (const i of runsOf11) {
      let m1 = true, m2 = true;
      for (let j = 0; j < 11; j++) {
        if (line[i + j] !== p1[j]) m1 = false;
        if (line[i + j] !== p2[j]) m2 = false;
        if (!m1 && !m2) break;
      }
      if (m1) s += 40;
      if (m2) s += 40;
    }
    return s;
  };
  for (let y = 0; y < size; y++) score += patternScore2(modules[y]);
  for (let x = 0; x < size; x++) {
    const col = new Uint8Array(size);
    for (let y = 0; y < size; y++) col[y] = modules[y][x];
    score += patternScore2(col);
  }
  // 暗模块比例
  let dark = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) dark += modules[y][x] ? 1 : 0;
  const pct = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

/**
 * 生成 QR 矩阵。
 * @param text - 待编码字符串（byte 模式，按 UTF-8 字节计长时请先转字节数组；这里按
 *   `utf8BytesOf(text).length` 选择容量并按 UTF-8 字节编码）。
 * @param ec - 'L' | 'M' | 'Q' | 'H'
 * @returns { lines: boolean[][], size: number, version: number, mask: number }
 */
function encodeQr(text, ec = 'L') {
  const bytes = utf8BytesOf(text);
  const version = chooseVersion(bytes.length, ec);
  const size = 17 + version * 4;
  const cw = buildBitStreamFromBytes(bytes, version, ec);
  const fn = makeFunctionMap(size, version);
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const modules = Array.from({ length: size }, () => new Uint8Array(size));
    // 功能图形
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) drawFinder(modules, size, cx, cy);
    const aligns = ALIGN[version];
    for (let yi = 0; yi < aligns.length; yi++) {
      for (let xi = 0; xi < aligns.length; xi++) {
        const cx = aligns[xi];
        const cy = aligns[yi];
        const isCorner = (xi === 0 && yi === 0) || (xi === aligns.length - 1 && yi === 0) || (xi === 0 && yi === aligns.length - 1);
        if (isCorner) continue;
        drawAlignment(modules, size, cx, cy);
      }
    }
    for (let i = 8; i < size - 8; i++) { modules[6][i] = i % 2 === 0; modules[i][6] = i % 2 === 0; }
    drawCodewords(modules, fn, size, cw);
    // 数据掩码（跳过功能模块）
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (!fn[y][x] && maskBit(mask, y, x)) modules[y][x] = modules[y][x] ? 0 : 1;
    }
    drawFormat(modules, size, mask, ec);
    const score = penalty(modules, size);
    if (best === null || score < best.score) best = { modules, score, mask };
  }
  const lines = best.modules.map((row) => Array.from(row, (v) => v !== 0));
  return { lines, size, version, mask: best.mask };
}

function utf8BytesOf(text) {
  const enc = new TextEncoder();
  const bytes = enc.encode(text);
  return Array.from(bytes);
}

function buildBitStreamFromBytes(bytes, version, ec) {
  const [data, ecc, blocks] = EC_TABLE[ec][version];
  const dataBytes = data * blocks;
  const bits = [];
  const push = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  push(0x4, 4);
  push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  let i = bits.length;
  const capacityBits = dataBytes * 8;
  for (let t = 0; t < 4 && i < capacityBits; t++, i++) bits.push(0);
  while (i < capacityBits && (i & 7) !== 0) { bits.push(0); i++; }
  for (let pad = 0xec; i < capacityBits; pad = pad === 0xec ? 0x11 : 0xec) {
    push(pad, 8);
    i += 8;
  }
  const perBlock = dataBytes / blocks;
  const dataCw = new Uint8Array(dataBytes);
  for (let k = 0; k < dataBytes; k++) {
    let v = 0;
    for (let b = 0; b < 8; b++) v = (v << 1) | bits[k * 8 + b];
    dataCw[k] = v;
  }
  const eccCw = new Uint8Array(ecc * blocks);
  for (let bl = 0; bl < blocks; bl++) {
    const eccBlock = rsEcc(dataCw.subarray(bl * perBlock, (bl + 1) * perBlock), ecc);
    eccCw.set(eccBlock, bl * ecc);
  }
  const final = new Uint8Array(dataBytes + ecc * blocks);
  let at = 0;
  for (let i = 0; i < perBlock; i++) for (let bl = 0; bl < blocks; bl++) final[at++] = dataCw[bl * perBlock + i];
  for (let i = 0; i < ecc; i++) for (let bl = 0; bl < blocks; bl++) final[at++] = eccCw[bl * ecc + i];
  return final;
}

/** 矩阵 → 可内联的 SVG 字符串（含安静区）。 */
function qrSvg(lines, size, scale = 4, quiet = 4) {
  const dim = (size + quiet * 2) * scale;
  let rects = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (lines[y][x]) rects += `<rect x="${(x + quiet) * scale}" y="${(y + quiet) * scale}" width="${scale}" height="${scale}"/>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim}" height="${dim}" shape-rendering="crispEdges"><rect width="${dim}" height="${dim}" fill="#fff"/>${rects}</svg>`;
}

    //#endregion
    //#region lib/client-src.js
// dsh-gb — CLIENT 半部源码（由 scripts/build-client.mjs 与 lib/qr.js 一起
// 打包成 window.__ModuleLoader__.load 形式，输出到 lib/client.js）。
// 约束：仅 require('react')；不使用 JSX/TS/import。
//
// 架构：
// - RootBridge（shell.overlay，根作用域常驻）：会话/工作区列表与选择的「根桥」，
//   在 hero / 空白会话 / 切换工作区期间也存活，负责 基础状态推送 + open-* 命令执行。
// - SessionRelay（conversation.composer.dock，会话作用域）：只在有真实会话时挂载，
//   只负责 审批/选择题 carrier 的轻量摘要推送与应答（GUI 同款 PendingWait.respond）。

const React = require('react');

let bridgeBasePromise = null;

function resetBridgeInfo() {
  bridgeBasePromise = null;
}

function hostnameOf() {
  try { return (window.location.hostname || '').trim(); } catch { return ''; }
}

function scanHosts() {
  const hosts = [];
  const h = hostnameOf();
  if (h !== '' && h !== 'localhost' && h !== '127.0.0.1' && h !== '::1') hosts.push(h);
  hosts.push('127.0.0.1');
  return hosts;
}

async function scanPort(host) {
  const jobs = [];
  for (let port = 7788; port <= 7795; port++) {
    jobs.push((async () => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 700);
        const r = await fetch(`http://${host}:${port}/info`, { cache: 'no-store', signal: controller.signal })
          .then((res) => (res.ok ? res.json() : null));
        clearTimeout(timer);
        return (r !== null && r.ok === true) ? { port, url: r.url, token: tokOf(r.url) } : null;
      } catch { return null; }
    })());
  }
  const results = await Promise.all(jobs);
  for (const r of results) if (r !== null) return r;
  return null;
}

/** bridge 端点：同源优先（webServer 代理，任何 GUI 访问方式都可用）；
 *  否则直连扫描到的局域网主机。 */
function endpointOf(base, path) {
  if (base.sameOrigin === true) return '/phone-remote' + path;
  return `http://${base.host}:${base.port}` + path;
}

function fetchInfo() {
  if (bridgeBasePromise !== null) return bridgeBasePromise;
  bridgeBasePromise = (async () => {
    // 1) 同源 /phone-remote/info（dsh webServer 代理）
    const same = await fetch('/phone-remote/info', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .catch((e) => { console.error('[dsh-gb] same-origin info 失败', e); return null; });
    if (same !== null && same.ok === true) {
      console.log('[dsh-gb] info(同源)', JSON.stringify(same));
      return { port: same.port, host: hostnameOf() || '127.0.0.1', token: tokOf(same.url), url: same.url, sameOrigin: true };
    }
    // 2) 扫描：先按页面 hostname（远程访问 GUI 的场景），再本机 127.0.0.1
    for (const host of scanHosts()) {
      const found = await scanPort(host);
      if (found !== null) {
        console.log('[dsh-gb] info(扫描)', host + ':' + found.port);
        return { port: found.port, host, token: found.token, url: found.url, sameOrigin: false };
      }
    }
    console.error('[dsh-gb] 未找到本地掌机服务器');
    return null;
  })();
  return bridgeBasePromise;
}

function tokOf(url) {
  try {
    const u = new URL(url);
    return u.searchParams.get('t') ?? '';
  } catch {
    return '';
  }
}

function waitSummary(wait) {
  if (wait === undefined || wait === null) return null;
  const payload = wait.payload ?? {};
  if (wait.kind === 'approval') {
    return {
      kind: 'approval',
      key: wait.key,
      approvalId: payload.approvalId ?? '',
      toolName: payload.toolName ?? '',
      reason: payload.reason ?? '',
    };
  }
  if (wait.kind === 'question') {
    const questions = Array.isArray(payload.questions) ? payload.questions : [];
    const supported = questions.length > 0
      && questions.length <= 8
      && questions.every((q) => q !== null && typeof q === 'object' && q.multiSelect !== true
        && Array.isArray(q.options ? q.options : []) && (q.options.length + 1) <= 9);
    return {
      kind: 'question',
      key: wait.key,
      supported,
      questions: questions.map((q) => {
        const options = Array.isArray(q.options)
          ? q.options.filter((o) => typeof o.label === 'string' && o.label !== '').map((o) => o.label)
          : [];
        return {
          id: q.id ?? 'question',
          text: q.question ?? '',
          options,
          multiSelect: q.multiSelect === true,
        };
      }),
    };
  }
  return null;
}

/** 基础状态：当前选择 + 有序列表（不含 pending）。标题回退链与 web 一致：
 *  展示标题（displayTitle = 持久标题 ?? 工作区目录名 ?? id）。 */
function baseStateOf(sessionsList, workspaceState) {
  const current = sessionsList?.current ?? null;
  const byId = sessionsList?.byId ?? {};
  const visible = (id) => {
    const s = byId[id];
    return s !== undefined && s.blank !== true && s.removed !== true;
  };
  const titleOf = (id) => {
    const s = byId[id];
    if (s === undefined) return id;
    if (typeof s.displayTitle === 'string' && s.displayTitle !== '') return s.displayTitle;
    if (typeof s.title === 'string' && s.title !== '') return s.title;
    return id;
  };
  const items = workspaceState?.items ?? [];
  const currentWorkspace = items.find((w) => Array.isArray(w.sessionIds) && w.sessionIds.includes(current));
  const workspaceId = currentWorkspace?.workspaceId ?? null;
  const workspaceTitle = currentWorkspace?.title ?? '';
  let sessions;
  if (currentWorkspace !== undefined) {
    sessions = (currentWorkspace.sessionIds ?? []).filter(visible).map((id) => ({ id, title: titleOf(id) }));
  } else {
    sessions = (sessionsList?.ids ?? []).filter(visible).map((id) => ({ id, title: titleOf(id) }));
  }
  const workspaces = items.map((w) => ({ id: w.workspaceId, title: w.title ?? w.path ?? w.workspaceId }));
  const self = byId[current];
  return {
    sessionId: current ?? null,
    sessionTitle: self !== undefined && self.blank !== true ? titleOf(current) : '',
    sessionBlank: self?.blank === true,
    workspaceId,
    workspaceTitle,
    sessions,
    workspaces,
  };
}

function makeSettingsPage() {
  function SettingsPage() {
    const [info, setInfo] = React.useState(null);
    const [error, setError] = React.useState('');
    const [notice, setNotice] = React.useState('');
    const refresh = () => {
      setError('');
      fetchInfo().then((base) => {
        if (base === null) {
          setInfo(null);
          setError('未检测到本地掌机服务：请确认插件已成功加载（修改后需重启 dsh）');
          return;
        }
        // 追加实时在线状态（每次重拉，不受 fetchInfo 缓存影响）
        fetch(endpointOf(base, '/info'), { cache: 'no-store' })
          .then((r) => r.json())
          .then((live) => {
            setInfo({
              ...base,
              phonesOnline: live && typeof live.phonesOnline === 'number' ? live.phonesOnline : 0,
              bridgeOnline: live !== null && live !== undefined && live.bridgeOnline === true,
            });
          })
          .catch(() => setInfo(base));
      }).catch(() => setError('信息获取失败'));
    };
    // 打开设置页期间每 3.5s 轮询一次在线状态（手机扫码连接后数字自动更新）
    React.useEffect(() => {
      refresh();
      const timer = setInterval(refresh, 3500);
      return () => clearInterval(timer);
    }, []);
    let svg = '';
    if (info !== null && info.token !== '') {
      try {
        const qr = encodeQr(info.url, 'L');
        svg = qrSvg(qr.lines, qr.size, 4, 4);
      } catch {
        svg = '';
      }
    }
    return React.createElement('div', null,
      React.createElement('style', null, [
        '.dpr-page{display:flex;flex-direction:column;gap:14px;max-width:440px;}',
        '.dpr-qr{background:#fff;border-radius:14px;padding:14px;width:max-content;}',
        '.dpr-qr svg{display:block;width:220px;height:220px;}',
        '.dpr-url{display:flex;gap:8px;align-items:center;}',
        '.dpr-url input{flex:1;min-width:0;font:12px/1.4 ui-monospace,Consolas,monospace;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#333);background:var(--dsw-specific-input-base,#111);color:var(--dsw-alias-label-primary,#eee);}',
        '.dpr-hint{font-size:12.5px;color:var(--dsw-alias-label-tertiary,#999);line-height:1.8;white-space:pre-line;}',
        '.dpr-meta{font-size:12px;color:var(--dsw-alias-label-secondary,#bbb);display:flex;gap:14px;flex-wrap:wrap;}',
        '.dpr-err{color:var(--dsw-alias-state-error-primary,#f66);font-size:13px;}',
        '.dpr-ok{color:#7fc97f;font-size:13px;}',
        '.dpr-copy{padding:6px 10px;}',
        '.dpr-reset{padding:6px 10px;color:var(--dsw-alias-state-error-primary,#f66);border:1px solid currentColor;background:transparent;}',
      ].join('')),
      React.createElement('div', { className: 'dpr-page' },
        info === null
          ? React.createElement('p', { className: 'dpr-err' }, error || '正在获取…')
          : React.createElement(React.Fragment, null,
              React.createElement('h3', null, '① 手机扫码连接（同一局域网）'),
              svg === ''
                ? React.createElement('p', { className: 'dpr-err' }, '二维码生成失败')
                : React.createElement('div', { className: 'dpr-qr', dangerouslySetInnerHTML: { __html: svg } }),
              React.createElement('div', { className: 'dpr-url' },
                React.createElement('input', {
                  readOnly: true,
                  value: info.url,
                  onFocus: (e) => { try { e.target.select(); } catch { /* noop */ } },
                }),
                React.createElement('button', { className: 'dpr-copy', onClick: () => {
                  try { navigator.clipboard.writeText(info.url); } catch { /* noop */ }
                } }, '复制'),
              ),
              React.createElement('div', { className: 'dpr-meta' },
                React.createElement('span', null, '端口 ' + info.port),
                React.createElement('span', null, '手机在线 ' + info.phonesOnline + ' 台'),
                React.createElement('span', null, '浏览器桥：' + (info.bridgeOnline ? '已连接' : '未连接')),
              ),
              notice === '' ? null : React.createElement('p', { className: 'dpr-ok' }, notice),
              React.createElement('div', { className: 'dpr-hint' },
                '② 手机与电脑需处于同一局域网；手机可用自带输入法（如豆包）语音转文字，' +
                '在遥控页发送即可把内容送入当前会话。\n' +
                '③ 若手机打不开页面：请允许 dsh（Node.js）通过 Windows 防火墙（专用网络），' +
                '并检查路由器是否隔离了设备间访问。\n' +
                '④ 令牌首次启动生成并持久化（~/.dsh/dsh-gb.token），重启 dsh 不会失效，' +
                '二维码与 URL 可收藏长期使用；点击「重置令牌」可一键作废旧令牌（旧链接随之失效）。',
              ),
              React.createElement('button', { onClick: refresh }, '刷新'),
              React.createElement('button', { className: 'dpr-reset', onClick: () => {
                let ok = false;
                try { ok = window.confirm('重置令牌：所有旧二维码/链接立即失效，需重新扫码。确定？'); } catch { ok = false; }
                if (!ok) return;
                fetch('/phone-remote/token/reset', { method: 'POST' })
                  .then((r) => r.json())
                  .then((r) => {
                    if (r !== null && r !== undefined && r.ok === true) {
                      resetBridgeInfo();
                      setNotice('已重置令牌：旧二维码/链接已失效，请用新二维码重新连接');
                      refresh();
                    } else {
                      setError('重置失败：' + ((r && r.error) || '未知错误'));
                    }
                  })
                  .catch(() => setError('重置失败：网络错误'));
              } }, '重置令牌'),
            ),
      ),
    );
  }
  return SettingsPage;
}

/** 根桥：常驻（shell.overlay），推送基础状态并执行 open-* 命令。 */
function makeRootBridge(sessionsService, workspacesService) {
  function RootBridgeView(props) {
    const lastSnapRef = React.useRef('');
    const timerRef = React.useRef(null);
    const esRef = React.useRef(null);
    const snapRef = React.useRef('');

    // 渲染期组合基础状态（Hook 只能在渲染体内调用）
    const sessionsList = props.useSessions((s) => s);
    const workspaceState = props.useWorkspaces((s) => s);
    let computedJson = '';
    try {
      computedJson = JSON.stringify(baseStateOf(sessionsList, workspaceState));
    } catch {
      computedJson = '';
    }
    snapRef.current = computedJson;
    // 最新快照供命令处理器使用（打开工作区需要选择"最近真实会话"）
    const sessionSnapRef = React.useRef(null);
    sessionSnapRef.current = sessionsList;
    const workspaceSnapRef = React.useRef(null);
    workspaceSnapRef.current = workspaceState;

    // push 只读 refs，可安全在两个 effect 中使用
    const push = () => {
      const json = snapRef.current;
      if (json === '' || json === lastSnapRef.current) return;
      lastSnapRef.current = json;
      fetchInfo().then((base) => {
        if (base === null) return;
        fetch(endpointOf(base, `/bridge/state?t=${encodeURIComponent(base.token)}`), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: json,
        }).then((r) => r.json()).then((r) => {
          if (!r.ok) console.warn('[dsh-gb] 状态推送被拒', r.error);
        }).catch(() => { resetBridgeInfo(); });
      });
    };

    React.useEffect(() => { push(); }, [computedJson]);

    React.useEffect(() => {
      let closed = false;
      const open = () => {
        fetchInfo().then((base) => {
          if (closed || base === null) return;
          const url = endpointOf(base, `/bridge/events?t=${encodeURIComponent(base.token)}`);
          const es = new EventSource(url);
          esRef.current = es;
          es.addEventListener('cmd', (event) => {
            if (event.data === undefined || event.data === null) return;
            let cmd;
            try { cmd = JSON.parse(event.data); } catch { return; }
            if (cmd.cmd === 'refresh') { push(); return; }
            if (cmd.cmd === 'open-session') {
              try { if (cmd.sessionId) sessionsService.open(cmd.sessionId); } catch { /* noop */ }
              return;
            }
            if (cmd.cmd === 'open-workspace') {
              // 打开目标工作区的"最近真实会话"；无真实会话时回退到新建（新会话）。
              try {
                const wsItems = workspaceSnapRef.current?.items ?? [];
                const ws = wsItems.find((w) => w.workspaceId === cmd.workspaceId);
                const byId = sessionSnapRef.current?.byId ?? {};
                const candidates = (ws?.sessionIds ?? [])
                  .map((id) => byId[id])
                  .filter((s) => s !== undefined && s.blank !== true);
                if (candidates.length > 0) {
                  candidates.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
                  sessionsService.open(candidates[0].id);
                  return;
                }
                workspacesService.connectWorkspace(cmd.workspaceId)
                  .then((sid) => sessionsService.open(sid))
                  .catch(() => { /* noop */ });
              } catch { /* noop */ }
              return;
            }
            if (cmd.cmd === 'new-session') {
              // 新建会话：进入目标工作区（默认当前）的新会话流程
              try { workspacesService.startSession(cmd.workspaceId ?? undefined); } catch { /* noop */ }
              return;
            }
          });
          es.onerror = () => {
            resetBridgeInfo();
            try { es.close(); } catch { /* noop */ }
            if (!closed) timerRef.current = setTimeout(open, 3000);
          };
        });
      };
      open();
      return () => {
        closed = true;
        if (timerRef.current !== null) { clearTimeout(timerRef.current); timerRef.current = null; }
        if (esRef.current !== null) { try { esRef.current.close(); } catch { /* noop */ } }
      };
    }, []);

    return null;
  }
  return RootBridgeView;
}

/** 会话中继：只在真实会话中挂载，负责审批/题目 carrier 的摘要推送与应答。 */
function makeSessionRelay(sessionsService, workspacesService) {
  function SessionRelayView(props) {
    const session = props.session;
    const waitsRef = React.useRef(new Map());
    const lastPendingRef = React.useRef('');
    const timerRef = React.useRef(null);
    const esRef = React.useRef(null);

    waitsRef.current = new Map();
    for (const wait of session?.pending ?? []) {
      if (wait !== undefined && wait !== null) waitsRef.current.set(wait.key, wait);
    }

    let pendingJson = '';
    if (session !== undefined && session !== null) {
      try {
        pendingJson = JSON.stringify((session.pending ?? []).map(waitSummary).filter((s) => s !== null));
      } catch {
        pendingJson = '';
      }
    }
    const pendingRef = React.useRef('');
    pendingRef.current = pendingJson;

    const pushPending = () => {
      const json = pendingRef.current;
      if (json === lastPendingRef.current) return;
      lastPendingRef.current = json;
      fetchInfo().then((base) => {
        if (base === null) return;
        let parsed;
        try { parsed = JSON.parse(json); } catch { return; }
        fetch(endpointOf(base, `/bridge/pending?t=${encodeURIComponent(base.token)}`), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pending: parsed }),
        }).then((r) => r.json()).then((r) => {
          if (!r.ok) console.warn('[dsh-gb] pending 推送被拒', r.error);
        }).catch(() => { resetBridgeInfo(); });
      });
    };

    React.useEffect(() => { pushPending(); }, [pendingJson]);

    React.useEffect(() => {
      const handleCommand = (cmd) => {
        if (cmd === undefined || cmd === null) return;
        if (cmd.cmd === 'refresh') { pushPending(); return; }
        if (cmd.cmd === 'approval-answer') {
          const wait = waitsRef.current.get(cmd.key);
          if (wait === undefined) return;
          const outcome = cmd.outcome === 'rejected' ? 'rejected' : 'allowed-once';
          try {
            wait.respond({
              ok: true,
              value: { sessionId: wait.sessionId, approvalId: wait.payload?.approvalId, outcome },
            });
          } catch { /* 已结算 */ }
          return;
        }
        if (cmd.cmd === 'question-answer') {
          const wait = waitsRef.current.get(cmd.key);
          if (wait === undefined) return;
          try {
            wait.respond({
              ok: true,
              value: { sessionId: wait.sessionId, answer: { answers: cmd.answers } },
            });
          } catch { /* 已结算 */ }
          return;
        }
      };
      let closed = false;
      const open = () => {
        fetchInfo().then((base) => {
          if (closed || base === null) return;
          const url = endpointOf(base, `/bridge/events?t=${encodeURIComponent(base.token)}`);
          const es = new EventSource(url);
          esRef.current = es;
          es.addEventListener('cmd', (event) => {
            if (event.data === undefined || event.data === null) return;
            let cmd;
            try { cmd = JSON.parse(event.data); } catch { return; }
            handleCommand(cmd);
          });
          es.onerror = () => {
            resetBridgeInfo();
            try { es.close(); } catch { /* noop */ }
            if (!closed) timerRef.current = setTimeout(open, 3000);
          };
        });
      };
      open();
      return () => {
        closed = true;
        if (timerRef.current !== null) { clearTimeout(timerRef.current); timerRef.current = null; }
        if (esRef.current !== null) { try { esRef.current.close(); } catch { /* noop */ } }
      };
    }, []);

    return null;
  }
  return SessionRelayView;
}

function apply(ctx) {
  const slots = ctx.get('slots');
  if (slots === undefined) return;
  const sessionsService = ctx.get('sessions');
  const workspacesService = ctx.get('workspaces');

  slots.inject('settings.section', () => slots.register(
    {
      name: 'settings.section',
      id: 'dsh-gb',
      order: 500,
      label: '掌机',
    },
    makeSettingsPage(),
  ));

  slots.inject('shell.overlay', () => slots.register(
    {
      name: 'shell.overlay',
      id: 'dsh-gb',
      order: 800,
      label: '',
    },
    makeRootBridge(sessionsService, workspacesService),
  ));

  slots.inject('conversation.composer.dock', () => slots.register(
    {
      name: 'conversation.composer.dock',
      id: 'dsh-gb',
      order: 50,
      label: '',
    },
    makeSessionRelay(sessionsService, workspacesService),
  ));
}

const inject = ['slots', 'sessions', 'workspaces'];

    //#endregion
    exports.apply = apply;
    exports.inject = inject;
    exports._qr = { encodeQr: encodeQr, qrSvg: qrSvg };
    return module.exports;
  }
});
