/**
 * MAIN 월드에서 fetch/XHR 을 감싸 자막 트랙 정보를 가로챈다.
 * 응답을 변조하지 않고 복사본만 읽는다. 발견한 정보는 postMessage 로 콘텐츠 스크립트에 넘긴다.
 */
(function () {
  'use strict';

  // 팝업에서 수동 주입할 수 있으므로 두 번 걸리지 않게 막는다.
  if (window.__dualsubHooked) return;
  window.__dualsubHooked = true;

  const CHANNEL = 'DUALSUB';
  const seenManifests = new Set();

  function send(type, payload) {
    try {
      window.postMessage({ __dualsub: CHANNEL, type, payload }, '*');

  /* ── 재생 위치 보정 ────────────────────────────────────────────────────
     디즈니+ 는 재생 위치를 옮길 때마다 MediaSource 를 다시 만들고 세그먼트를
     0 근처로 당겨 붙인다. 그래서 video.currentTime 은 "이번에 붙인 창 안의
     위치" 일 뿐 실제 재생 위치가 아니다 — 29분 지점인데 31초로 나온다.

     당길 때 쓰는 값이 SourceBuffer.timestampOffset 이다. 이 값을 알면
     실제 위치 = currentTime - timestampOffset 으로 되돌릴 수 있다.
     원래 setter 는 그대로 부르고 값만 엿본다. */
  try {
    const SB = window.SourceBuffer;
    const desc =
      SB && Object.getOwnPropertyDescriptor(SB.prototype, 'timestampOffset');
    if (desc && desc.set && desc.get) {
      Object.defineProperty(SB.prototype, 'timestampOffset', {
        configurable: true,
        enumerable: desc.enumerable,
        get: function () {
          return desc.get.call(this);
        },
        set: function (v) {
          const r = desc.set.call(this, v);
          try {
            if (typeof v === 'number' && isFinite(v) && v !== 0) {
              send('timeshift', { offset: v });
            }
          } catch (e) {
            /* 알리는 데 실패해도 재생은 계속돼야 한다. */
          }
          return r;
        }
      });
    }
  } catch (e) {
    /* 브라우저가 막으면 그냥 넘어간다. 이 보정 없이도 넷플릭스 등은 잘 된다. */
  }

    } catch (e) {
      /* 구조화 복제 불가능한 값은 무시 */
    }
  }

  /* ---------- 넷플릭스 ---------- */

  /* 넷플릭스가 2026-06 무렵 필드 이름을 바꿨다. 두 세대를 모두 받아준다.
   * timedtexttracks → textTracks, ttDownloadables → downloadables, new_track_id → id */
  const TRACK_LIST_KEYS = ['textTracks', 'timedtexttracks'];

  function trackListOf(node) {
    for (const key of TRACK_LIST_KEYS) {
      if (Array.isArray(node[key]) && node[key].length) return node[key];
    }
    return null;
  }

  /** 응답 JSON 안 어디에 있든 자막 트랙 배열을 찾아낸다. */
  function findTimedTextTracks(node, depth) {
    if (!node || typeof node !== 'object' || (depth || 0) > 6) return null;
    const direct = trackListOf(node);
    if (direct) return direct;
    for (const key of Object.keys(node)) {
      const found = findTimedTextTracks(node[key], (depth || 0) + 1);
      if (found) return found;
    }
    return null;
  }

  /** 응답 본문에 자막 목록이 들어있을 만한지 값싸게 걸러낸다. */
  function mightHaveTracks(text) {
    return text.indexOf('timedtexttracks') !== -1 || text.indexOf('textTracks') !== -1;
  }

  /** BCP-47 언어 코드 → 보기 좋은 이름. 매니페스트 NAME 이 지저분할 때 대신 쓴다. */
  const LANG_LABELS = {
    ko: '한국어', en: '영어', ja: '일본어', 'zh-hant': '중국어(번체)',
    'zh-hans': '중국어(간체)', zh: '중국어', es: '스페인어', 'es-419': '스페인어(중남미)',
    'es-es': '스페인어(스페인)', fr: '프랑스어', 'fr-ca': '프랑스어(캐나다)',
    de: '독일어', it: '이탈리아어', pt: '포르투갈어', 'pt-br': '포르투갈어(브라질)',
    ru: '러시아어', ar: '아랍어', hi: '힌디어', th: '태국어', vi: '베트남어',
    id: '인도네시아어', ms: '말레이어', tr: '터키어', pl: '폴란드어', nl: '네덜란드어',
    sv: '스웨덴어', da: '덴마크어', fi: '핀란드어', no: '노르웨이어', nb: '노르웨이어',
    cs: '체코어', hu: '헝가리어', el: '그리스어', he: '히브리어', ro: '루마니아어',
    uk: '우크라이나어', tl: '타갈로그어'
  };

  function friendlyLang(code) {
    if (!code) return null;
    const c = String(code).toLowerCase();
    return LANG_LABELS[c] || LANG_LABELS[c.split('-')[0]] || null;
  }

  /** NAME 에 --forced-- 나 [cc] 같은 표식이 박혀 있으면 지저분하니 쓰지 않는다. */
  function looksMessy(name) {
    return !name || /--|_|\[|\]|forced|sdh|cc\b/i.test(name);
  }

  /** 같은 언어라도 성격이 다르면 이름으로 구분되게 표시한다. */
  function decorateLabel(base, options) {
    let label = String(base || '자막').trim();
    if (options.closedCaptions && !/\(cc\)|\[cc\]|해설|hard.?of.?hearing|sdh/i.test(label)) {
      label += ' (CC)';
    }
    if (options.forced && !/강제|forced/i.test(label)) label += ' (강제)';
    return label;
  }

  function normalizeNetflixTracks(tracks) {
    const out = [];
    for (const track of tracks) {
      if (!track || track.isNoneTrack) continue;
      // 넷플릭스가 끼워넣는 가짜 "끄기" 트랙은 순위가 음수다.
      if (typeof track.rank === 'number' && track.rank < 0) continue;
      const downloadables = track.downloadables || track.ttDownloadables || {};
      let url = null;
      let format = null;
      for (const profile of Object.keys(downloadables)) {
        const d = downloadables[profile];
        if (!d) continue;
        // 일본어·중국어 등 일부 트랙은 글자가 아니라 이미지라 표시할 수 없다.
        if (d.isImage) continue;
        let candidate = null;
        if (d.downloadUrls) {
          const keys = Object.keys(d.downloadUrls);
          if (keys.length) candidate = d.downloadUrls[keys[0]];
        }
        if (!candidate && Array.isArray(d.urls) && d.urls.length) {
          candidate = d.urls[0].url || d.urls[0];
        }
        if (!candidate) continue;
        const isVtt = /webvtt/i.test(profile);
        // WebVTT 를 우선하되, 없으면 TTML 도 받는다.
        if (!url || (isVtt && format !== 'vtt')) {
          url = candidate;
          format = isVtt ? 'vtt' : 'ttml';
        }
      }
      if (!url) continue;
      const flags = {
        forced: !!track.isForcedNarrative,
        closedCaptions: track.rawTrackType === 'closedcaptions'
      };
      out.push({
        language: track.language || track.bcp47 || '',
        label: decorateLabel(
          track.languageDescription || track.language || track.bcp47,
          flags
        ),
        forced: flags.forced,
        closedCaptions: flags.closedCaptions,
        format,
        url
      });
    }
    return out;
  }

  function inspectNetflix(url, text) {
    if (!text || !mightHaveTracks(text)) return;
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      return;
    }
    const tracks = findTimedTextTracks(json);
    if (!tracks) return;
    const normalized = normalizeNetflixTracks(tracks);
    if (!normalized.length) return;
    const key = normalized.map((t) => t.url).join('|');
    if (seenManifests.has(key)) return;
    seenManifests.add(key);
    send('tracks', { site: 'netflix', url, tracks: normalized });
  }

  /* ---------- HLS 계열 (디즈니+ / 티빙) ---------- */

  function inspectHls(url, text) {
    if (!text || text.indexOf('#EXTM3U') === -1) return;
    if (text.indexOf('TYPE=SUBTITLES') === -1) return;
    const tracks = [];
    const re = /#EXT-X-MEDIA:([^\n\r]+)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const attrs = m[1];
      if (!/TYPE=SUBTITLES/i.test(attrs)) continue;
      const uri = /URI="([^"]+)"/i.exec(attrs);
      if (!uri) continue;
      const lang = /LANGUAGE="([^"]+)"/i.exec(attrs);
      const name = /NAME="([^"]+)"/i.exec(attrs);
      const langCode = lang ? lang[1] : '';
      const flags = {
        forced: /FORCED=YES/i.test(attrs),
        // 소리 설명(describes)만 청각장애인용(CC). 대사 전사(transcribes)는 일반 자막이다.
        closedCaptions: /CHARACTERISTICS="[^"]*describes/i.test(attrs)
      };
      // 깔끔한 언어 이름을 우선하고, NAME 이 멀쩡할 때만 그걸 쓴다.
      const rawName = name ? name[1] : '';
      const base = friendlyLang(langCode) || (looksMessy(rawName) ? langCode : rawName) || '자막';
      tracks.push({
        language: langCode,
        label: decorateLabel(base, flags),
        forced: flags.forced,
        closedCaptions: flags.closedCaptions,
        format: 'hls',
        url: new URL(uri[1], url).href
      });
    }
    if (!tracks.length) return;
    const key = tracks.map((t) => t.url).join('|');
    if (seenManifests.has(key)) return;
    seenManifests.add(key);
    send('tracks', { site: location.hostname, url, tracks });
  }

  /* ---------- 재생정보 JSON 안의 자막 목록 (티빙 · 웨이브) ----------
   * 두 서비스 모두 자막을 스트림과 분리된 단독 VTT 파일로 주고, 그 URL 을 재생정보
   * 응답에 담아 보낸다. 매니페스트를 건드릴 필요가 전혀 없다.
   *   티빙  body.stream.subtitles[] : { code, name, lang_cd, url }
   *   웨이브 streaming.subtitles[]  : { languagecode, url } */

  const LANG_NAMES = {
    ko: '한국어', en: '영어', ja: '일본어', zh: '중국어',
    es: '스페인어', fr: '프랑스어', de: '독일어', th: '태국어', vi: '베트남어'
  };

  function collectSubtitleArrays(node, depth, out) {
    if (!node || typeof node !== 'object' || depth > 8 || out.length > 6) return;
    if (Array.isArray(node.subtitles) && node.subtitles.length) out.push(node.subtitles);
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (child && typeof child === 'object') {
        collectSubtitleArrays(child, depth + 1, out);
      }
    }
  }

  function normalizeSidecarEntry(entry, baseUrl) {
    if (!entry || typeof entry !== 'object') return null;
    const raw = entry.url || entry.subtitle_url || entry.path;
    if (typeof raw !== 'string' || !raw.trim()) return null;
    if (!/\.(vtt|srt|smi|sami|ttml|dfxp)(\?|$)/i.test(raw)) return null;

    const codeRaw = String(
      entry.lang_cd || entry.languagecode || entry.language || entry.code || ''
    );
    const isCc = /_CC$|^CC$/i.test(codeRaw) || /cc/i.test(entry.subtitle_type || '');
    const code = codeRaw.replace(/_CC$/i, '').toLowerCase();
    if (code === 'none') return null;

    let resolved;
    try {
      resolved = new URL(raw, baseUrl).href;
    } catch (e) {
      return null;
    }
    const name = entry.name || LANG_NAMES[code] || code.toUpperCase() || '자막';
    // 서비스가 이미 "영어(해설)" 처럼 표기해주면 덧붙이지 않는다.
    const needsCcMark = isCc && !/해설|자막해설|CC/i.test(name);
    return {
      language: code,
      label: needsCcMark ? name + ' (해설)' : name,
      forced: false,
      closedCaptions: isCc,
      format: /\.smi|sami/i.test(raw) ? 'smi' : 'vtt',
      url: resolved
    };
  }

  function inspectSidecarSubtitles(url, text) {
    if (!text || text.indexOf('subtitles') === -1) return;
    if (text.charAt(0) !== '{' && text.charAt(0) !== '[') return;
    let json;
    try {
      json = nativeParse(text);
    } catch (e) {
      return;
    }
    const arrays = [];
    collectSubtitleArrays(json, 0, arrays);
    if (!arrays.length) return;

    const tracks = [];
    for (const arr of arrays) {
      for (const entry of arr) {
        const track = normalizeSidecarEntry(entry, url);
        if (track && !tracks.some((t) => t.url === track.url)) tracks.push(track);
      }
    }
    if (!tracks.length) return;
    const key = tracks.map((t) => t.url).join('|');
    if (seenManifests.has(key)) return;
    seenManifests.add(key);
    send('tracks', { site: location.hostname, url, tracks });
  }

  /* ---------- DASH (.mpd) — 일부 국내 OTT ---------- */

  function toArray(list) {
    const out = [];
    if (!list) return out;
    for (let i = 0; i < list.length; i++) out.push(list[i]);
    return out;
  }

  /** 직계 자식 중 해당 태그의 텍스트 (네임스페이스 접두사 허용). */
  function textOfChild(parent, tag) {
    for (const child of toArray(parent.childNodes)) {
      if (child.nodeType !== 1) continue;
      const name = child.tagName || child.nodeName || '';
      if (name === tag || name.endsWith(':' + tag)) {
        return (child.textContent || '').trim();
      }
    }
    return '';
  }

  /** 하위 Role/Accessibility 요소의 value 를 모아 본다. */
  function roleValues(set) {
    const values = [];
    for (const tag of ['Role', 'Accessibility']) {
      for (const el of toArray(set.getElementsByTagName(tag))) {
        values.push(el.getAttribute('value') || '');
      }
    }
    return values.join(' ');
  }

  function inspectDash(url, text) {
    if (!text || text.indexOf('<MPD') === -1) return;
    let doc;
    try {
      doc = new DOMParser().parseFromString(text, 'text/xml');
    } catch (e) {
      return;
    }
    if (!doc || doc.getElementsByTagName('parsererror').length) return;

    const mpd = doc.documentElement;
    const mpdBase = mpd ? textOfChild(mpd, 'BaseURL') : '';
    const tracks = [];
    const unresolved = [];

    for (const set of toArray(doc.getElementsByTagName('AdaptationSet'))) {
      const mime = set.getAttribute('mimeType') || set.getAttribute('contentType') || '';
      if (!/text|ttml|vtt|subtitle|caption/i.test(mime)) continue;

      const lang = set.getAttribute('lang') || '';
      const dashName = textOfChild(set, 'Label');
      const label = friendlyLang(lang) || (looksMessy(dashName) ? lang : dashName) || '자막';
      const roles = roleValues(set);
      const forced = /forced/i.test(roles);
      const setBase = textOfChild(set, 'BaseURL');

      // BaseURL 은 위 단계부터 차례로 이어서 해석한다(문자열 연결이 아님).
      // 절대·루트상대 URL 이 끼어도 올바르게 처리된다.
      function resolveChain(parts) {
        let base = url;
        try {
          for (const p of parts) if (p) base = new URL(p, base).href;
        } catch (e) {
          return null;
        }
        return base === url ? null : base;
      }

      let repBase = null;
      for (const rep of toArray(set.getElementsByTagName('Representation'))) {
        const b = textOfChild(rep, 'BaseURL');
        if (b) { repBase = b; break; }
      }
      // mpd 최상위 주소만 있으면 자막 파일이 아니다 — 하위 경로(세트·표현)가 있어야 한다.
      if (!setBase && !repBase) {
        unresolved.push(mime + (lang ? ' / ' + lang : ''));
        continue;
      }
      const resolved = resolveChain([mpdBase, setBase, repBase]);
      if (!resolved) {
        unresolved.push(mime + (lang ? ' / ' + lang : ''));
        continue;
      }
      const flags = {
        forced,
        closedCaptions: /descri|caption|hard.?of.?hearing/i.test(roles)
      };
      tracks.push({
        language: lang,
        label: decorateLabel(label, flags),
        forced: flags.forced,
        closedCaptions: flags.closedCaptions,
        format: /ttml/i.test(mime) ? 'ttml' : 'vtt',
        url: resolved
      });
    }

    if (unresolved.length) {
      // 세그먼트 템플릿 방식이라 URL 을 바로 못 뽑은 경우 — 진단에 남겨 원인을 알 수 있게 한다.
      send('candidate', {
        url: '[MPD 자막 트랙 있으나 URL 미해석] ' + unresolved.join(', ') + ' @ ' + url,
        contentType: 'diagnostic'
      });
    }
    if (!tracks.length) return;
    const key = tracks.map((t) => t.url).join('|');
    if (seenManifests.has(key)) return;
    seenManifests.add(key);
    send('tracks', { site: location.hostname, url, tracks });
  }

  /* ---------- 자막 파일 자체를 낚아채기 ----------
   * 매니페스트를 못 읽어도, 플레이어가 자막을 그리려면 자막 파일을 평문으로 받아야 한다.
   * 그 응답을 그대로 붙잡아 두면 사이트 구조와 무관하게 동작한다. */
  const seenSubtitleBodies = new Set();

  function subtitleFormatOf(text) {
    const head = text.slice(0, 400);
    if (/^﻿?WEBVTT/.test(head)) return 'vtt';
    if (/^﻿?\d+\s*\r?\n\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(head)) return 'srt';
    if (/<tt[\s>]/i.test(head) && /<p[\s>]/i.test(text)) return 'ttml';
    return null;
  }

  /** 문자 체계로 언어를 추정한다 — URL 에 언어 표기가 없는 경우가 많다. */
  function guessLanguage(text) {
    const s = text.slice(0, 40000);
    if (/[가-힣]/.test(s)) return { code: 'ko', label: '한국어' };
    if (/[぀-ヿ]/.test(s)) return { code: 'ja', label: '일본어' };
    if (/[一-鿿]/.test(s)) return { code: 'zh', label: '중국어' };
    if (/[Ѐ-ӿ]/.test(s)) return { code: 'ru', label: '러시아어' };
    if (/[฀-๿]/.test(s)) return { code: 'th', label: '태국어' };
    if (/[؀-ۿ]/.test(s)) return { code: 'ar', label: '아랍어' };
    if (/[À-ſ]/.test(s)) return { code: 'eu', label: '유럽어' };
    return { code: 'en', label: '영어' };
  }

  function inspectSubtitleBody(url, text) {
    if (!text || text.length < 60 || text.length > 8 * 1024 * 1024) return;
    const format = subtitleFormatOf(text);
    if (!format) return;
    // HLS 자막 세그먼트는 대사가 몇 줄뿐이다 — 조각이 아니라 완성된 파일만 트랙으로 삼는다.
    // TTML 에는 '-->' 가 없으므로 포맷별로 센다.
    const cueCount =
      format === 'ttml'
        ? (text.match(/<p[\s>]/gi) || []).length
        : (text.match(/-->/g) || []).length;
    if (cueCount < 15) return;
    if (seenSubtitleBodies.has(url)) return;
    seenSubtitleBodies.add(url);
    const lang = guessLanguage(text);
    // 매니페스트 탐색은 계속한다 — 그쪽이 잡히면 모든 언어를 고를 수 있다.
    send('subtitle', {
      url,
      format,
      language: lang.code,
      label: lang.label,
      cueCount,
      text
    });
  }

  /** 어떤 요청이 자막 후보인지 파악하기 위한 진단 로그 (팝업에서 확인). */
  function reportCandidate(url, contentType) {
    const ct = contentType || '';
    const looksLikeSubtitle =
      /\.(vtt|srt|smi|sami|ass|ssa|ttml|dfxp|xml|m3u8|mpd)(\?|$)/i.test(url) ||
      /sub|caption|cc_|smi|track|lang|text/i.test(url) ||
      /text\/vtt|ttml|dash\+xml|mpegurl|sami/i.test(ct);
    if (!looksLikeSubtitle) return;
    send('candidate', { url, contentType: ct });
  }

  let inspectedCount = 0;

  function inspect(url, text, contentType) {
    try {
      inspectedCount++;
      reportCandidate(url, contentType);
      inspectSubtitleBody(url, text);
      inspectSidecarSubtitles(url, text);
      inspectNetflix(url, text);
      inspectHls(url, text);
      inspectDash(url, text);
    } catch (e) {
      /* 후킹이 사이트 동작을 깨뜨리면 안 되므로 전부 삼킨다 */
    }
  }

  /* ---------- fetch 후킹 ---------- */

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (...args) {
      return nativeFetch.apply(this, args).then((response) => {
        try {
          const url = (response && response.url) || String(args[0] || '');
          const ct = response.headers ? response.headers.get('content-type') : '';
          const type = ct || '';
          // 영상 세그먼트는 건드리지 않는다 (대용량 복제 방지)
          if (!/video|audio|image|font/i.test(type)) {
            response
              .clone()
              .text()
              .then((text) => {
                if (text && text.length < 12 * 1024 * 1024) inspect(url, text, type);
              })
              .catch(() => {});
          }
        } catch (e) {
          /* ignore */
        }
        return response;
      });
    };
  }

  /* ---------- XHR 후킹 ---------- */

  const OpenOrig = XMLHttpRequest.prototype.open;
  const SendOrig = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__dualsubUrl = url;
    return OpenOrig.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', () => {
      try {
        const type = this.responseType;
        if (type && type !== 'text' && type !== 'json' && type !== '') return;
        const ct = this.getResponseHeader && this.getResponseHeader('content-type');
        let text = null;
        if (type === 'json') {
          text = JSON.stringify(this.response);
        } else {
          text = this.responseText;
        }
        if (text && text.length < 12 * 1024 * 1024) {
          inspect(this.__dualsubUrl || this.responseURL || '', text, ct);
        }
      } catch (e) {
        /* ignore */
      }
    });
    return SendOrig.apply(this, arguments);
  };

  /* ---------- JSON.stringify 후킹 (나가는 요청 손보기) ----------
   * 넷플릭스 매니페스트 요청은 암호화되어 나가지만, 암호화 직전에 객체를 문자열로 바꾼다.
   * 그 지점에서 자막 프로필과 "모든 언어 보여주기" 옵션을 얹는다. */
  const nativeStringify = JSON.stringify;
  const MANIFEST_REQUEST = /manifest/i;
  const WANTED_PROFILE = 'webvtt-lssdh-ios8';

  JSON.stringify = function (value) {
    try {
      if (
        value &&
        typeof value === 'object' &&
        typeof value.url === 'string' &&
        MANIFEST_REQUEST.test(value.url)
      ) {
        for (const key of Object.keys(value)) {
          const part = value[key];
          if (!part || typeof part !== 'object') continue;
          if (Array.isArray(part.profiles) && part.profiles.indexOf(WANTED_PROFILE) === -1) {
            part.profiles.unshift(WANTED_PROFILE);
          }
          // 지역·프로필 설정 때문에 숨겨지는 언어까지 목록에 담아달라고 요청한다.
          if (part.showAllSubDubTracks === false) part.showAllSubDubTracks = true;
        }
      }
    } catch (e) {
      /* 요청 변형에 실패해도 원본은 그대로 내보낸다 */
    }
    return nativeStringify.apply(this, arguments);
  };

  /* ---------- JSON.parse 후킹 ----------
   * 매니페스트는 암호화되어 오지만 페이지가 결국 복호화해 JSON.parse 로 객체를 만든다.
   * 그 지점에서 자막 목록을 그대로 읽는다. */
  const nativeParse = JSON.parse;
  JSON.parse = function (text) {
    const result = nativeParse.apply(this, arguments);
    try {
      if (
        typeof text === 'string' &&
        text.length > 200 &&
        mightHaveTracks(text)
      ) {
        const tracks = findTimedTextTracks(result);
        if (tracks) {
          const normalized = normalizeNetflixTracks(tracks);
          if (normalized.length) {
            const key = normalized.map((t) => t.url).join('|');
            if (!seenManifests.has(key)) {
              seenManifests.add(key);
              send('tracks', { site: 'netflix', url: 'JSON.parse', tracks: normalized });
            }
          }
        }
      }
    } catch (e) {
      /* 파싱 결과는 그대로 반환해야 하므로 예외는 삼킨다 */
    }
    return result;
  };

  /* ---------- Web Worker 경계 감시 ----------
   * 넷플릭스는 매니페스트를 암호화해 받은 뒤 워커에서 푼다. 워커 내부 전역은 우리가 감쌀 수
   * 없지만, 결과는 결국 메인 스레드로 postMessage 되므로 그 지점에서 잡는다. */
  // 매니페스트(전체 언어 목록)를 찾았는지 — 찾은 뒤에는 비싼 워커 스캔을 멈춘다.
  let manifestFound = false;
  let workerMessages = 0;

  function scanTransferred(data, sourceLabel) {
    if (manifestFound || data == null) return;
    let tracks = null;
    if (typeof data === 'string') {
      if (data.length < 200 || !mightHaveTracks(data)) return;
      try {
        tracks = findTimedTextTracks(nativeParse(data));
      } catch (e) {
        return;
      }
    } else if (typeof data === 'object') {
      if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return;
      if (typeof Blob !== 'undefined' && data instanceof Blob) return;
      tracks = deepFindTracks(data, 6, 4000);
    }
    if (!tracks) return;
    const normalized = normalizeNetflixTracks(tracks);
    if (!normalized.length) return;
    const key = normalized.map((t) => t.url).join('|');
    if (seenManifests.has(key)) return;
    seenManifests.add(key);
    manifestFound = true;
    send('tracks', { site: 'netflix', url: sourceLabel, tracks: normalized });
  }

  const NativeWorker = window.Worker;
  if (typeof NativeWorker === 'function') {
    const PatchedWorker = function (scriptUrl, options) {
      const instance = new NativeWorker(scriptUrl, options);
      try {
        instance.addEventListener('message', (event) => {
          try {
            workerMessages++;
            scanTransferred(event.data, 'worker');
          } catch (e) {
            /* 감시 실패가 워커 동작을 막으면 안 된다 */
          }
        });
      } catch (e) {
        /* ignore */
      }
      return instance;
    };
    PatchedWorker.prototype = NativeWorker.prototype;
    try {
      window.Worker = PatchedWorker;
    } catch (e) {
      /* ignore */
    }
  }

  /* ---------- 넷플릭스 플레이어 상태 직접 조회 ----------
   * 매니페스트가 워커 등 우리가 감싸지 못한 경로로 오면 네트워크 훅에 잡히지 않는다.
   * 플레이어는 결국 자막 목록을 자기 상태에 들고 있어야 하므로 거기서 직접 찾는다. */
  function deepFindTracks(root, maxDepth, maxNodes) {
    const depthLimit = maxDepth || 12;
    const visited = new Set();
    const queue = [{ node: root, depth: 0 }];
    let budget = maxNodes || 80000;
    while (queue.length) {
      const item = queue.shift();
      const node = item.node;
      if (!node || typeof node !== 'object' || item.depth > depthLimit) continue;
      if (visited.has(node)) continue;
      visited.add(node);
      if (--budget < 0) return null;
      const direct = trackListOf(node);
      if (direct) return direct;
      // 바이너리는 훑어봐야 소득이 없고 비싸기만 하다.
      if (node instanceof ArrayBuffer || ArrayBuffer.isView(node)) continue;
      if (typeof Map !== 'undefined' && node instanceof Map) {
        for (const v of node.values()) {
          if (v && typeof v === 'object') queue.push({ node: v, depth: item.depth + 1 });
        }
        continue;
      }
      if (typeof Set !== 'undefined' && node instanceof Set) {
        for (const v of node.values()) {
          if (v && typeof v === 'object') queue.push({ node: v, depth: item.depth + 1 });
        }
        continue;
      }
      let keys;
      try {
        keys = Object.keys(node);
      } catch (e) {
        continue;
      }
      for (const k of keys) {
        let v;
        try {
          v = node[k];
        } catch (e) {
          continue;
        }
        const isDom = typeof Node !== 'undefined' && v instanceof Node;
        if (v && typeof v === 'object' && !isDom) {
          queue.push({ node: v, depth: item.depth + 1 });
        }
      }
    }
    return null;
  }

  function pollNetflixState() {
    // 네트워크 훅이 이미 매니페스트를 잡았으면 비싼 상태 탐색은 건너뛴다.
    if (manifestFound) {
      setTimeout(pollNetflixState, 20000);
      return;
    }
    let found = false;
    try {
      const nf = window.netflix;
      const roots = [];
      if (nf && nf.appContext) roots.push(nf.appContext);
      if (nf && nf.reactContext) roots.push(nf.reactContext);
      for (const root of roots) {
        // 폴러는 예산을 줄여 배터리 부담을 던다(네트워크 훅이 주 경로).
        const tracks = deepFindTracks(root, 10, 20000);
        if (!tracks) continue;
        const normalized = normalizeNetflixTracks(tracks);
        if (!normalized.length) continue;
        found = true;
        const key = normalized.map((t) => t.url).join('|');
        if (seenManifests.has(key)) continue;
        seenManifests.add(key);
        manifestFound = true;
        send('tracks', { site: 'netflix', url: 'appContext', tracks: normalized });
      }
    } catch (e) {
      /* 페이지 상태 구조는 언제든 바뀔 수 있다 */
    }
    // 찾은 뒤에는 다음 에피소드 대비로 느슨하게만 확인한다.
    setTimeout(pollNetflixState, found ? 20000 : 3000);
  }

  if (/netflix\.com$/.test(location.hostname) || /\.netflix\.com$/.test(location.hostname)) {
    setTimeout(pollNetflixState, 2000);
  }

  /* ---------- 화면 전환 감지 ----------
   * 넷플릭스는 마우스를 올리기만 해도 다른 작품의 매니페스트를 미리 받아둔다.
   * 보고 있는 작품이 바뀌면 모아둔 자막을 비워야 엉뚱한 자막이 뜨지 않는다. */
  let lastPath = location.pathname;

  function notifyNavigation() {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    seenManifests.clear();
    seenSubtitleBodies.clear();
    manifestFound = false;
    send('navigate', { path: lastPath });
  }

  if (typeof history !== 'undefined' && history) {
    ['pushState', 'replaceState'].forEach((name) => {
      const original = history[name];
      if (typeof original !== 'function') return;
      history[name] = function () {
        const result = original.apply(this, arguments);
        try {
          notifyNavigation();
        } catch (e) {
          /* ignore */
        }
        return result;
      };
    });
  }
  window.addEventListener('popstate', () => {
    try {
      notifyNavigation();
    } catch (e) {
      /* ignore */
    }
  });

  /* 후킹이 실제로 살아있는지 팝업에서 확인할 수 있도록 상태를 알린다. */
  let lastReported = -1;
  setInterval(() => {
    if (inspectedCount === lastReported) return;
    lastReported = inspectedCount;
    send('stats', {
      inspected: inspectedCount,
      workerMessages,
      host: location.hostname
    });
  }, 1500);

  send('ready', { href: location.href });
})();
