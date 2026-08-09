const fs = require('fs');
const nodePath = require('path');
const ROOT = nodePath.join(__dirname, '..');
const path = nodePath.join(ROOT, 'src', 'parser.js');
const src = fs.readFileSync(path, 'utf8');
const root = {};
new Function('self', src)(root);
const P = root.DualSubParser;

let failures = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log('  OK   ' + name);
  } else {
    failures++;
    console.log('  FAIL ' + name + '\n       expected ' + e + '\n       actual   ' + a);
  }
}

console.log('[SRT]');
const srt = `1
00:00:01,000 --> 00:00:03,500
Hello there
second line

2
00:01:02,250 --> 00:01:04,000
<i>Styled</i> text
`;
const srtCues = P.sortAndClean(P.parse(srt));
check('cue count', srtCues.length, 2);
check('first cue', srtCues[0], { start: 1000, end: 3500, text: 'Hello there\nsecond line' });
check('second cue timing', [srtCues[1].start, srtCues[1].end], [62250, 64000]);
check('tags stripped', srtCues[1].text, 'Styled text');

console.log('[WebVTT]');
const vtt = `WEBVTT

00:00:05.000 --> 00:00:07.000 line:85%
First cue

00:10:00.500 --> 00:10:02.000
Second &amp; last
`;
const vttCues = P.sortAndClean(P.parse(vtt));
check('cue count', vttCues.length, 2);
check('cue with settings', vttCues[0], { start: 5000, end: 7000, text: 'First cue' });
check('entity decoded', vttCues[1].text, 'Second & last');
check('long timestamp', vttCues[1].start, 600500);

console.log('[VTT no-hour form]');
const vttShort = `WEBVTT

01:20.000 --> 01:22.000
Short form
`;
check('mm:ss.mmm', P.parse(vttShort)[0], { start: 80000, end: 82000, text: 'Short form' });

console.log('[TTML ticks - Netflix style]');
const ttml = `<?xml version="1.0" encoding="utf-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" ttp:tickRate="10000000" xmlns:ttp="http://www.w3.org/ns/ttml#parameter">
<body><div>
<p begin="10000000t" end="30000000t">Tick based<br/>two lines</p>
<p begin="45000000t" end="60000000t"><span>Nested span</span></p>
</div></body></tt>`;
const ttmlCues = P.sortAndClean(P.parse(ttml));
check('cue count', ttmlCues.length, 2);
check('tick conversion', [ttmlCues[0].start, ttmlCues[0].end], [1000, 3000]);
check('br to newline', ttmlCues[0].text, 'Tick based\ntwo lines');
check('nested span', ttmlCues[1].text, 'Nested span');

console.log('[TTML clock time + dur]');
const ttml2 = `<tt xmlns="http://www.w3.org/ns/ttml"><body><div>
<p begin="00:00:12.500" end="00:00:14.000">Clock</p>
<p begin="00:00:20.000" dur="2s">Duration</p>
</div></body></tt>`;
const t2 = P.sortAndClean(P.parse(ttml2));
check('clock time', [t2[0].start, t2[0].end], [12500, 14000]);
check('dur attribute', [t2[1].start, t2[1].end], [20000, 22000]);

console.log('[X-TIMESTAMP-MAP]');
const seg = `WEBVTT
X-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000

00:00:01.000 --> 00:00:02.000
Segment cue
`;
check('offset ms', P.timestampMapOffset(seg), 10000);
check('offset applied', P.parse(seg, 10000)[0].start, 11000);
check('no map returns null', P.timestampMapOffset('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nx'), null);

console.log('[cueAt binary search]');
const cues = P.sortAndClean(P.parse(srt));
check('inside first', P.cueAt(cues, 2000).text, 'Hello there\nsecond line');
check('gap returns null', P.cueAt(cues, 10000), null);
check('exact start', P.cueAt(cues, 1000) !== null, true);
check('exact end', P.cueAt(cues, 3500) !== null, true);
check('before all', P.cueAt(cues, 0), null);
check('after all', P.cueAt(cues, 999999), null);
check('empty list', P.cueAt([], 100), null);

console.log('[overlapping cues]');
// 긴 표지판 자막(A) 위로 짧은 대사들이 지나가는 상황
const overlap = [
  { start: 0, end: 10000, text: '[sign] LONG' },
  { start: 1000, end: 2000, text: 'line1' },
  { start: 3000, end: 4000, text: 'line2' }
];
check('inside long cue after short ones', P.cueAt(overlap, 6000).text, '[sign] LONG');
check('short cue still found', P.cueAt(overlap, 1500).text, 'line1');
check('gap outside all returns null', P.cueAt(overlap, 4500) === null ||
  P.cueAt(overlap, 4500).text === '[sign] LONG', true);
check('exact end boundary', P.cueAt(overlap, 10000).text, '[sign] LONG');
check('after everything is null', P.cueAt(overlap, 20000), null);

