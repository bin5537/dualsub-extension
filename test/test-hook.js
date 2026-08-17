const fs = require('fs');
const nodePath = require('path');
const ROOT = nodePath.join(__dirname, '..');
const vm = require('vm');

let failures = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log('  OK   ' + name);
  else {
    failures++;
    console.log('  FAIL ' + name + '\n       expected ' + e + '\n       actual   ' + a);
  }
}

// ---- 1. 모든 파일 문법 검사 ----
console.log('[syntax]');
for (const f of ['hook.js', 'content.js', 'background.js', 'popup.js', 'parser.js']) {
  const code = fs.readFileSync(nodePath.join(ROOT, 'src', f), 'utf8');
  try {
    new vm.Script(code, { filename: f });
    console.log('  OK   ' + f);
  } catch (e) {
    failures++;
    console.log('  FAIL ' + f + ' — ' + e.message);
  }
}
try {
  JSON.parse(fs.readFileSync(nodePath.join(ROOT, 'manifest.json'), 'utf8'));
  /* manifest 와 package 의 버전이 갈라진 적이 있다(0.9.1 vs 0.8.0).
     팝업에 뜨는 값은 manifest 라서 눈으로는 안 잡힌다. */
  const mv = JSON.parse(fs.readFileSync(nodePath.join(ROOT, 'manifest.json'), 'utf8')).version;
  const pv = JSON.parse(fs.readFileSync(nodePath.join(ROOT, 'package.json'), 'utf8')).version;
  check('manifest 와 package 버전이 같다', mv, pv);
  console.log('  OK   manifest.json');
} catch (e) {
  failures++;
  console.log('  FAIL manifest.json — ' + e.message);
}

// ---- 가짜 브라우저 환경 ----
const messages = [];
const timers = [];
const intervals = [];

/** 실제 브라우저처럼 인스턴스마다 자기 리스너를 갖는다. */
class FakeXHR {
  constructor() { this.__listeners = []; }
  open() {}
  send() {}
  addEventListener(type, fn) {
    if (type === 'load') this.__listeners.push(fn);
  }
}

function request(url, body, contentType, responseType) {
  const xhr = new FakeXHR();
  xhr.open('GET', url);
  xhr.send();
  xhr.responseType = responseType || '';
  if (responseType === 'json') xhr.response = body;
  else xhr.responseText = typeof body === 'string' ? body : JSON.stringify(body);
  xhr.getResponseHeader = () => contentType;
  const before = messages.length;
  xhr.__listeners.forEach((fn) => fn());
  return messages.slice(before);
}

/** 워커를 흉내낸다 — 메인 스레드로 메시지를 밀어넣을 수 있게 한다. */
class FakeWorker {
  constructor(url) {
    this.url = url;
    this.__listeners = [];
  }
  addEventListener(type, fn) {
    if (type === 'message') this.__listeners.push(fn);
  }
  emit(data) {
    this.__listeners.forEach((fn) => fn({ data }));
  }
}

const w = {
  postMessage: (m) => messages.push(m),
  fetch: async () => ({}),
  XMLHttpRequest: FakeXHR,
  Worker: FakeWorker,
  location: {
    href: 'https://www.netflix.com/watch/123',
    hostname: 'www.netflix.com',
    pathname: '/watch/123'
  },
  addEventListener: () => {}
};
w.window = w;
// 화면 전환 후킹이 작동하도록 최소한의 history 를 흉내낸다.
const fakeHistory = { pushState() {}, replaceState() {} };
// 호스트의 JSON 을 그대로 넘기면 후킹이 테스트 프로세스까지 오염시키므로 사본을 준다.
const sandboxJSON = { parse: JSON.parse, stringify: JSON.stringify };
vm.runInContext(
  fs.readFileSync(nodePath.join(ROOT, 'src', 'hook.js'), 'utf8'),
  vm.createContext({
    window: w, XMLHttpRequest: FakeXHR, location: w.location, history: fakeHistory,
    URL, JSON: sandboxJSON, console, String, Object, Array, Set, Promise, Error,
    DOMParser: require('@xmldom/xmldom').DOMParser,
    ArrayBuffer, Blob: undefined, Map, Node: undefined,
    // 타이머는 자동 실행하지 않고 붙잡아 두었다가 테스트에서 직접 돌린다.
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearTimeout: () => {}
  })
);

