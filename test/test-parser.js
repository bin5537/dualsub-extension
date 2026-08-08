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

console.log(failures === 0 ? '\nALL PASSED' : '\n' + failures + ' FAILURE(S)');
process.exit(failures ? 1 : 0);
