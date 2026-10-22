/**
 * 生成 fpk 所需图标：ICON.PNG(64)、ICON_256.PNG(256)、ui/images/icon_64|256.png
 * 纯 Node 实现（zlib + 自写 PNG 编码），不依赖任何图形库。
 *
 * 图形：品牌渐变圆角底 + 白色立式麦克风
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fpk');

/* ---------- PNG 编码 ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- 几何 ---------- */
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const mix = (a, b, t) => a + (b - a) * t;

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = clamp(x, x0 + r, x1 - r);
  const cy = clamp(y, y0 + r, y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function inEllipse(x, y, cx, cy, rx, ry) {
  const dx = (x - cx) / rx;
  const dy = (y - cy) / ry;
  return dx * dx + dy * dy <= 1;
}

/* ---------- 渲染 ---------- */
function render(size, ss = 4) {
  const S = size * ss;
  const acc = new Float64Array(size * size * 4);

  // 品牌渐变（对角）
  const c1 = [0xff, 0x4d, 0x6d];
  const c2 = [0xff, 0xa5, 0x36];
  const c3 = [0xc2, 0x2a, 0xa0];

  for (let Y = 0; Y < S; Y++) {
    for (let X = 0; X < S; X++) {
      const x = X / S;
      const y = Y / S;

      let r = 0, g = 0, b = 0, a = 0;

      // 背景圆角方块（留 6% 外边距，避免贴边）
      const m = 0.02;
      if (inRoundRect(x, y, m, m, 1 - m, 1 - m, 0.22)) {
        // 三段渐变：左上粉红 → 右上橙 → 右下紫
        const t1 = clamp(x * 0.65 + y * 0.35, 0, 1);
        const t2 = clamp((x - 0.45) / 0.55, 0, 1) * clamp(y, 0, 1);
        r = mix(mix(c1[0], c2[0], t1), c3[0], t2 * 0.55);
        g = mix(mix(c1[1], c2[1], t1), c3[1], t2 * 0.55);
        b = mix(mix(c1[2], c2[2], t1), c3[2], t2 * 0.55);
        a = 1;

        // 麦克风（白色）：头部网罩 + 锥形握把
        const micHead = inRoundRect(x, y, 0.395, 0.12, 0.605, 0.43, 0.105);

        // 锥形握把：宽 0.17 → 0.10，底端圆角
        let micGrip = false;
        if (y > 0.40 && y < 0.80) {
          const t = clamp((y - 0.40) / 0.40, 0, 1);
          const halfW = mix(0.085, 0.052, t) * (y > 0.76 ? Math.sqrt(Math.max(0, 1 - ((y - 0.76) / 0.04) ** 2)) : 1);
          micGrip = Math.abs(x - 0.5) < halfW;
        }

        if (micHead || micGrip) {
          // 微弱竖向渐变，避免死白
          const k = 1 - y * 0.10;
          r = 255 * k;
          g = 255 * k;
          b = 255 * k;
        }

        // 麦克风头内部三格网孔（用浅红细线体现细节）
        if (micHead) {
          const grid =
            Math.abs(y - 0.215) < 0.005 ||
            Math.abs(y - 0.27) < 0.005 ||
            Math.abs(y - 0.325) < 0.005;
          if (grid && x > 0.435 && x < 0.565) {
            r = c1[0];
            g = c1[1];
            b = c1[2];
          }
        }
      }

      // 边缘柔化：离圆角边界 1px 内按覆盖率过渡（超采样已提供抗锯齿）
      const px = Math.floor(X / ss);
      const py = Math.floor(Y / ss);
      const idx = (py * size + px) * 4;
      acc[idx] += r * a;
      acc[idx + 1] += g * a;
      acc[idx + 2] += b * a;
      acc[idx + 3] += a;
    }
  }

  const n = ss * ss;
  const out = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const alpha = acc[i * 4 + 3] / n;
    if (alpha <= 0.0001) {
      out[i * 4] = 0;
      out[i * 4 + 1] = 0;
      out[i * 4 + 2] = 0;
      out[i * 4 + 3] = 0;
      continue;
    }
    // 累加的是预乘色，还原为直通色
    const r = acc[i * 4] / n / alpha;
    const g = acc[i * 4 + 1] / n / alpha;
    const b = acc[i * 4 + 2] / n / alpha;
    out[i * 4] = clamp(Math.round(r), 0, 255);
    out[i * 4 + 1] = clamp(Math.round(g), 0, 255);
    out[i * 4 + 2] = clamp(Math.round(b), 0, 255);
    out[i * 4 + 3] = clamp(Math.round(alpha * 255), 0, 255);
  }
  return out;
}

/* ---------- 输出 ---------- */
function write(file, size) {
  const rgba = render(size, size >= 128 ? 4 : 8);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodePng(size, size, rgba));
  console.log(`  ${path.relative(ROOT, file)}  ${size}x${size}  ${(fs.statSync(file).size / 1024).toFixed(1)} KB`);
}

console.log('生成图标：');
write(path.join(ROOT, 'ICON.PNG'), 64);
write(path.join(ROOT, 'ICON_256.PNG'), 256);
write(path.join(ROOT, 'ui', 'images', 'icon_64.png'), 64);
write(path.join(ROOT, 'ui', 'images', 'icon_256.png'), 256);
console.log('完成');