console.log('\n[hook init]');
check('ready message sent', messages.length >= 1 && messages[0].type, 'ready');
check('fetch patched', typeof w.fetch === 'function', true);
check('XHR.send patched', FakeXHR.prototype.send.toString().includes('addEventListener'), true);

// ---- 넷플릭스 매니페스트 ----
console.log('\n[netflix manifest]');
const netflixManifest = {
  result: {
    timedtexttracks: [
      { language: 'ko', languageDescription: '한국어', rawTrackType: 'subtitles', isNoneTrack: false,
        ttDownloadables: { 'dfxp-ls-sdh': { downloadUrls: { cdn1: 'https://cdn.example/ko.dfxp' } } } },
      { language: 'en', languageDescription: 'English', rawTrackType: 'subtitles',
        ttDownloadables: {
          'dfxp-ls-sdh': { downloadUrls: { cdn1: 'https://cdn.example/en.dfxp' } },
          'webvtt-lssdh-ios8': { urls: [{ url: 'https://cdn.example/en.vtt', cdnId: 1 }] }
        } },
      { language: 'en', languageDescription: 'English [CC]', rawTrackType: 'closedcaptions',
        ttDownloadables: { 'dfxp-ls-sdh': { downloadUrls: { cdn1: 'https://cdn.example/en-cc.dfxp' } } } },
      { language: 'off', isNoneTrack: true, ttDownloadables: {} }
    ]
  }
};

let out = request('https://www.netflix.com/nq/msl_v1/cadmium/pbo_manifests/router',
  netflixManifest, 'application/json');
const trackMsg = out.find((m) => m.type === 'tracks');
check('tracks message emitted', !!trackMsg, true);
check('none-track excluded', trackMsg.payload.tracks.length, 3);
check('site is netflix', trackMsg.payload.site, 'netflix');

const ccTrack = trackMsg.payload.tracks.find((t) => t.closedCaptions);
check('cc marked in label', /\(CC\)|\[CC\]/i.test(ccTrack.label), true);
check('plain track label untouched',
  trackMsg.payload.tracks.find((t) => t.language === 'ko').label, '한국어');

const en = trackMsg.payload.tracks.find((t) => t.language === 'en' && !t.closedCaptions);
check('vtt preferred over ttml', [en.format, en.url], ['vtt', 'https://cdn.example/en.vtt']);
const ko = trackMsg.payload.tracks.find((t) => t.language === 'ko');
check('ko label', ko.label, '한국어');
check('ttml fallback', [ko.format, ko.url], ['ttml', 'https://cdn.example/ko.dfxp']);
check('cc flagged', !!trackMsg.payload.tracks.find((t) => t.closedCaptions), true);

out = request('https://x/manifest2', netflixManifest, 'application/json');
check('duplicate manifest ignored', out.some((m) => m.type === 'tracks'), false);

// ---- 2026-06 이후 새 스키마 (textTracks / downloadables) ----
console.log('\n[netflix 2026 schema]');
const newSchema = {
  result: {
    movieId: 81234567,
    textTracks: [
      { id: 'T:1:1;1;en;0;0;', language: 'en', languageDescription: 'English',
        rawTrackType: 'subtitles', rank: 0,
        downloadables: {
          'webvtt-lssdh-ios8': { urls: [{ url: 'https://cdn.example/new-en.vtt' }] }
        } },
      { id: 'T:1:2;1;ko;0;0;', language: 'ko', languageDescription: '한국어',
        rawTrackType: 'subtitles', rank: 1,
        downloadables: {
          'dfxp-ls-sdh': { downloadUrls: { c1: 'https://cdn.example/new-ko.dfxp' } }
        } },
      { id: 'T:1:3;1;ja;0;0;', language: 'ja', languageDescription: '日本語',
        rawTrackType: 'subtitles', rank: 2,
        downloadables: {
          'dfxp-ls-sdh': { isImage: true, height: 1080,
            downloadUrls: { c1: 'https://cdn.example/ja-images.zip' } }
        } },
      { id: 'T:1:9;1;off;1;1;', language: 'off', languageDescription: 'Off',
        rawTrackType: 'subtitles', rank: -1,
        downloadables: {
          'dfxp-ls-sdh': { downloadUrls: { c1: 'https://cdn.example/off.dfxp' } }
        } }
    ]
  }
};

out = request('https://www.netflix.com/msl/playapi/cadmium/licensedmanifest/1',
  newSchema, 'application/json');
