/**
 * 자막 파싱 — WebVTT / SRT / TTML(dfxp) → Cue 배열.
 * 콘텐츠 스크립트와 서비스 워커 양쪽에서 쓰이므로 globalThis 에 붙인다.
 */
(function (root) {
  'use strict';

  const TIME_LINE = /(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[,.](\d{1,3})\s*-->\s*(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/;
  const TAG = /<[^>]+>/g;

  function hmsToMs(h, m, s, frac) {
    const hh = h ? parseInt(h, 10) : 0;
    return (
      hh * 3600000 +
      parseInt(m, 10) * 60000 +
      parseInt(s, 10) * 1000 +
      parseInt(String(frac).padEnd(3, '0').slice(0, 3), 10)
    );
  }

  const ENTITIES = {
    nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
    // 방향·결합 표시용 보이지 않는 문자. 해석하지 않으면 &lrm; 처럼 글자로 남고,
    // 해석해도 어차피 화면에 보이면 안 되는 것들이라 빈 문자열로 없앤다.
    lrm: '', rlm: '', zwj: '', zwnj: '', shy: '', zwsp: '',
    hellip: '…', mdash: '—', ndash: '–', minus: '−',
    ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
    laquo: '«', raquo: '»', bull: '•', middot: '·',
    deg: '°', times: '×', divide: '÷', copy: '©', reg: '®', trade: '™',
    eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', uuml: 'ü',
    ouml: 'ö', auml: 'ä', ntilde: 'ñ', szlig: 'ß'
  };

  /* 화면에 네모로 보이거나 줄 정렬을 망치는 보이지 않는 서식 문자 */
  const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

  function safeChar(code) {
    if (!isFinite(code) || code < 0 || code > 0x10ffff) return '';
    try {
      return String.fromCodePoint(code);
    } catch (e) {
      return '';
    }
  }

  function decodeEntities(s) {
    return s
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeChar(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => safeChar(parseInt(dec, 10)))
      .replace(/&([a-z][a-z0-9]*);/gi, (whole, name) => {
        const key = name.toLowerCase();
        return Object.prototype.hasOwnProperty.call(ENTITIES, key)
          ? ENTITIES[key]
          : whole;
      });
  }

  function cleanText(s) {
    return decodeEntities(String(s).replace(TAG, ''))
      .replace(INVISIBLE, '')
      .replace(/[ \t]+/g, ' ')
      .trim();
  }

  /** WebVTT / SRT 공통 파서. timestampMap 은 HLS 세그먼트 보정용 오프셋(ms). */
  function parseVtt(raw, offsetMs) {
    const shift = offsetMs || 0;
    const lines = raw.replace(/\r\n?/g, '\n').split('\n');
    const cues = [];
    for (let i = 0; i < lines.length; i++) {
      const m = TIME_LINE.exec(lines[i]);
      if (!m) continue;
      const start = hmsToMs(m[1], m[2], m[3], m[4]) + shift;
      const end = hmsToMs(m[5], m[6], m[7], m[8]) + shift;
      const buf = [];
      i++;
      while (i < lines.length && lines[i].trim() !== '' && !TIME_LINE.test(lines[i])) {
        const t = cleanText(lines[i]);
        if (t) buf.push(t);
        i++;
      }
      i--;
      if (buf.length) cues.push({ start, end, text: buf.join('\n') });
    }
    return cues;
  }

  /** VTT 세그먼트 헤더의 X-TIMESTAMP-MAP 에서 (MPEGTS - LOCAL) 오프셋(ms)을 뽑는다. */
  function timestampMapOffset(raw) {
    const m = /X-TIMESTAMP-MAP\s*[=:]\s*(.+)/i.exec(raw);
    if (!m) return null;
    const mpegts = /MPEGTS:\s*(\d+)/i.exec(m[1]);
    const local = /LOCAL:\s*(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/i.exec(m[1]);
    if (!mpegts) return null;
    const mpegMs = (parseInt(mpegts[1], 10) / 90000) * 1000;
    const localMs = local ? hmsToMs(local[1], local[2], local[3], local[4]) : 0;
    return mpegMs - localMs;
  }

  /** TTML/DFXP — 넷플릭스는 tick 단위(기본 tickRate 10000000)를 쓴다. */
  function parseTtml(raw) {
    const tickRateMatch = /ttp:tickRate\s*=\s*"(\d+)"/.exec(raw);
    const tickRate = tickRateMatch ? parseInt(tickRateMatch[1], 10) : 10000000;
    const frameRateMatch = /ttp:frameRate\s*=\s*"(\d+)"/.exec(raw);
    const frameRate = frameRateMatch ? parseInt(frameRateMatch[1], 10) : 24;

    function toMs(v) {
      if (!v) return null;
      let m = /^(\d+(?:\.\d+)?)t$/.exec(v);
      if (m) return (parseFloat(m[1]) / tickRate) * 1000;
      m = /^(\d+(?:\.\d+)?)ms$/.exec(v);
      if (m) return parseFloat(m[1]);
      m = /^(\d+(?:\.\d+)?)s$/.exec(v);
      if (m) return parseFloat(m[1]) * 1000;
      m = /^(\d+):(\d{2}):(\d{2})[.,](\d{1,3})$/.exec(v);
      if (m) return hmsToMs(m[1], m[2], m[3], m[4]);
      m = /^(\d+):(\d{2}):(\d{2}):(\d{1,3})$/.exec(v);
      if (m) {
        return (
          hmsToMs(m[1], m[2], m[3], '000') +
          (parseInt(m[4], 10) / frameRate) * 1000
        );
      }
      m = /^(\d+):(\d{2}):(\d{2})$/.exec(v);
      if (m) return hmsToMs(m[1], m[2], m[3], '000');
      return null;
    }

    const cues = [];
    const pRe = /<(?:tt:)?p\b([^>]*)>([\s\S]*?)<\/(?:tt:)?p>/g;
    let match;
    while ((match = pRe.exec(raw)) !== null) {
      const attrs = match[1];
      const begin = /\bbegin\s*=\s*"([^"]+)"/.exec(attrs);
      const end = /\bend\s*=\s*"([^"]+)"/.exec(attrs);
      const dur = /\bdur\s*=\s*"([^"]+)"/.exec(attrs);
      const start = begin ? toMs(begin[1]) : null;
      if (start === null) continue;
      let stop = end ? toMs(end[1]) : null;
      if (stop === null && dur) {
        const d = toMs(dur[1]);
        if (d !== null) stop = start + d;
      }
      if (stop === null) stop = start + 3000;
      const text = cleanText(match[2].replace(/<(?:tt:)?br\s*\/?>/gi, '\n'))
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .join('\n');
      if (text) cues.push({ start: Math.round(start), end: Math.round(stop), text });
    }
    return cues;
  }

  /** 포맷 자동 판별. */
  function parse(raw, offsetMs) {
    if (!raw) return [];
    const head = raw.slice(0, 2000);
    if (/<tt\b|<\?xml|xmlns.*ttml/i.test(head)) return parseTtml(raw);
    return parseVtt(raw, offsetMs);
  }

  function sortAndClean(cues) {
    const out = cues
      .filter((c) => c.text && c.end > c.start)
      .sort((a, b) => a.start - b.start);
    // 동일 시작·동일 텍스트 중복 제거 (HLS 세그먼트 경계에서 흔함)
    const dedup = [];
    for (const c of out) {
      const prev = dedup[dedup.length - 1];
      if (prev && prev.start === c.start && prev.text === c.text) {
        prev.end = Math.max(prev.end, c.end);
        continue;
      }
      dedup.push(c);
    }
    return dedup;
  }

  /**
   * 현재 시각의 자막을 찾는다.
   * 시작 시각 기준 이진 탐색으로 timeMs 이하의 마지막 대사를 찾은 뒤, 겹치는 대사를
   * 대비해 그 앞쪽을 조금 훑는다(긴 표지판 자막이 짧은 대사와 겹칠 때 사라지지 않게).
   */
  function cueAt(cues, timeMs) {
    if (!cues || !cues.length) return null;
    let lo = 0;
    let hi = cues.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= timeMs) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    // idx 부터 왼쪽으로 조금만 훑는다. 겹치는 대사는 몇 개 안 되므로 한계를 둔다.
    const limit = Math.max(0, idx - 60);
    for (let i = idx; i >= limit; i--) {
      if (cues[i].end >= timeMs) return cues[i];
    }
    return null;
  }

  root.DualSubParser = {
    parse,
    parseVtt,
    parseTtml,
    timestampMapOffset,
    sortAndClean,
    cueAt,
    cleanText
  };
})(typeof self !== 'undefined' ? self : this);
