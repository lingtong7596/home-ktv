/**
 * 零依赖二维码编码器（Byte 模式，ECC L/M/Q/H，版本 1-10）
 * 用于投影仪端显示"手机扫码点歌"的二维码，不需要联网、不需要 npm 包。
 */

const TOTAL_CODEWORDS = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

// 每个版本 / 纠错等级：[每块纠错码字数, 块数]
const EC_TABLE = {
  L: [[0, 0], [7, 1], [10, 1], [15, 1], [20, 1], [26, 1], [18, 2], [20, 2], [24, 2], [30, 2], [18, 4]],
  M: [[0, 0], [10, 1], [16, 1], [26, 1], [18, 2], [24, 2], [16, 4], [18, 4], [22, 4], [22, 5], [26, 5]],
  Q: [[0, 0], [13, 1], [22, 1], [18, 2], [26, 2], [18, 4], [24, 4], [18, 6], [22, 6], [20, 8], [24, 8]],
  H: [[0, 0], [17, 1], [28, 1], [22, 2], [16, 4], [22, 4], [28, 4], [26, 5], [26, 6], [24, 8], [28, 8]],
};

const ECL_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

const ALIGNMENT = [
  [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

/* ---------------- GF(256) ---------------- */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function mul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function genPoly(n) {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecLen) {
  const gen = genPoly(ecLen);
  const buf = new Uint8Array(data.length + ecLen);
  buf.set(data);
  for (let i = 0; i < data.length; i++) {
    const coef = buf[i];
    if (coef === 0) continue;
    for (let j = 0; j < gen.length; j++) buf[i + j] ^= mul(gen[j], coef);
  }
  return buf.subarray(data.length);
}

/* ---------------- 编码 ---------------- */
function utf8Bytes(str) {
  return new TextEncoder().encode(str);
}

function pickVersion(byteLen, ecl) {
  for (let v = 1; v <= 10; v++) {
    const [ecPerBlock, blocks] = EC_TABLE[ecl][v];
    const dataCw = TOTAL_CODEWORDS[v] - ecPerBlock * blocks;
    const headerBits = 4 + (v >= 10 ? 16 : 8);
    if (dataCw * 8 >= headerBits + byteLen * 8) return v;
  }
  throw new Error('二维码内容过长（仅支持版本 1-10），请缩短链接');
}

function buildCodewords(text, version, ecl) {
  const bytes = utf8Bytes(text);
  const [ecPerBlock, blocks] = EC_TABLE[ecl][version];
  const totalData = TOTAL_CODEWORDS[version] - ecPerBlock * blocks;

  const bits = [];
  const push = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };
  push(4, 4); // byte mode
  push(bytes.length, version >= 10 ? 16 : 8);
  for (const b of bytes) push(b, 8);
  // 结束符
  const capacity = totalData * 8;
  for (let i = 0; i < 4 && bits.length < capacity; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const dataCw = new Uint8Array(totalData);
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    dataCw[i / 8] = b;
  }
  const PAD = [0xec, 0x11];
  for (let i = bits.length / 8, k = 0; i < totalData; i++, k++) dataCw[i] = PAD[k % 2];

  // 分块 + 纠错
  const numLong = totalData % blocks;
  const numShort = blocks - numLong;
  const shortLen = Math.floor(totalData / blocks);
  const dataBlocks = [];
  const ecBlocks = [];
  let off = 0;
  for (let i = 0; i < blocks; i++) {
    const len = shortLen + (i >= numShort ? 1 : 0);
    const blk = dataCw.subarray(off, off + len);
    off += len;
    dataBlocks.push(blk);
    ecBlocks.push(rsEncode(blk, ecPerBlock));
  }

  // 交织
  const out = [];
  const maxDataLen = shortLen + (numLong > 0 ? 1 : 0);
  for (let i = 0; i < maxDataLen; i++) {
    for (const blk of dataBlocks) if (i < blk.length) out.push(blk[i]);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const blk of ecBlocks) out.push(blk[i]);
  }
  return { codewords: Uint8Array.from(out), ecPerBlock, blocks, totalData };
}

/* ---------------- 矩阵 ---------------- */
const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (((r / 2) | 0) + ((c / 3) | 0)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function bchTypeNumber(version) {
  let d = version << 12;
  const bitLen = (x) => {
    let n = 0;
    while (x !== 0) { n++; x >>>= 1; }
    return n;
  };
  while (bitLen(d) - bitLen(0x1f25) >= 0) d ^= 0x1f25 << (bitLen(d) - bitLen(0x1f25));
  return (version << 12) | d;
}

function formatBits(ecl, mask) {
  const data = (ECL_FORMAT_BITS[ecl] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | (rem & 0x3ff)) ^ 0x5412;
}

function makeMatrix(version) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Uint8Array(size));
  const reserved = Array.from({ length: size }, () => new Uint8Array(size));
  const set = (r, c, v) => { modules[r][c] = v ? 1 : 0; reserved[r][c] = 1; };

  const drawFinder = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r, cc = col + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const dark =
          (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
          (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        set(rr, cc, dark);
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(size - 7, 0);
  drawFinder(0, size - 7);

  // timing
  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  // alignment
  const pos = ALIGNMENT[version];
  for (const r of pos) {
    for (const c of pos) {
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }

  // 预留格式信息区
  for (let i = 0; i < 9; i++) {
    if (!reserved[8][i]) reserved[8][i] = 1;
    if (!reserved[i][8]) reserved[i][8] = 1;
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][size - 1 - i] = 1;
    reserved[size - 1 - i][8] = 1;
  }
  reserved[size - 8][8] = 1;
  modules[size - 8][8] = 1;

  // 版本信息区（v>=7）
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      reserved[(i / 3) | 0][(i % 3) + size - 11] = 1;
      reserved[(i % 3) + size - 11][(i / 3) | 0] = 1;
    }
  }
  return { modules, reserved, size };
}

