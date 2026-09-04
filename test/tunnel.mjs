// 公网隧道管理冒烟测试：用 .mjs 桩替代真实 cloudflared（不下载、不联网、不依赖 cordis）。
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TunnelManager } from '../lib/tunnel.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const binPath = join(root, 'test', 'fake-cloudflared.mjs');

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}
async function waitFor(mgr, pred, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = mgr.status();
    if (pred(s)) return s;
    await new Promise((r) => setTimeout(r, 20));
  }
  return mgr.status();
}

const mk = (extra = {}) => {
  // 每个实例独立 spawn 计数文件：FAKE_EXIT_AT 按「本次实例的第 N 次启动」判断
  const out = join(mkdtempSync(join(tmpdir(), 'dsh-gb-tunnel-')), 'spawns.txt');
  currentOut = out;
  return new TunnelManager({
    binOverride: binPath,
    restartDelaysMs: [60, 120, 200, 400, 800],
    envExtra: { FAKE_OUT_FILE: out, ...extra },
  });
};
let currentOut = null;
const spawnLines = () => currentOut === null
  ? 0
  : readFileSync(currentOut, 'utf8').split('\n').filter((l) => l !== '').length;

// 1. 快速隧道：解析 trycloudflare 地址 → running
{
  const mgr = mk();
  const phases = [];
  mgr.onPhase((s) => phases.push(`${s.state}${s.url ? ':' + s.url : ''}`));
  await mgr.start({ mode: 'quick', token: '', publicHost: '', port: 7795 });
  const s = await waitFor(mgr, (x) => x.state === 'running');
  check('快速隧道解析出 URL 并进入 running', s.state === 'running' && /trycloudflare\.com/.test(s.url ?? ''), JSON.stringify(s));
  check('订阅回调收到过 running', phases.some((p) => p.startsWith('running')), phases.join(' | '));
  mgr.dispose();
}

// 2. 命名隧道：进入 running 且 URL = publicHost（固定域名无需解析）
{
  const mgr = mk();
  await mgr.start({ mode: 'named', token: 'n'.repeat(40), publicHost: 'https://gb.example.com', port: 7795 });
  const s = mgr.status();
  check('命名隧道 running 且 URL = publicHost', s.state === 'running' && s.url === 'https://gb.example.com', JSON.stringify(s));
  mgr.dispose();
}

// 3. 退出 → 退避重启 → 再次 running（第一次启动即退出）
{
  const mgr = mk({ FAKE_EXIT_AT: '1', FAKE_EXIT_CODE: '1' });
  await mgr.start({ mode: 'quick', token: '', publicHost: '', port: 7795 });
  const failed = await waitFor(mgr, (x) => x.state === 'failed');
  check('第一次退出进入 failed（含错误信息）', failed.state === 'failed' && (failed.error ?? '').length > 0, JSON.stringify(failed));
  const running = await waitFor(mgr, (x) => x.state === 'running', 5000);
  check('退避后重启成功（≥2 次 spawn）', running.state === 'running' && spawnLines() >= 2, `spawns=${spawnLines()} ${JSON.stringify(running)}`);
  mgr.dispose();
}

// 4. stop()：状态清空且不再 spawn、不再重启
{
  const mgr = mk();
  await mgr.start({ mode: 'quick', token: '', publicHost: '', port: 7795 });
  await waitFor(mgr, (x) => x.state === 'running');
  mgr.stop();
  const before = spawnLines();
  await new Promise((r) => setTimeout(r, 400));
  const after = spawnLines();
  const s = mgr.status();
  check('stop 后状态 off、url 清空且不再 spawn', s.state === 'off' && s.url === null && before === after, `before=${before} after=${after}`);
  mgr.dispose();
}

// 5. 平台不支持（无 binPath 也无缓存目录）→ failed 且给出原因
{
  const mgr = new TunnelManager({ binOverride: null, cacheDir: null });
  await mgr.start({ mode: 'quick', token: '', publicHost: '', port: 7795 });
  const s = mgr.status();
  check('平台不支持时进入 failed 并给出原因', s.state === 'failed' && (s.error ?? '').length > 0, JSON.stringify(s));
}

console.log(failures === 0 ? '全部通过' : `${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