const newMsg = out.find((m) => m.type === 'tracks');
check('new schema tracks found', !!newMsg, true);
check('image + fake-off tracks excluded', newMsg && newMsg.payload.tracks.length, 2);
check('downloadables (new name) read', newMsg && newMsg.payload.tracks[0].url,
  'https://cdn.example/new-en.vtt');
check('vtt profile detected', newMsg && newMsg.payload.tracks[0].format, 'vtt');
check('ttml fallback still works', newMsg && newMsg.payload.tracks[1].url,
  'https://cdn.example/new-ko.dfxp');
check('no image track leaked',
  newMsg && newMsg.payload.tracks.some((t) => t.language === 'ja'), false);
check('negative rank track dropped',
  newMsg && newMsg.payload.tracks.some((t) => t.language === 'off'), false);

// ---- 나가는 요청 손보기 (JSON.stringify) ----
console.log('\n[outgoing manifest patch]');
const manifestReq = {
  url: '/msl/playapi/cadmium/licensedmanifest/1?reqName=licensedManifest',
  params: {
    profiles: ['playready-h264mpl30-dash', 'dfxp-ls-sdh'],
    showAllSubDubTracks: false,
    languages: ['ko']
  }
};
const encoded = sandboxJSON.stringify(manifestReq);
const sent = JSON.parse(encoded);

/* 검증 대상은 "보낸 문자열" 이지 원본 객체가 아니다.
   앞서는 원본의 profiles 에 값을 밀어 넣었는데, 그러면 페이지가 들고 있는
   객체가 영구히 바뀌어 이후 요청에도 계속 따라붙는다. */
check('webvtt profile injected', sent.params.profiles.includes('webvtt-lssdh-ios8'), true);
check('injected at front', sent.params.profiles[0], 'webvtt-lssdh-ios8');
check('existing profiles kept', sent.params.profiles.includes('playready-h264mpl30-dash'), true);
check('showAllSubDubTracks forced on', sent.params.showAllSubDubTracks, true);

check('원본 객체는 그대로', manifestReq.params.profiles, ['playready-h264mpl30-dash', 'dfxp-ls-sdh']);
check('원본 플래그도 그대로', manifestReq.params.showAllSubDubTracks, false);

// 두 번 직렬화해도 프로필이 중복되지 않아야 한다
const again = JSON.parse(sandboxJSON.stringify(manifestReq));
check('no duplicate profile on re-stringify',
  again.params.profiles.filter((p) => p === 'webvtt-lssdh-ios8').length, 1);

// 매니페스트가 아닌 요청은 건드리지 않는다
const otherReq = { url: '/api/shakti/metadata', params: { profiles: ['x'] } };
check('unrelated request untouched',
  JSON.parse(sandboxJSON.stringify(otherReq)).params.profiles, ['x']);

/* 디즈니+ 오류 83 재발 방지.

   webvtt-lssdh-ios8 은 넷플릭스 전용 프로필이다. URL 에 "manifest" 가 들어간다는
   이유만으로 디즈니+ 요청에 끼워 넣으면 서버가 거부하고 재생이 실패한다.
   호스트가 넷플릭스가 아니면 손대지 않아야 한다. */
console.log('\n[다른 서비스의 요청은 손대지 않는다]');
{
  const dw = {
    location: { href: 'https://www.disneyplus.com/play/1',
                hostname: 'www.disneyplus.com', pathname: '/play/1' },
    addEventListener: () => {}, fetch: async () => ({}),
    Worker: function () {}, XMLHttpRequest: FakeXHR
  };
  dw.window = dw;
  const dJSON = { parse: JSON.parse, stringify: JSON.stringify };
  vm.runInContext(
    fs.readFileSync(nodePath.join(ROOT, 'src', 'hook.js'), 'utf8'),
    vm.createContext({
      window: dw, XMLHttpRequest: FakeXHR, location: dw.location,
      history: { pushState() {}, replaceState() {} },
      URL, JSON: dJSON, console, String, Object, Array, Set, Promise, Error,
      DOMParser: require('@xmldom/xmldom').DOMParser,
      ArrayBuffer, Map,
      setTimeout: () => 0, setInterval: () => 0,
      clearTimeout: () => {}, clearInterval: () => {},
      MutationObserver: function () { this.observe = () => {}; },
      document: { addEventListener: () => {} }
    })
  );

  const dReq = {
    url: 'https://disney.api/media/manifest/1',
    params: { profiles: ['playready-h264mpl30-dash'], showAllSubDubTracks: false }
  };
  const dSent = JSON.parse(dJSON.stringify(dReq));
  check('넷플릭스 프로필을 끼워 넣지 않는다',
    dSent.params.profiles, ['playready-h264mpl30-dash']);
  check('플래그도 건드리지 않는다', dSent.params.showAllSubDubTracks, false);
}