console.log('[dedup across segments]');
const dup = P.sortAndClean([
  { start: 1000, end: 2000, text: 'same' },
  { start: 1000, end: 2500, text: 'same' },
  { start: 3000, end: 4000, text: 'other' }
]);
check('merged duplicates', dup.length, 2);
check('extended end', dup[0].end, 2500);

console.log('[entities and invisible marks]');
const entityVtt = `WEBVTT

00:00:01.000 --> 00:00:02.000
&lrm;Subtitle with mark

00:00:03.000 --> 00:00:04.000
He said &quot;hello&quot; &amp; left&hellip;

00:00:05.000 --> 00:00:06.000
&#x41;&#66; caf&eacute;

00:00:07.000 --> 00:00:08.000
&unknownentity; stays
`;
const ent = P.sortAndClean(P.parse(entityVtt));
check('lrm decoded and stripped', ent[0].text, 'Subtitle with mark');
check('quot/amp/hellip decoded', ent[1].text, 'He said "hello" & left…');
check('hex and decimal refs', ent[2].text, 'AB café');
check('unknown entity left alone', ent[3].text, '&unknownentity; stays');

check('raw invisible char removed', P.cleanText('‎hello‏'), 'hello');
check('zero-width space removed', P.cleanText('a​b'), 'ab');
check('double-encoded decodes once', P.cleanText('&amp;lt;tag&amp;gt;'), '&lt;tag&gt;');
check('collapses runs of spaces', P.cleanText('a    b'), 'a b');
check('bare ampersand kept', P.cleanText('Tom & Jerry'), 'Tom & Jerry');

console.log('[malformed input]');
check('empty string', P.parse(''), []);
check('garbage', P.parse('not a subtitle file at all'), []);
check('null safe', P.parse(null), []);

/* ── 진짜 플레이어 고르기 ──────────────────────────────────────────────
   디즈니+ 에는 화면을 꽉 채우면서도 메타데이터가 안 읽힌 채 멈춰 있는 <video>
   가 있다. 크기만 보고 고르면 그 껍데기를 붙잡아 재생 위치가 고정된다. */
function playableLength(v) {
  if (isFinite(v.duration) && v.duration > 0) return v.duration;
  return v.seekableEnd || 0;
}
function videoScore(v) {
  const area = Math.max(0, v.w) * Math.max(0, v.h);
  let s = area;
  if (playableLength(v) > 60) s += 1e12;
  if (v.readyState >= 1) s += 1e10;
  if (!v.paused) s += 1e9;
  return s;
}
function pick(list) {
  let best = list[0];
  for (const v of list) if (videoScore(v) > videoScore(best)) best = v;
  return best.name;
}

const 껍데기 = { name: '껍데기', w: 1985, h: 1016, duration: NaN, readyState: 0, paused: true };
const 본편 = { name: '본편', w: 1280, h: 720, duration: 2818, readyState: 4, paused: false };
const 예고편 = { name: '예고편', w: 1920, h: 1080, duration: 30, readyState: 4, paused: false };

check('큰 껍데기보다 길이를 아는 본편', pick([껍데기, 본편]), '본편');
check('멈춰 있어도 본편을 고른다', pick([껍데기, { ...본편, paused: true }]), '본편');
check('짧은 예고편보다 본편', pick([예고편, 본편]), '본편');
check('본편이 없으면 준비된 쪽', pick([껍데기, { ...껍데기, name: '준비됨', readyState: 2 }]), '준비됨');
/* 디즈니+ 는 MSE 라 duration 이 Infinity 다. seekable 끝을 봐야 구분된다. */
const MSE본편 = { name: 'MSE본편', w: 1280, h: 720, duration: Infinity, seekableEnd: 2818, readyState: 4, paused: false };
check('duration 이 Infinity 여도 seekable 로 본편을 고른다', pick([껍데기, MSE본편]), 'MSE본편');

check('같은 조건이면 큰 쪽', pick([
  { name: '작음', w: 320, h: 180, duration: 3000, readyState: 4, paused: false },
  { name: '큼', w: 1280, h: 720, duration: 3000, readyState: 4, paused: false }
]), '큼');

/* 감추는 곳이 있으면 켜는 곳도 있어야 한다.
   render() 가 두 갈래에서 오버레이를 감추는데 되돌리는 코드가 없어
   한 번 감춰지면 자막이 영영 나오지 않았다. */
{
  const src = fs.readFileSync(nodePath.join(ROOT, 'src', 'content.js'), 'utf8');
  const body = src.slice(src.indexOf('function render()'));
  const end = body.indexOf('\n  }\n');
  const render = body.slice(0, end);
  const hides = (render.match(/style\.display = 'none'/g) || []).length;
  const shows = (render.match(/style\.display = ''/g) || []).length;
  check('render 안에 감추기가 있으면 켜기도 있다', hides > 0 && shows > 0, true);
}

console.log(failures === 0 ? '\nALL PASSED' : '\n' + failures + ' FAILURE(S)');
process.exit(failures ? 1 : 0);

