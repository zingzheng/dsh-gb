// dsh-gb — 手动真机冒烟：下载真实 cloudflared 并启动一条快速隧道，
// 验证「公网 URL → 掌机页面 / SSE」全链路。需要联网（首次下载约 30-60MB，
// 缓存于 ~/.dsh/cache/dsh-gb），不进入自动测试流程。
// 用法：node test/tunnel-live.mjs   （DSH_GB_SMOKE_PORT 可换端口避免冲突）
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { PhoneRemoteServer } from '../lib/server-core.js';
import { phonePageHtml } from '../lib/phone-page.js';
import { TunnelManager } from '../lib/tunnel.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const port = Number(process.env.DSH_GB_SMOKE_PORT ?? 7799);
const cacheDir = process.env.DSH_GB_CACHE_DIR ?? join(os.homedir(), '.dsh', 'cache', 'dsh-gb');

const server = new PhoneRemoteServer({
  log: (l, m) => console.log(`[server] ${l}: ${m}`),
  onSend: async () => ({ ok: true }),
  onPause: async () => ({ ok: true }),
  getSessionMeta: () => ({ status: 'idle', summary: '' }),
  getTitles: () => ({}),
  getMessages: () => [],
});
server.setPage(phonePageHtml);
server.setHost('127.0.0.1');
await server.start([port]);
// 模拟 GUI 桥已推送基础状态（否则 /state 首帧 connected=false）
server.setBridgeState({
  sessionId: 's1',
  sessionTitle: '冒烟会话',
  workspaceId: 'w1',
  workspaceTitle: '冒烟工作区',
  sessions: [{ id: 's1', title: '冒烟会话' }],
  workspaces: [{ id: 'w1', title: '冒烟工作区' }],
});
console.log(`[smoke] 本地掌机服务器: http://127.0.0.1:${port}/?t=${server.token}`);

/** 新生成的 trycloudflare 域名在部分 DNS/网络上有解析滞后：退避重试。 */
async function fetchRetry(url, attempts = 8) {
  let lastErr = null;
  let delay = 2000;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, { signal: AbortSignal.timeout(20_000) });
    } catch (e) {
      lastErr = e;
      console.log(`[smoke] 第 ${i + 1} 次请求失败（${(e && e.cause && e.cause.message) || (e && e.message) || String(e)}），${delay}ms 后重试`);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 16_000);
    }
  }
  throw lastErr ?? new Error('fetch retry exhausted');
}

const tunnel = new TunnelManager({ log: (l, m) => console.log(`[tunnel] ${l}: ${m}`), cacheDir });
tunnel.onPhase((s) => {
  console.log(`[tunnel] phase: ${JSON.stringify(s)}`);
  server.setTunnelInfo(s);
  server.setPublicBase(s.state === 'running' && s.url ? s.url : null);
});

/** 清理后给子进程 kill 与 libuv 句柄一点收敛时间，避免退出码被断言污染。 */
async function shutdown() {
  tunnel.dispose();
  server.close();
  await new Promise((r) => setTimeout(r, 800));
}

try {
  await tunnel.start({ mode: 'quick', token: '', publicHost: '', port });
  let status = tunnel.status();
  const t0 = Date.now();
  while (Date.now() - t0 < 90_000 && (status.state === 'starting' || status.state === 'off')) {
    await new Promise((r) => setTimeout(r, 500));
    status = tunnel.status();
  }
  if (status.state !== 'running' || status.url === null || status.url === undefined) {
    throw new Error(`隧道未进入 running: ${JSON.stringify(status)}`);
  }
  console.log(`[smoke] 公网地址: ${status.url}`);

  const publicUrl = `${status.url}/?t=${server.token}`;
  const res = await fetchRetry(publicUrl);
  const html = await res.text();
  console.log(`[smoke] GET 公网页面 → ${res.status}（含“DSH 掌机”=${html.includes('DSH 掌机')}）`);
  if (res.status !== 200 || !html.includes('DSH 掌机')) throw new Error(`页面校验失败: status=${res.status}`);
  const sse = await fetchRetry(`${status.url}/events?t=${server.token}`);
  console.log(`[smoke] SSE 经隧道响应头 → ${sse.status}（注意：快速隧道可能不透传 SSE 数据体，手机页 4s 无帧会自动降级轮询）`);
  if (sse.status !== 200) throw new Error(`SSE 校验失败: status=${sse.status}`);
  // 轮询降级依赖普通 JSON 响应：验证 /state 经隧道可达且为合并状态
  const stateRes = await fetchRetry(`${status.url}/state?t=${server.token}`);
  const stateJson = await stateRes.json();
  console.log(`[smoke] /state 经隧道 → ${stateRes.status}（connected=${stateJson.connected}）`);
  if (stateRes.status !== 200 || stateJson.connected !== true) throw new Error(`/state 校验失败: status=${stateRes.status}`);

  console.log(`[smoke] 通过 ✅ 手机打开：${publicUrl}`);
  await shutdown();
  process.exit(0);
} catch (e) {
  console.error(`[smoke] 失败: ${(e && e.message) || String(e)}`);
  await shutdown();
  process.exit(1);
}
