// 服务器核心冒烟测试：不依赖 cordis，直接实例化 PhoneRemoteServer。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import os from 'node:os';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const coreSrc = readFileSync(join(root, 'lib', 'server-core.js'), 'utf8');
const pageSrc = readFileSync(join(root, 'lib', 'phone-page.js'), 'utf8');
const { PhoneRemoteServer } = await import('data:text/javascript;base64,' + Buffer.from(coreSrc).toString('base64'));
const { phonePageHtml } = await import('data:text/javascript;base64,' + Buffer.from(pageSrc).toString('base64'));

const log = [];
const hooks = {
  log: (level, msg) => log.push(`${level}: ${msg}`),
  onSend: async (sessionId, text) => {
    hooks.sent.push({ sessionId, text });
    return { ok: true };
  },
  onPause: async (sessionId) => {
    hooks.paused.push(sessionId);
    return { ok: true };
  },
  getSessionMeta: (sessionId) => ({
    status: sessionId === 's1' ? 'running' : 'idle',
    summary: sessionId === 's1' ? '' : '完成一句话总结示例',
  }),
  getTitles: (ids) => {
    const out = {};
    for (const id of ids ?? []) {
      if (id === 's1') out[id] = 'host-实时标题';
    }
    return out;
  },
  getMessages: (sessionId) => sessionId === 's1' ? [
    { role: 'user', text: '帮我写一个测试' },
    { role: 'assistant', text: '好的，这是回答。' },
  ] : [],
  sent: [],
  paused: [],
};
hooks.sent = [];
hooks.paused = [];

const server = new PhoneRemoteServer(hooks);
server.setPage(phonePageHtml);
server.setHost('192.168.1.99');
const started = await server.start([7791]);
const base = `http://127.0.0.1:${server.port}`;

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

// 1. /info 环回可访问
const info = await fetch(`${base}/info`).then((r) => r.json());
check('/info 返回 url 含令牌', info.ok === true && info.url.includes('t=') && info.port === 7791);

// 1b. 公网地址覆盖（隧道）：/info 的 url 使用隧道地址并保留令牌；隧道状态透传
server.setPublicBase('https://abc-def.trycloudflare.com');
const infoT = await fetch(`${base}/info`).then((r) => r.json());
check('公网地址覆盖后 /info url 为隧道地址且带令牌',
  String(infoT.url).startsWith('https://abc-def.trycloudflare.com/?t=') && infoT.url.includes(server.token));
server.setTunnelInfo({ state: 'running', mode: 'quick', url: 'https://abc-def.trycloudflare.com', error: null });
const infoT2 = await fetch(`${base}/info`).then((r) => r.json());
check('/info 携带隧道状态', infoT2.tunnel?.state === 'running' && infoT2.tunnel?.url === 'https://abc-def.trycloudflare.com');
server.setPublicBase(null);
server.setTunnelInfo(null);

// 2. 页面需要令牌
const noToken = await fetch(`${base}/`);
check('无令牌访问 / 被拒', noToken.status === 403);
const page = await fetch(`${base}/?t=${server.token}`);
const pageHtml = await page.text();
check('带令牌访问 / 返回页面', page.status === 200 && pageHtml.includes('DSH 掌机'));

// 3. POST /api 无令牌被拒
const apiNoToken = await fetch(`${base}/api`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
check('无令牌 POST /api 被拒', apiNoToken.status === 403);

// 4. bridge: 推基础状态 + 待交互摘要（审批 + 多题选择题）
const statePayload = {
  sessionId: 's1',
  sessionTitle: '会话一',
  workspaceId: 'w1',
  workspaceTitle: '工作区一',
  sessions: [{ id: 's1', title: '会话一' }, { id: 's2', title: '会话二' }],
  workspaces: [{ id: 'w1', title: '工作区一' }, { id: 'w2', title: '工作区二' }],
};
const pendingPayload = {
  pending: [
    { kind: 'approval', key: 'a:1', approvalId: 'ap1', toolName: 'bash', reason: '执行命令 rm -rf x' },
    { kind: 'question', key: 'q:9', supported: true, questions: [
      { id: 'q1', text: '继续吗？', options: ['继续', '停止', '再说'], multiSelect: false },
      { id: 'q2', text: '选择方案', options: ['A 方案', 'B 方案'], multiSelect: false },
    ] },
  ],
};
const pushRes = await fetch(`${base}/bridge/state?t=${server.token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(statePayload) });
check('bridge/state 推送成功', pushRes.status === 200 && (await pushRes.json()).ok === true);
const pushPendingRes = await fetch(`${base}/bridge/pending?t=${server.token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pendingPayload) });
check('bridge/pending 推送成功', pushPendingRes.status === 200 && (await pushPendingRes.json()).ok === true);