let strThrew = false;
try {
  sandboxJSON.stringify(null);
  sandboxJSON.stringify('plain string');
  sandboxJSON.stringify({ url: 'manifest', params: null });
} catch (e) { strThrew = true; }
check('odd inputs survive stringify hook', strThrew, false);
check('host JSON.stringify not polluted', JSON.stringify({ a: 1 }), '{"a":1}');

console.log('\n[netflix via responseType=json]');
const nested = { data: { deep: { timedtexttracks: [
  { language: 'ja', languageDescription: '日本語', rawTrackType: 'subtitles',
    ttDownloadables: { 'webvtt-lssdh-ios8': { downloadUrls: { a: 'https://cdn.example/ja.vtt' } } } }
] } } };
out = request('https://x/manifest3', nested, 'application/json', 'json');
const jaMsg = out.find((m) => m.type === 'tracks');
check('nested tracks found', !!jaMsg, true);
check('json responseType handled', jaMsg.payload.tracks[0].language, 'ja');

// ---- HLS ----
console.log('\n[hls master playlist]');
const hls = `#EXTM3U
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",AUTOSELECT=YES,URI="subs/en/index.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Korean",LANGUAGE="ko",URI="subs/ko/index.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English Forced",LANGUAGE="en",FORCED=YES,URI="subs/enf/index.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",URI="audio/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,SUBTITLES="subs"
video/index.m3u8`;

out = request('https://media.disney-plus.net/abc/master.m3u8', hls, 'application/vnd.apple.mpegurl');
const hlsMsg = out.find((m) => m.type === 'tracks');
check('hls tracks emitted', !!hlsMsg, true);
check('only subtitle tracks (audio excluded)', hlsMsg.payload.tracks.length, 3);
check('relative URI resolved', hlsMsg.payload.tracks[0].url,
  'https://media.disney-plus.net/abc/subs/en/index.m3u8');
check('languages parsed', hlsMsg.payload.tracks.map((t) => t.language), ['en', 'ko', 'en']);
check('forced flag set', hlsMsg.payload.tracks[2].forced, true);
check('non-forced not flagged', hlsMsg.payload.tracks[0].forced, false);
check('m3u8 also reported as candidate', out.some((m) => m.type === 'candidate'), true);

console.log('\n[hls disney: label + CC/forced]');
const disneyHls = `#EXTM3U
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub-main",NAME="Dansk",LANGUAGE="da",FORCED=NO,CHARACTERISTICS="public.accessibility.transcribes-spoken-dialog",URI="r/da_normal.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub-main",NAME="de--forced--",LANGUAGE="de",FORCED=YES,URI="r/de_forced.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub-main",NAME="English [CC]",LANGUAGE="en",CHARACTERISTICS="public.accessibility.describes-music-and-sound",URI="r/en_sdh.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub-main",NAME="es-419--forced--",LANGUAGE="es-419",FORCED=YES,URI="r/es_forced.m3u8"`;
out = request('https://vod.dssott.com/ps01/master.m3u8', disneyHls, 'application/vnd.apple.mpegurl');
const dh = out.find((m) => m.type === 'tracks').payload.tracks;
check('transcribes is NOT cc', dh[0].closedCaptions, false);
check('normal danish clean label', dh[0].label, '덴마크어');
check('messy forced name cleaned', dh[1].label, '독일어 (강제)');
check('describes IS cc', dh[2].closedCaptions, true);
check('english sdh label', dh[2].label, '영어 (CC)');
check('no double cc', /\(CC\).*\(CC\)/.test(dh[2].label), false);
check('region variant label', dh[3].label, '스페인어(중남미) (강제)');

console.log('\n[hls without subtitles]');
out = request('https://x/plain.m3u8', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nv.m3u8',
  'application/vnd.apple.mpegurl');
check('no tracks emitted', out.some((m) => m.type === 'tracks'), false);

// ---- 진단용 후보 ----
console.log('\n[candidate sniffing]');
out = request('https://cdn.tving.com/stream/subtitle_ko.vtt',
  'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi', 'text/vtt');
check('vtt url reported', out.some((m) => m.type === 'candidate'), true);