function placeData(modules, reserved, size, codewords, totalBits) {
  let bitIdx = 0;
  let dir = -1;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let i = 0; i < size; i++) {
      const row = dir === -1 ? size - 1 - i : i;
      for (let k = 0; k < 2; k++) {
        const c = col - k;
        if (reserved[row][c]) continue;
        let bit = 0;
        if (bitIdx < totalBits) bit = (codewords[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1;
        bitIdx++;
        modules[row][c] = bit;
      }
    }
    dir = -dir;
  }
}

function applyMask(modules, reserved, size, mask) {
  const fn = MASKS[mask];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!reserved[r][c] && fn(r, c)) modules[r][c] ^= 1;
    }
  }
}

function placeFormat(modules, size, ecl, mask) {
  const bits = formatBits(ecl, mask);
  const bit = (i) => ((bits >> i) & 1) === 1;
  for (let i = 0; i < 15; i++) {
    const m = bit(i);
    if (i < 6) modules[i][8] = m ? 1 : 0;
    else if (i < 8) modules[i + 1][8] = m ? 1 : 0;
    else modules[size - 15 + i][8] = m ? 1 : 0;

    if (i < 8) modules[8][size - 1 - i] = m ? 1 : 0;
    else if (i < 9) modules[8][15 - i] = m ? 1 : 0;
    else modules[8][15 - i - 1] = m ? 1 : 0;
  }
  modules[size - 8][8] = 1;
}

function placeVersion(modules, size, version) {
  if (version < 7) return;
  const bits = bchTypeNumber(version);
  for (let i = 0; i < 18; i++) {
    const m = ((bits >> i) & 1) === 1 ? 1 : 0;
    modules[(i / 3) | 0][(i % 3) + size - 11] = m;
    modules[(i % 3) + size - 11][(i / 3) | 0] = m;
  }
}

function penalty(modules, size) {
  let score = 0;
  // 规则1：同色连续 >=5
  const runScore = (line) => {
    let s = 0, run = 1;
    for (let i = 1; i < line.length; i++) {
      if (line[i] === line[i - 1]) run++;
      else { if (run >= 5) s += 3 + (run - 5); run = 1; }
    }
    if (run >= 5) s += 3 + (run - 5);
    return s;
  };
  for (let r = 0; r < size; r++) score += runScore(modules[r]);
  for (let c = 0; c < size; c++) score += runScore(modules.map((row) => row[c]));

  // 规则2：2x2 同色块
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = modules[r][c];
      if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) score += 3;
    }
  }
  // 规则3：类似定位图案
  const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const matchAt = (get, i, pat) => pat.every((p, k) => get(i + k) === p);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size - 10; c++) {
      const getRow = (i) => modules[r][i];
      const getCol = (i) => modules[i][r];
      if (matchAt(getRow, c, pat1) || matchAt(getRow, c, pat2)) score += 40;
      if (matchAt(getCol, c, pat1) || matchAt(getCol, c, pat2)) score += 40;
    }
  }
  // 规则4：黑白比例
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += modules[r][c];
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return score;
}

/**
 * 生成二维码矩阵
 * @returns {{size:number, modules:number[][], version:number}}
 */
export function qrMatrix(text, { ecl = 'M', version = 0, mask = -1 } = {}) {
  const byteLen = utf8Bytes(text).length;
  const ver = version || pickVersion(byteLen, ecl);
  const { codewords } = buildCodewords(text, ver, ecl);
  const { modules, reserved, size } = makeMatrix(ver);
  const totalBits = codewords.length * 8;
  placeData(modules, reserved, size, codewords, totalBits);

  if (mask >= 0) {
    applyMask(modules, reserved, size, mask);
    placeFormat(modules, size, ecl, mask);
    placeVersion(modules, size, ver);
    return { size, modules, version: ver };
  }

  let best = null;
  for (let m = 0; m < 8; m++) {
    const copy = modules.map((row) => Uint8Array.from(row));
    applyMask(copy, reserved, size, m);
    placeFormat(copy, size, ecl, m);
    placeVersion(copy, size, ver);
    const p = penalty(copy, size);
    if (!best || p < best.p) best = { p, m, copy };
  }
  return { size, modules: best.copy, version: ver };
}

/** 生成 SVG 字符串（投影仪端叠加显示用） */
export function qrSvg(text, { scale = 6, margin = 2, ecl = 'M', dark = '#000000', light = 'transparent' } = {}) {
  const { size, modules } = qrMatrix(text, { ecl });
  const dim = (size + margin * 2) * scale;
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim}" height="${dim}" shape-rendering="crispEdges">`);
  if (light !== 'transparent') parts.push(`<rect width="${dim}" height="${dim}" fill="${light}"/>`);
  let d = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) d += `M${(c + margin) * scale} ${(r + margin) * scale}h${scale}v${scale}h-${scale}z`;
    }
  }
  parts.push(`<path fill="${dark}" d="${d}"/>`);
  parts.push('</svg>');
  return parts.join('');
}