// 5. SSE /events 收到合并状态（含 status/summary 增强）
const sseText = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('sse timeout')), 5000);
  const req = http.get(`${base}/events?t=${server.token}`, (res) => {
    let buf = '';
    res.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.includes('"status"')) { clearTimeout(timer); res.destroy(); resolve(buf); }
    });
  });
  req.on('error', reject);
});
check('SSE 首帧含运行态与增强，标题优先用 Host 实时值（选中 + 列表）', sseText.includes('"status":"running"') && sseText.includes('"sessionTitle":"host-实时标题"') && sseText.includes('"title":"host-实时标题"'));
check('SSE 首帧包含会话消息（供浏览）', sseText.includes('"messages"') && sseText.includes('好的，这是回答。'));

// 5b. GET /state：轮询降级接口（与 SSE 首帧同构的合并状态）
const stateRes = await fetch(`${base}/state?t=${server.token}`);
const stateJson = await stateRes.json();
check('GET /state 返回合并状态',
  stateRes.status === 200 && stateJson.connected === true && stateJson.status === 'running' && stateJson.sessionId === 's1');
const stateBad = await fetch(`${base}/state?t=${'b'.repeat(32)}`);
check('GET /state 错误令牌被拒', stateBad.status === 403);

// 6. /api send → onSend 收到文本
const sendRes = await fetch(`${base}/api?t=${server.token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'send', text: '你好' }) });
check('send 注入会话', (await sendRes.json()).ok === true && hooks.sent[0]?.sessionId === 's1' && hooks.sent[0]?.text === '你好');

// 7. 审批：桥连接接收 cmd（先等桥建立（收到 refresh），再触发审批）
let bridgeBuf = '';
let bridgeResolveApproval = null;
const bridgeConnected = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('bridge connect timeout')), 5000);
  const req = http.get(`${base}/bridge/events?t=${server.token}`, (res) => {
    res.on('data', (chunk) => {
      bridgeBuf += chunk.toString('utf8');
      if (bridgeBuf.includes('"refresh"')) { clearTimeout(timer); resolve(); }
      if (bridgeBuf.includes('"approval-answer"') && bridgeResolveApproval !== null) {
        bridgeResolveApproval(bridgeBuf);
        bridgeResolveApproval = null;
      }
    });
  });
  req.on('error', reject);
});
await bridgeConnected;
const approvalRes = await fetch(`${base}/api?t=${server.token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'approval', outcome: 'allowed-once' }) });
const approvalJson = await approvalRes.json();
const approvalData = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('approval cmd timeout')), 5000);
  bridgeResolveApproval = (buf) => { clearTimeout(timer); resolve(buf); };
  if (bridgeBuf.includes('"approval-answer"')) { bridgeResolveApproval(bridgeBuf); bridgeResolveApproval = null; }
});
check('审批转发到桥', approvalJson.ok === true && approvalData.includes('"approval-answer"') && approvalData.includes('"outcome":"allowed-once"'), JSON.stringify(approvalJson));

