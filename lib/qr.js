// dsh-gb — 轻量 QR 编码器（byte 模式，版本 1-6，纠错 L/M/Q/H）。
// 纯 ES module，无依赖；Client bundle 构建时内联进 lib/client.js。
// 遵循 ISO/IEC 18004：数据编码、Reed-Solomon 纠错、分块交织（含长短块）、
// 功能图形、格式信息（BCH 15,5 + 0x5412 掩码）、8 种数据掩码与 4 条惩罚规则选优。
// 版本上限 6（v6-L 容量 134 字节）：v7+ 需额外绘制版本信息（18 位 BCH），
// 当前掌机 URL（含 trycloudflare 公网地址）最长约 89 字节，v5-L 即可覆盖。

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

// 版本 1-6 标准参数（与 node-qrcode / ISO 18004 一致，2026-09 核对）：
// - TOTAL_CW[i]：版本 i+1 的总码字数（数据 + 纠错）；
// - ECC_TOTAL[i]：该版本 [L, M, Q, H] 的纠错码字总数（跨全部块）；
// - BLOCKS[i]：该版本 [L, M, Q, H] 的块数。
// 块内数据码字数按规范补位：总码字 % 块数 ≠ 0 时，后若干块多 1 个数据码字（长短块）。
const TOTAL_CW = [26, 44, 70, 100, 134, 172];
const ECC_TOTAL = [
  [7, 10, 13, 17],
  [10, 16, 22, 28],
  [15, 26, 36, 44],
  [20, 36, 52, 64],
  [26, 48, 72, 88],
  [36, 64, 96, 112],
];
const BLOCKS = [
  [1, 1, 1, 1],
  [1, 1, 1, 1],
  [1, 1, 2, 2],
  [1, 2, 2, 4],
  [1, 2, 4, 4],
  [2, 4, 4, 4],
];
const EC_INDEX = { L: 0, M: 1, Q: 2, H: 3 };

// 格式信息中的纠错级别位
const EC_BITS = { L: 1, M: 0, Q: 3, H: 2 };

const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34]];

/** 版本 v + 纠错级 ec 的块划分：每项 { data, ecc }（数据码字数 / 每块纠错码字数）。 */
function blockPlan(version, ec) {
  const idx = EC_INDEX[ec];
  const total = TOTAL_CW[version - 1];
  const eccTotal = ECC_TOTAL[version - 1][idx];
  const nBlocks = BLOCKS[version - 1][idx];
  const dataTotal = total - eccTotal;
  const blocksG2 = total % nBlocks; // 长短块：后 blocksG2 块多 1 个数据码字
  const blocksG1 = nBlocks - blocksG2;
  const dataG1 = Math.floor(dataTotal / nBlocks);
  const dataG2 = dataG1 + 1;
  const eccPerBlock = Math.floor(total / nBlocks) - dataG1;
  const plan = [];
  for (let b = 0; b < nBlocks; b++) plan.push({ data: b < blocksG1 ? dataG1 : dataG2, ecc: eccPerBlock });
  return plan;
}

function byteCapacity(version, ec) {
  const idx = EC_INDEX[ec];
  const dataTotal = TOTAL_CW[version - 1] - ECC_TOTAL[version - 1][idx];
  return Math.floor((dataTotal * 8 - 12 - 4) / 8);
}

function chooseVersion(len, ec) {
  for (let v = 1; v <= 6; v++) if (byteCapacity(v, ec) >= len) return v;
  throw new Error(`QR 内容过长（${len} 字节），当前支持版本 1-6`);
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
export function encodeQr(text, ec = 'L') {
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

export function utf8BytesOf(text) {
  const enc = new TextEncoder();
  const bytes = enc.encode(text);
  return Array.from(bytes);
}

function buildBitStreamFromBytes(bytes, version, ec) {
  const plan = blockPlan(version, ec);
  const dataTotal = plan.reduce((s, b) => s + b.data, 0);
  const bits = [];
  const push = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  push(0x4, 4);
  push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  let i = bits.length;
  const capacityBits = dataTotal * 8;
  for (let t = 0; t < 4 && i < capacityBits; t++, i++) bits.push(0);
  while (i < capacityBits && (i & 7) !== 0) { bits.push(0); i++; }
  for (let pad = 0xec; i < capacityBits; pad = pad === 0xec ? 0x11 : 0xec) {
    push(pad, 8);
    i += 8;
  }
  const dataCw = new Uint8Array(dataTotal);
  for (let k = 0; k < dataTotal; k++) {
    let v = 0;
    for (let b = 0; b < 8; b++) v = (v << 1) | bits[k * 8 + b];
    dataCw[k] = v;
  }
  // 标准分块：前 G1 块短、后 G2 块长（与 node-qrcode 的 createCodewords 一致）
  const blocks = plan.map((b) => ({ data: new Uint8Array(b.data), ecc: new Uint8Array(b.ecc) }));
  let at = 0;
  for (const bl of blocks) { bl.data.set(dataCw.subarray(at, at + bl.data.length)); at += bl.data.length; }
  const eccTotal = plan.reduce((s, b) => s + b.ecc, 0);
  for (const bl of blocks) bl.ecc.set(rsEcc(bl.data, bl.ecc.length));
  // 交织：数据码字（逐块取，短块缺位跳过）→ 纠错码字（逐块取，长度一致）
  const final = new Uint8Array(dataTotal + eccTotal);
  let fi = 0;
  const maxData = plan.reduce((m, b) => Math.max(m, b.data), 0);
  for (let i = 0; i < maxData; i++) for (const bl of blocks) if (i < bl.data.length) final[fi++] = bl.data[i];
  const eccLen = plan[0].ecc;
  for (let i = 0; i < eccLen; i++) for (const bl of blocks) final[fi++] = bl.ecc[i];
  return final;
}

/** 矩阵 → 可内联的 SVG 字符串（含安静区）。 */
export function qrSvg(lines, size, scale = 4, quiet = 4) {
  const dim = (size + quiet * 2) * scale;
  let rects = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (lines[y][x]) rects += `<rect x="${(x + quiet) * scale}" y="${(y + quiet) * scale}" width="${scale}" height="${scale}"/>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim}" height="${dim}" shape-rendering="crispEdges"><rect width="${dim}" height="${dim}" fill="#fff"/>${rects}</svg>`;
}
