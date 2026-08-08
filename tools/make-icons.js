/**
 * 겹자막 로고 생성기 — 외부 라이브러리 없이 PNG 를 직접 쓴다.
 * 자막 두 줄이 겹쳐 있는 모양. 16px 에서도 두 줄이 구분되도록 굵고 단순하게 그린다.
 *
 *   node tools/make-icons.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------- PNG 쓰기 ---------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
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

function writePng(file, size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]));
}

/* ---------- 그리기 ---------- */

const BG_TOP = [38, 38, 46];
const BG_BOTTOM = [12, 12, 16];
const SCREEN = [8, 8, 11];
const LINE1 = [255, 255, 255];
const LINE2 = [255, 217, 125];

/** 둥근 사각형 안에 있으면 true. 좌표는 0..1 비율. */
function inRoundRect(x, y, left, top, w, h, r) {
  const right = left + w;
  const bottom = top + h;
  if (x < left || x > right || y < top || y > bottom) return false;
  const cx = Math.min(Math.max(x, left + r), right - r);
  const cy = Math.min(Math.max(y, top + r), bottom - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** 4배 크기로 그린 뒤 줄여서 가장자리를 부드럽게 만든다. */
function render(size) {
  const SS = 4;
  const big = size * SS;
  const acc = new Float32Array(size * size * 4);

  for (let by = 0; by < big; by++) {
    for (let bx = 0; bx < big; bx++) {
      const x = (bx + 0.5) / big;
      const y = (by + 0.5) / big;

      let r = 0, g = 0, b = 0, a = 0;

      // 배경: 둥근 사각형 + 위아래 미묘한 그라데이션
      if (inRoundRect(x, y, 0.02, 0.02, 0.96, 0.96, 0.22)) {
        const t = y;
        r = BG_TOP[0] * (1 - t) + BG_BOTTOM[0] * t;
        g = BG_TOP[1] * (1 - t) + BG_BOTTOM[1] * t;
        b = BG_TOP[2] * (1 - t) + BG_BOTTOM[2] * t;
        a = 255;
      }

      // 영상 화면 — 자막이 어디에 얹히는지 한눈에 보이게 한 겹 깔아준다
      if (inRoundRect(x, y, 0.14, 0.19, 0.72, 0.62, 0.10)) {
        [r, g, b] = SCREEN;
        a = 255;
      }

      // 자막 두 줄 — 위는 넓고 흰색, 아래는 좁고 노란색(다른 언어를 뜻한다)
      if (inRoundRect(x, y, 0.20, 0.45, 0.60, 0.11, 0.055)) {
        [r, g, b] = LINE1;
        a = 255;
      }
      if (inRoundRect(x, y, 0.29, 0.62, 0.42, 0.11, 0.055)) {
        [r, g, b] = LINE2;
        a = 255;
      }

      const px = ((by / SS) | 0) * size + ((bx / SS) | 0);
      acc[px * 4] += r;
      acc[px * 4 + 1] += g;
      acc[px * 4 + 2] += b;
      acc[px * 4 + 3] += a;
    }
  }

  const n = SS * SS;
  const out = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    out[i * 4] = Math.round(acc[i * 4] / n);
    out[i * 4 + 1] = Math.round(acc[i * 4 + 1] / n);
    out[i * 4 + 2] = Math.round(acc[i * 4 + 2] / n);
    out[i * 4 + 3] = Math.round(acc[i * 4 + 3] / n);
  }
  return out;
}

/* ---------- 내보내기 ---------- */

function ensure(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

const extDir = path.join(__dirname, '..', 'icons');
ensure(extDir);
for (const size of [16, 32, 48, 128]) {
  writePng(path.join(extDir, `icon${size}.png`), size, render(size));
  console.log('확장 아이콘', size);
}

// 안드로이드 런처 아이콘 (밀도별)
const androidRes = path.join(__dirname, '..', '..', 'dualsub', 'app', 'src', 'main', 'res');
const densities = {
  'mipmap-mdpi': 48,
  'mipmap-hdpi': 72,
  'mipmap-xhdpi': 96,
  'mipmap-xxhdpi': 144,
  'mipmap-xxxhdpi': 192
};
for (const [dir, size] of Object.entries(densities)) {
  const target = path.join(androidRes, dir);
  ensure(target);
  const pixels = render(size);
  writePng(path.join(target, 'ic_launcher.png'), size, pixels);
  writePng(path.join(target, 'ic_launcher_round.png'), size, pixels);
  console.log('안드로이드 아이콘', dir, size);
}

console.log('완료');
