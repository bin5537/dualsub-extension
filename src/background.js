/**
 * 서비스 워커 — 자막 URL 을 대신 받아와 파싱한다.
 * 콘텐츠 스크립트에서 직접 받으면 CORS 에 막히는 경우가 많아 여기로 위임한다.
 */
importScripts('parser.js');

const P = self.DualSubParser;
const cache = new Map();

async function fetchText(url) {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' — ' + url);
  return res.text();
}

/** HLS 자막 재생목록: 세그먼트를 모두 받아 이어 붙인다. */
async function loadHlsSubtitle(playlistUrl) {
  const playlist = await fetchText(playlistUrl);
  const segments = [];
  for (const line of playlist.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    // 디즈니+ 는 본편 앞뒤로 안내 영상 조각을 끼워넣는다 — 본편(MAIN)만 남긴다.
    if (/BUMPER|DUB_CARD/i.test(t)) continue;
    segments.push(new URL(t, playlistUrl).href);
  }
  if (!segments.length) {
    // 재생목록이 아니라 자막 파일 자체였던 경우
    return P.sortAndClean(P.parse(playlist));
  }

  const LIMIT = 8;
  const texts = new Array(segments.length);
  let next = 0;
  async function worker() {
    while (next < segments.length) {
      const i = next++;
      try {
        texts[i] = await fetchText(segments[i]);
      } catch (e) {
        texts[i] = '';
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(LIMIT, segments.length) }, worker));

  // 시간축 기준은 반드시 '첫' 세그먼트로 잡는다(재생 0초에 대응).
  // 뒤 세그먼트가 먼저 기준이 되면 앞부분이 통째로 어긋난다.
  let baseline = 0;
  for (const text of texts) {
    if (!text) continue;
    const off = P.timestampMapOffset(text);
    if (off !== null) { baseline = off; break; }
  }
  const offsets = texts.map((text) => {
    if (!text) return 0;
    const off = P.timestampMapOffset(text);
    return off === null ? 0 : off - baseline;
  });

  const all = [];
  texts.forEach((text, i) => {
    if (!text) return;
    for (const cue of P.parse(text, offsets[i])) all.push(cue);
  });
  return P.sortAndClean(all);
}

async function loadTrack(track) {
  const key = track.url;
  if (cache.has(key)) return cache.get(key);

  let cues;
  if (track.format === 'hls' || /\.m3u8(\?|$)/i.test(track.url)) {
    cues = await loadHlsSubtitle(track.url);
  } else {
    cues = P.sortAndClean(P.parse(await fetchText(track.url)));
  }
  if (cache.size > 12) cache.delete(cache.keys().next().value);
  cache.set(key, cues);
  return cues;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'loadTrack') {
    loadTrack(msg.track)
      .then((cues) => sendResponse({ ok: true, cues }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }
  return false;
});