// 8. 选择题：整组答案原样转发
const answers = [
  { id: 'q1', selected: ['继续'] },
  { id: 'q2', selected: ['B 方案'] },
];
const qRes = await fetch(`${base}/api?t=${server.token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'question-answer', answers }) });
const qJson = await qRes.json();
const qData = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('question cmd timeout')), 5000);
  const checkOnce = () => {
    if (bridgeBuf.includes('"question-answer"') && bridgeBuf.includes('B 方案')) { clearTimeout(timer); resolve(bridgeBuf); }
  };
  const id = setInterval(checkOnce, 100);
  setTimeout(() => { clearInterval(id); checkOnce(); }, 4000);
});
check('选择题整组转发到桥', qJson.ok === true && qData.includes('"question-answer"') && qData.includes('B 方案'), JSON.stringify(qJson));

// 9. 下拉切换 + 暂停
const swRes = await fetch(`${base}/api?t=${server.token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'switch-session', sessionId: 's2' }) });
const swJson = await swRes.json();
const swData = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('switch cmd timeout')), 5000);
  const checkOnce = () => {
    if (bridgeBuf.includes('"open-session"') && bridgeBuf.includes('s2')) { clearTimeout(timer); resolve(true); }
  };
  const id = setInterval(checkOnce, 100);
  setTimeout(() => { clearInterval(id); checkOnce(); }, 4000);
});
check('switch-session 转发 open-session', swJson.ok === true && swData === true, JSON.stringify(swJson));
const swwRes = await fetch(`${base}/api?t=${server.token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'switch-workspace', workspaceId: 'w2' }) });
check('switch-workspace 转发 open-workspace', (await swwRes.json()).ok === true);
const nsRes = await fetch(`${base}/api?t=${server.token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'new-session' }) });
const nsJson = await nsRes.json();
const nsData = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('new-session cmd timeout')), 5000);
  const checkOnce = () => {
    if (bridgeBuf.includes('"new-session"')) { clearTimeout(timer); resolve(true); }
  };
  const id = setInterval(checkOnce, 100);
  setTimeout(() => { clearInterval(id); checkOnce(); }, 4000);
});
check('new-session 携带当前工作区并转发', nsJson.ok === true && nsData === true, JSON.stringify(nsJson));
const pauseRes = await fetch(`${base}/api?t=${server.token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'pause' }) });
check('pause 触发 onPause 并成功', (await pauseRes.json()).ok === true && hooks.paused[0] === 's1');

// 10. 导航：up → s2；right → w2
const navRes = await fetch(`${base}/api?t=${server.token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'nav', dir: 'up' }) });
const navJson1 = await navRes.json();
check('导航 up 选中 s2', navJson1.sessionId === 's2', JSON.stringify(navJson1));
const navRes2 = await fetch(`${base}/api?t=${server.token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'nav', dir: 'right' }) });
const navJson2 = await navRes2.json();
check('导航 right 选中 w2', navJson2.workspaceId === 'w2', JSON.stringify(navJson2));

// 11. 无桥时命令返回 no-bridge
server.bridges.clear();
const navRes3 = await fetch(`${base}/api?t=${server.token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'nav', dir: 'up' }) });
check('无桥时导航报错', (await navRes3.json()).error === 'no-bridge');

// 12. CORS：OPTIONS /bridge/state
const cors = await fetch(`${base}/bridge/state`, { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:3080', 'access-control-request-method': 'POST' } });
check('CORS 预检通过', cors.status === 204 && (cors.headers.get('access-control-allow-origin') ?? '') === '*');

// 13. 令牌注入 + 重置：构造时带固定 token；setToken 后旧令牌失效、新令牌生效
const fixedToken = 'a'.repeat(32);
const server2 = new PhoneRemoteServer(hooks, { token: fixedToken });
server2.setPage(phonePageHtml);
server2.setHost('192.168.1.99');
await server2.start([7792]);
const base2 = `http://127.0.0.1:${server2.port}`;
const info2 = await fetch(`${base2}/info`).then((r) => r.json());
check('构造注入固定令牌', info2.url.includes(`?t=${fixedToken}`));
const bad2 = await fetch(`${base2}/?t=${'b'.repeat(32)}`);
check('错误令牌被拒', bad2.status === 403);
const nextToken = 'c'.repeat(32);
server2.setToken(nextToken);
const old2 = await fetch(`${base2}/?t=${fixedToken}`);
const new2 = await fetch(`${base2}/?t=${nextToken}`);
check('重置后旧令牌失效/新令牌生效', old2.status === 403 && new2.status === 200);
// 11b. 重置断开既有 SSE 连接（phones/bridges 集合清空）
const sse3 = await fetch(`${base2}/events?t=${nextToken}`, { signal: AbortSignal.timeout(3000) });
check('重置前 SSE 可连接', sse3.status === 200);
await new Promise((r) => setTimeout(r, 200));
check('重置前 SSE 已登记', server2.phones.size > 0, `phones=${server2.phones.size}`);
server2.setToken('d'.repeat(32));
await new Promise((r) => setTimeout(r, 200));
check('重置后旧 SSE 被断开', server2.phones.size === 0, `phones=${server2.phones.size}`);
server2.close();

// 13. 非回环来源访问 /info 被拒（防令牌泄露）：用本机非回环 IPv4 直连验证
const lanAddr = Object.values(os.networkInterfaces()).flat()
  .find((n) => n.family === 'IPv4' && n.internal !== true);
if (lanAddr !== undefined && lanAddr.address !== '') {
  try {
    const lanRes = await fetch(`http://${lanAddr.address}:${server.port}/info`, { signal: AbortSignal.timeout(3000) });
    check('非回环 /info 被拒(403)', lanRes.status === 403, `addr=${lanAddr.address} status=${lanRes.status}`);
  } catch {
    console.log('SKIP 非回环 /info（LAN 地址不可达）');
  }
} else {
  console.log('SKIP 非回环 /info（本机无非回环 IPv4）');
}

server.close();
console.log(failures === 0 ? '全部通过' : `${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