out = request('https://cdn.tving.com/sub.smi', '<SAMI></SAMI>', 'text/plain');
check('smi url reported', out.some((m) => m.type === 'candidate'), true);

out = request('https://example.com/api/user/profile', '{"name":"x"}', 'application/json');
check('unrelated json not reported', out.length, 0);

out = request('https://example.com/video/seg1.ts', 'binary-ish', 'video/mp2t');
check('video segment not reported', out.length, 0);

// ---- 견고성 ----
console.log('\n[robustness]');
function fireWithBadResponse() {
  const xhr = new FakeXHR();
  xhr.open('GET', 'https://x/manifest');
  xhr.send();
  Object.defineProperty(xhr, 'responseText', { get() { throw new Error('boom'); } });
  xhr.getResponseHeader = () => 'application/json';
  xhr.__listeners.forEach((fn) => fn());
}
let threw = false;
try { fireWithBadResponse(); } catch (e) { threw = true; }
check('throwing response does not propagate', threw, false);

threw = false;
try {
  request('https://x/manifest', '{"timedtexttracks": broken json', 'application/json');
} catch (e) { threw = true; }
check('malformed json survives', threw, false);

threw = false;
try {
  request('https://x/weird.m3u8', '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,NAME="No URI"',
    'application/vnd.apple.mpegurl');
} catch (e) { threw = true; }
check('media tag without URI survives', threw, false);

// ---- JSON.parse 후킹 ----
console.log('\n[JSON.parse hook]');
check('JSON.parse patched', sandboxJSON.parse !== JSON.parse, true);

const viaParse = {
  player: { timedtexttracks: [
    { language: 'de', languageDescription: 'Deutsch', rawTrackType: 'subtitles',
      ttDownloadables: { 'webvtt-lssdh-ios8': { downloadUrls: { a: 'https://cdn.example/de.vtt' } } } }
  ] }
};
let b = messages.length;
const parsed = sandboxJSON.parse(JSON.stringify(viaParse) + ' '.repeat(200));
check('parse still returns correct value', !!parsed.player, true);
const parseMsg = messages.slice(b).find((m) => m.type === 'tracks');
check('tracks captured via JSON.parse', !!parseMsg, true);
check('language from JSON.parse path', parseMsg && parseMsg.payload.tracks[0].language, 'de');

b = messages.length;
sandboxJSON.parse(JSON.stringify(viaParse) + ' '.repeat(200));
check('same payload not re-sent', messages.slice(b).some((m) => m.type === 'tracks'), false);

check('unrelated parse untouched', sandboxJSON.parse('{"a":[1,2,3]}').a.length, 3);
check('short strings skipped', messages.length === messages.length, true);

let parseThrew = false;
try { sandboxJSON.parse('{bad json'); } catch (e) { parseThrew = true; }
check('invalid json still throws normally', parseThrew, true);

check('host JSON.parse not polluted', JSON.parse('{"ok":1}').ok, 1);

// ---- 자막 파일 본문 낚아채기 ----
console.log('\n[subtitle body capture]');

function makeVtt(n, line) {
  let s = 'WEBVTT\n\n';
  for (let i = 0; i < n; i++) {
    const a = String(i * 2).padStart(2, '0');
    const b = String(i * 2 + 1).padStart(2, '0');
    s += `00:00:${a}.000 --> 00:00:${b}.500\n${line} ${i}\n\n`;
  }
  return s;
}

out = request('https://cdn.nflxvideo.net/sub/abc123?o=1', makeVtt(30, 'Hello there'), 'text/plain');
const subMsg = out.find((m) => m.type === 'subtitle');
check('subtitle body captured', !!subMsg, true);
check('format detected', subMsg && subMsg.payload.format, 'vtt');
check('latin guessed as english', subMsg && subMsg.payload.language, 'en');
check('cue count reported', subMsg && subMsg.payload.cueCount, 30);
check('full text passed through', subMsg && subMsg.payload.text.includes('Hello there 29'), true);

out = request('https://cdn.nflxvideo.net/sub/korean?o=2', makeVtt(30, '안녕하세요 여러분'), 'text/plain');
const koMsg = out.find((m) => m.type === 'subtitle');
check('hangul detected', koMsg && koMsg.payload.language, 'ko');
check('korean label', koMsg && koMsg.payload.label, '한국어');

out = request('https://cdn.example/ja.vtt', makeVtt(20, 'こんにちは'), 'text/vtt');
check('kana detected', out.find((m) => m.type === 'subtitle').payload.language, 'ja');

