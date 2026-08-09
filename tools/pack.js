/* 웹스토어 제출용 zip.
 *
 * 개발용 파일이 섞여 들어가면 심사에서 되돌아온다. 무엇을 담는지 한곳에 적어 둔다.
 * 압축은 zlib 만 써서 직접 쓴다 — tar 는 윈도우 경로(C:)를 원격 호스트로 읽고,
 * 압축 라이브러리를 하나 더 두면 설치 없이는 못 만드는 스크립트가 된다.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const SKIP_DIR = new Set(['.git', 'node_modules', 'test', 'docs', 'tools']);
const SKIP_FILE = new Set([
  'package.json', 'package-lock.json', 'README.md', '.gitignore', 'LICENSE'
]);

function collect(dir, out) {
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      if (!SKIP_DIR.has(name)) collect(full, out);
    } else if (!SKIP_FILE.has(name) && !name.endsWith('.zip')) {
      out.push(path.relative(ROOT, full).split(path.sep).join('/'));
    }
  }
  return out;
}

const CRC = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return (buf) => {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const rel of files) {
    const name = Buffer.from(rel, 'utf8');
    const raw = fs.readFileSync(path.join(ROOT, rel));
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const crc = CRC(raw);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // 필요한 버전
    local.writeUInt16LE(0x0800, 6); // 이름이 UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, deflated);

    const dir = Buffer.alloc(46 + name.length);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); // 만든 버전
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(deflated.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    name.copy(dir, 46);
    central.push(dir);

    offset += local.length + deflated.length;
  }

  const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dirBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, dirBuf, end]);
}

const files = collect(ROOT, []);
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const out = path.join(ROOT, `dualsub-${manifest.version}.zip`);
fs.writeFileSync(out, zip(files));

console.log(
  `${files.length}개 파일 → ${path.basename(out)} ` +
    `(${Math.round(fs.statSync(out).size / 1024)}KB)`
);
for (const f of files) console.log('  ' + f);
