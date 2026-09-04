// dsh-gb — 测试桩：模拟 cloudflared 的输出与退出行为（由 test/tunnel.mjs 注入）。
// 环境变量：FAKE_MODE=quick|named；FAKE_OUT_FILE：每次启动追加一行 'spawn'（供计数）；
// FAKE_EXIT_AT：启动次数 <= 该值则立即退出（配合 FAKE_EXIT_CODE）。
import fs from 'node:fs';

const outFile = process.env.FAKE_OUT_FILE ?? '';
const mode = process.env.FAKE_MODE ?? 'quick';

if (outFile !== '') fs.appendFileSync(outFile, 'spawn\n');

const spawnCount = outFile !== ''
  ? fs.readFileSync(outFile, 'utf8').split('\n').filter((l) => l !== '').length
  : 1;

if (mode === 'quick') {
  process.stdout.write('INFO Trying to establish a tunnel...\n');
  process.stdout.write('https://abc-def-ghi.trycloudflare.com\n');
  process.stdout.write('Registered tunnel connection\n');
}

const exitAt = Number(process.env.FAKE_EXIT_AT ?? '-1');
if (exitAt >= 0 && spawnCount <= exitAt) {
  process.exit(Number(process.env.FAKE_EXIT_CODE ?? '1'));
}

setInterval(() => {}, 1000);