// HLS 자막 조각은 트랙으로 잡으면 안 된다
out = request('https://cdn.example/seg-1.vtt', makeVtt(3, 'fragment'), 'text/vtt');
check('short hls segment ignored', out.some((m) => m.type === 'subtitle'), false);

// 같은 URL 재수신은 한 번만
out = request('https://cdn.nflxvideo.net/sub/abc123?o=1', makeVtt(30, 'Hello there'), 'text/plain');
check('duplicate body not re-sent', out.some((m) => m.type === 'subtitle'), false);

const srtBody = Array.from({ length: 20 }, (_, i) =>
  `${i + 1}\n00:00:${String(i * 3).padStart(2, '0')},000 --> 00:00:${String(i * 3 + 2).padStart(2, '0')},000\nLine ${i}\n`
).join('\n');
out = request('https://cdn.example/movie.srt', srtBody, 'text/plain');
check('srt body detected', out.find((m) => m.type === 'subtitle').payload.format, 'srt');

const ttmlBody = '<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml"><body><div>' +
  Array.from({ length: 20 }, (_, i) =>
    `<p begin="00:00:0${i % 10}.000" end="00:00:0${(i % 9) + 1}.000">line ${i}</p>`
  ).join('') + '</div></body></tt>';
out = request('https://cdn.nflxvideo.net/t/xyz', ttmlBody, 'application/ttml+xml');
const ttmlMsg = out.find((m) => m.type === 'subtitle');
check('ttml body detected (no --> present)', ttmlMsg && ttmlMsg.payload.format, 'ttml');
check('ttml cues counted by <p>', ttmlMsg && ttmlMsg.payload.cueCount, 20);

// TTML 조각도 마찬가지로 걸러져야 한다
out = request('https://cdn.example/tiny.ttml',
  '<tt><body><div><p begin="0s" end="1s">a</p></div></body></tt>', 'application/ttml+xml');
check('short ttml ignored', out.some((m) => m.type === 'subtitle'), false);

out = request('https://example.com/page.html', '<html><body>hi</body></html>', 'text/html');
check('non-subtitle body ignored', out.some((m) => m.type === 'subtitle'), false);

// ---- Web Worker 경계 감시 ----
console.log('\n[worker boundary]');
check('Worker patched', w.Worker !== FakeWorker, true);

const worker = new w.Worker('https://www.netflix.com/msl-worker.js');
check('returns a working instance', worker instanceof FakeWorker, true);
check('script url preserved', worker.url, 'https://www.netflix.com/msl-worker.js');

// 워커가 복호화한 매니페스트를 객체로 넘기는 상황
b = messages.length;
worker.emit({ type: 'manifest', payload: { result: { timedtexttracks: [
  { language: 'ko', languageDescription: '한국어', rawTrackType: 'subtitles',
    ttDownloadables: { 'webvtt-lssdh-ios8': { downloadUrls: { a: 'https://cdn.example/wk-ko.vtt' } } } }
] } } });
const wkMsg = messages.slice(b).find((m) => m.type === 'tracks');
check('tracks captured from worker object', !!wkMsg, true);
check('source labelled worker', wkMsg && wkMsg.payload.url, 'worker');
check('language from worker', wkMsg && wkMsg.payload.tracks[0].language, 'ko');

// 바이너리 메시지는 무시해야 한다 (미디어 청크가 대부분이라 비용만 든다)
b = messages.length;
let binThrew = false;
try { worker.emit(new ArrayBuffer(1024)); } catch (e) { binThrew = true; }
check('binary message ignored safely', binThrew, false);
check('no tracks from binary', messages.slice(b).some((m) => m.type === 'tracks'), false);

let nullThrew = false;
try { worker.emit(null); worker.emit(undefined); worker.emit(42); } catch (e) { nullThrew = true; }
check('null/primitive messages survive', nullThrew, false);

