/**
 * 生成扩展图标（16/32/48/128 PNG），纯 Node 实现，不依赖任何图形库。
 *
 * 用法：node tools/make-icons.mjs
 * 输出：src/icons/icon-<size>.png
 *
 * 设计：圆角渐变底（#6366f1 → #22d3ee），中央白色“图片+播放”符号。
 * 4 倍超采样后降采样，保证小尺寸也有抗锯齿。
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'src', 'icons');
const SIZES = [16, 32, 48, 128];
const SS = 4;

/* ---------------- 颜色与几何 ---------------- */

const C1 = [99, 102, 241];   // #6366f1
const C2 = [34, 211, 238];   // #22d3ee
const WHITE = [255, 255, 255];
const PURPLE = [79, 70, 229]; // #4f46e5

function lerp(a, b, t) {
  return a.map((v, i) => Math.round(v + (b[i] - v) * t));
}

/** 圆角矩形内部判定（坐标为 0..1 归一化） */
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** 三角形内部判定（点是否在 p1 p2 p3 内） */
function inTriangle(px, py, p1, p2, p3) {
  const sign = (ax, ay, bx, by, cx, cy) => (ax - cx) * (by - cy) - (bx - cx) * (ay - cy);
  const d1 = sign(px, py, p1[0], p1[1], p2[0], p2[1]);
  const d2 = sign(px, py, p2[0], p2[1], p3[0], p3[1]);
  const d3 = sign(px, py, p3[0], p3[1], p1[0], p1[1]);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/** 计算单点颜色（归一化坐标），返回 [r,g,b,a] */
function sample(nx, ny) {
  // 圆角渐变底
  if (!inRoundRect(nx, ny, 0.02, 0.02, 0.98, 0.98, 0.22)) return [0, 0, 0, 0];
  const t = (nx + ny) / 2;
  const bg = lerp(C1, C2, Math.min(1, Math.max(0, t)));

  // 白色图片卡片
  const plate = inRoundRect(nx, ny, 0.20, 0.22, 0.80, 0.74, 0.09);
  if (!plate) {
    // 底部小播放三角（在卡片外的右下角，白色描边），提高“视频管理”辨识度
    return [...bg, 255];
  }

  // 卡片内的太阳点
  const sunDist = (nx - 0.33) ** 2 + (ny - 0.35) ** 2;
  if (sunDist <= 0.045 ** 2) return [...PURPLE, 255];

  // 卡片内的“山”形：用两条斜线组成的实心三角
  const mountain = inTriangle(
    nx, ny,
    [0.22, 0.68], [0.40, 0.48], [0.57, 0.68],
  );
  if (mountain) return [...PURPLE, 255];

  // 右侧播放按钮（紫色圆 + 白色三角）
  const playCircle = (nx - 0.68) ** 2 + (ny - 0.58) ** 2 <= 0.105 ** 2;
  if (playCircle) {
    const tri = inTriangle(nx, ny, [0.645, 0.535], [0.645, 0.625], [0.735, 0.580]);
    return tri ? [...WHITE, 255] : [...PURPLE, 255];
  }

  return [...WHITE, 255];
}

/* ---------------- 渲染 + 降采样 ---------------- */

function render(size) {
  const big = size * SS;
  const canvas = new Float32Array(big * big * 4);

  for (let y = 0; y < big; y += 1) {
    for (let x = 0; x < big; x += 1) {
      const nx = (x + 0.5) / big;
      const ny = (y + 0.5) / big;
      const [r, g, b, a] = sample(nx, ny);
      const idx = (y * big + x) * 4;
      canvas[idx] = r;
      canvas[idx + 1] = g;
      canvas[idx + 2] = b;
      canvas[idx + 3] = a;
    }
  }

  // 盒式降采样，按 alpha 加权避免边缘发黑
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const idx = ((y * SS + sy) * big + (x * SS + sx)) * 4;
          const alpha = canvas[idx + 3] / 255;
          r += canvas[idx] * alpha;
          g += canvas[idx + 1] * alpha;
          b += canvas[idx + 2] * alpha;
          a += alpha;
        }
      }
      const o = (y * size + x) * 4;
      if (a === 0) {
        out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0;
      } else {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
        out[o + 3] = Math.round((a / (SS * SS)) * 255);
      }
    }
  }
  return out;
}

/* ---------------- PNG 编码 ---------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- 主流程 ---------------- */

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const rgba = render(size);
  const png = encodePNG(size, size, rgba);
  const file = join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(file, png);
  console.log(`✓ icon-${size}.png  ${png.length} bytes`);
}
console.log('图标生成完成：src/icons/');
