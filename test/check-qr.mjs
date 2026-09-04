// QR 编码器交叉验证：
// 1) 我的矩阵 vs node-qrcode 矩阵（逐模块比较，报告不一致数）
// 2) 我的矩阵渲染成 RGBA 位图 → jsqr 解码 → 必须还原原始文本（权威判定）
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const QRCode = require('qrcode');
const jsQR = require('jsqr');

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const qrSrc = readFileSync(join(root, 'lib', 'qr.js'), 'utf8');
const { encodeQr, qrSvg } = await import('data:text/javascript;base64,' + Buffer.from(qrSrc).toString('base64'));

function renderRgba(lines, size, scale = 8) {
  const quiet = 4;
  const dim = (size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4);
  for (let y = 0; y < dim; y++) {
    for (let x = 0; x < dim; x++) {
      const qx = Math.floor(x / scale) - quiet;
      const qy = Math.floor(y / scale) - quiet;
      const dark = qx >= 0 && qy >= 0 && qx < size && qy < size && lines[qy][qx];
      const v = dark ? 0 : 255;
      const at = (y * dim + x) * 4;
      data[at] = v; data[at + 1] = v; data[at + 2] = v; data[at + 3] = 255;
    }
  }
  return { data, dim };
}

const samples = [
  'https://example.com/',
  'HELLO WORLD',
  'http://192.168.1.23:7788/?t=0123456789abcdef0123456789abcdef',
  'dsh-gb-qr-check-42',
  'http://10.0.0.5:7788/?t=deadbeefcafebabe',
];

let failed = 0;
for (const text of samples) {
  const ec = text.length <= 46 ? 'M' : 'L';
  try {
    const mine = encodeQr(text, ec);
    // node-qrcode 参照矩阵
    const ref = QRCode.create(text, { errorCorrectionLevel: ec });
    const reSize = ref.modules.size;
    let diff = 0;
    if (reSize !== mine.size) {
      console.log(`[${text.slice(0, 24)}…] 尺寸不一致 mine=${mine.size}(v${mine.version}) ref=${reSize}(v${(reSize - 17) / 4})`);
      diff = -1;
    } else {
      for (let y = 0; y < reSize; y++) for (let x = 0; x < reSize; x++) {
        if ((ref.modules.get(x, y) ? 1 : 0) !== (mine.lines[y][x] ? 1 : 0)) diff++;
      }
    }
    // jsqr 解码我的渲染
    const { data, dim } = renderRgba(mine.lines, mine.size);
    const dec = jsQR(data, dim, dim);
    const ok = dec !== null && dec.data === text;
    if (!ok) failed++;
    // 对照：jsqr 解码 node-qrcode 的输出（验证解码器本身有效）
    const refData = new Uint8ClampedArray(ref.modules.size * ref.modules.size * 4);
    for (let y = 0; y < ref.modules.size; y++) {
      for (let x = 0; x < ref.modules.size; x++) {
        const v = ref.modules.get(x, y) ? 0 : 255;
        const at = (y * ref.modules.size + x) * 4;
        refData[at] = v; refData[at + 1] = v; refData[at + 2] = v; refData[at + 3] = 255;
      }
    }
    // jsqr 需要白色背景（包含安静区），直接补边
    const pad = Math.max(4, Math.floor(ref.modules.size / 2));
    const refDim = ref.modules.size + pad * 2;
    const refPadded = new Uint8ClampedArray(refDim * refDim * 4).fill(255);
    for (let y = 0; y < ref.modules.size; y++) {
      for (let x = 0; x < ref.modules.size; x++) {
        if (!ref.modules.get(x, y)) continue;
        const at = ((y + pad) * refDim + (x + pad)) * 4;
        refPadded[at] = 0; refPadded[at + 1] = 0; refPadded[at + 2] = 0;
      }
    }
    const decRef = jsQR(refPadded, refDim, refDim);
    console.log(
      `${ok ? 'PASS' : 'FAIL'} 解码="${text.slice(0, 32)}${text.length > 32 ? '…' : ''}" ` +
      `len=${text.length} v${mine.version} mask${mine.mask} 与node-qrcode差异=${diff < 0 ? 'n/a' : diff}` +
      (dec === null ? ' (jsqr无结果)' : dec.data === text ? '' : ` (解码为 "${dec.data.slice(0, 40)}")`) +
      ` | jsqr-vs-nodeqrcode=${decRef !== null && decRef.data === text ? 'PASS' : decRef === null ? '无结果' : `FAIL(${decRef.data.slice(0, 30)})`}`
    );
  } catch (e) {
    failed++;
    console.log(`ERROR [${text.slice(0, 24)}…]: ${e.message}`);
  }
}
process.exit(failed === 0 ? 0 : 1);