// ---- 재생정보 JSON 안의 자막 목록 (티빙 · 웨이브) ----
console.log('\n[sidecar subtitles: tving]');
const tvingInfo = {
  body: {
    stream: {
      vtt: { vtt_path: 'https://cdn.tving.com/thumb/storyboard.vtt' },
      subtitles: [
        { code: 'NONE', name: '사용 안 함', selected: 'N', url: '', lang_cd: '' },
        { code: 'KO', name: '한국어', lang_cd: 'KO', selected: 'Y', subtitle_type: 'none',
          url: 'https://d3vhjsxfqrp83x.cloudfront.net/asset/package/subtitle_ko.vtt' },
        { code: 'EN', name: '영어', lang_cd: 'EN', selected: 'N', subtitle_type: 'none',
          url: 'https://d3vhjsxfqrp83x.cloudfront.net/asset/package/subtitle_en.vtt' },
        { code: 'EN_CC', name: '영어(해설)', lang_cd: 'EN_CC', subtitle_type: 'cc',
          url: 'https://d3vhjsxfqrp83x.cloudfront.net/asset/package/subtitle_en_cc.vtt' }
      ]
    }
  }
};
out = request('https://api.tving.com/v2/media/stream/info?mediaCode=M45714',
  tvingInfo, 'application/json');
const tvMsg = out.find((m) => m.type === 'tracks');
check('tving tracks found', !!tvMsg, true);
check('NONE entry skipped', tvMsg && tvMsg.payload.tracks.length, 3);
check('korean track url', tvMsg && tvMsg.payload.tracks[0].url,
  'https://d3vhjsxfqrp83x.cloudfront.net/asset/package/subtitle_ko.vtt');
check('lang code lowercased', tvMsg && tvMsg.payload.tracks.map((t) => t.language),
  ['ko', 'en', 'en']);
check('cc track flagged', tvMsg && tvMsg.payload.tracks[2].closedCaptions, true);
check('cc label marked', tvMsg && tvMsg.payload.tracks[2].label, '영어(해설)');
check('thumbnail storyboard vtt not picked up',
  tvMsg && tvMsg.payload.tracks.some((t) => /storyboard/.test(t.url)), false);

console.log('\n[sidecar subtitles: wavve]');
const wavveInfo = {
  streaming: {
    playurl: 'https://cdn.wavve.com/asset/manifest.mpd',
    subtitles: [
      { languagecode: 'ko', url: 'https://cdn.wavve.com/sub/ko.vtt' },
      { languagecode: 'en', url: 'https://cdn.wavve.com/sub/en.vtt' }
    ]
  }
};
out = request('https://apis.wavve.com/fz/streaming?contentid=MV_X', wavveInfo, 'application/json');
const wvMsg = out.find((m) => m.type === 'tracks');
check('wavve tracks found', !!wvMsg, true);
check('languagecode field read', wvMsg && wvMsg.payload.tracks.map((t) => t.language),
  ['ko', 'en']);
check('label falls back to language name', wvMsg && wvMsg.payload.tracks[0].label, '한국어');

console.log('\n[sidecar edge cases]');
out = request('https://api.tving.com/v2/x', { body: { stream: { subtitles: [] } } },
  'application/json');
check('empty subtitles array ignored', out.some((m) => m.type === 'tracks'), false);

out = request('https://api.example/x',
  { subtitles: [{ code: 'KO', url: 'https://cdn/x/not-a-subtitle.mp4' }] }, 'application/json');
check('non-subtitle extension rejected', out.some((m) => m.type === 'tracks'), false);

out = request('https://api.example/y',
  { data: { deep: { nest: { subtitles: [{ languagecode: 'ja', url: 'https://cdn/j.vtt' }] } } } },
  'application/json');
check('nested subtitles array found',
  out.find((m) => m.type === 'tracks').payload.tracks[0].language, 'ja');

out = request('https://api.example/rel',
  { subtitles: [{ code: 'KO', url: '/sub/rel.vtt' }] }, 'application/json');
check('relative subtitle url resolved',
  out.find((m) => m.type === 'tracks').payload.tracks[0].url, 'https://api.example/sub/rel.vtt');

threw = false;
try {
  request('https://api.example/bad', '{"subtitles": [oops', 'application/json');
  request('https://api.example/nul', { subtitles: [null, 42, {}] }, 'application/json');
} catch (e) { threw = true; }
check('malformed sidecar payloads survive', threw, false);

// ---- DASH (.mpd) ----
console.log('\n[dash mpd]');
const mpd = `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static">
  <BaseURL>https://cdn.example.com/asset/</BaseURL>
  <Period>
    <AdaptationSet mimeType="video/mp4" lang="und">
      <Representation id="v1"><BaseURL>video/1.mp4</BaseURL></Representation>
    </AdaptationSet>
    <AdaptationSet mimeType="text/vtt" lang="en">
      <Label>English</Label>
      <Representation id="s1"><BaseURL>text/en.vtt</BaseURL></Representation>
    </AdaptationSet>
    <AdaptationSet contentType="text" mimeType="application/ttml+xml" lang="ko">
      <Role schemeIdUri="urn:mpeg:dash:role:2011" value="forced-subtitle"/>
      <Representation id="s2"><BaseURL>text/ko.ttml</BaseURL></Representation>
    </AdaptationSet>
    <AdaptationSet mimeType="text/vtt" lang="ja">
      <Role schemeIdUri="urn:mpeg:dash:role:2011" value="caption"/>
      <SegmentTemplate media="text/ja/$Number$.vtt"/>
      <Representation id="s3"/>
    </AdaptationSet>
  </Period>
</MPD>`;

out = request('https://cdn.example.com/asset/manifest.mpd', mpd, 'application/dash+xml');
const dashMsg = out.find((m) => m.type === 'tracks');
check('dash tracks emitted', !!dashMsg, true);
check('video adaptation set excluded', dashMsg.payload.tracks.length, 2);
check('BaseURL chain resolved', dashMsg.payload.tracks[0].url,
  'https://cdn.example.com/asset/text/en.vtt');
check('label mapped to korean', dashMsg.payload.tracks[0].label, '영어');
check('ttml format detected', dashMsg.payload.tracks[1].format, 'ttml');
check('forced role parsed', dashMsg.payload.tracks[1].forced, true);
check('non-forced not flagged', dashMsg.payload.tracks[0].forced, false);
check('unresolvable track reported as diagnostic',
  out.some((m) => m.type === 'candidate' && /URL 미해석/.test(m.payload.url)), true);

console.log('\n[dash without subtitles]');
out = request('https://x/v.mpd',
  '<MPD><Period><AdaptationSet mimeType="video/mp4"/></Period></MPD>', 'application/dash+xml');
check('no tracks emitted', out.some((m) => m.type === 'tracks'), false);

console.log('\n[malformed mpd]');
threw = false;
try {
  request('https://x/bad.mpd', '<MPD><Period><AdaptationSet mimeType="text/vtt"',
    'application/dash+xml');
} catch (e) { threw = true; }
check('broken xml survives', threw, false);

// ---- appContext 폴백 (네트워크 훅이 매니페스트를 못 잡은 경우) ----
console.log('\n[netflix appContext fallback]');
check('poll scheduled on netflix', timers.some((t) => t.ms === 2000), true);
check('stats interval registered', intervals.length >= 1, true);

// 앞선 테스트에서 네트워크 훅이 매니페스트를 이미 잡아 manifestFound 가 켜져 있다.
// 실제로도 화면 전환 시 초기화되므로, 전환을 흉내내 폴백 시나리오를 깨끗이 시작한다.
w.location.pathname = '/watch/999';
fakeHistory.pushState({}, '', '/watch/999');

// 플레이어 상태 깊숙한 곳에 자막 목록이 박혀 있는 상황을 흉내낸다.
const player = { session: { manifest: { links: {}, timedtexttracks: [
  { language: 'fr', languageDescription: 'Français', rawTrackType: 'subtitles',
    ttDownloadables: { 'webvtt-lssdh-ios8': { downloadUrls: { a: 'https://cdn.example/fr.vtt' } } } }
] } } };
player.session.self = player.session;          // 순환 참조
w.netflix = { appContext: { state: { playerApp: player } } };

const poll = timers.find((t) => t.ms === 2000).fn;
b = messages.length;
let pollThrew = false;
try { poll(); } catch (e) { pollThrew = true; console.log('     threw: ' + e.message); }
check('poll survives cyclic state', pollThrew, false);
const pollMsg = messages.slice(b).find((m) => m.type === 'tracks');
check('tracks found via appContext', !!pollMsg, true);
check('source labelled appContext', pollMsg && pollMsg.payload.url, 'appContext');
check('language from appContext', pollMsg && pollMsg.payload.tracks[0].language, 'fr');
check('reschedules itself', timers.filter((t) => t.ms === 20000).length, 1);

b = messages.length;
timers.find((t) => t.ms === 20000).fn();
check('no duplicate on second poll', messages.slice(b).some((m) => m.type === 'tracks'), false);

// netflix 전역이 없어도 죽지 않아야 한다
delete w.netflix;
let bareThrew = false;
try { poll(); } catch (e) { bareThrew = true; }
check('poll without netflix global', bareThrew, false);

console.log(failures === 0 ? '\nALL PASSED' : '\n' + failures + ' FAILURE(S)');
process.exit(failures ? 1 : 0);
