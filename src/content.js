/**
 * 콘텐츠 스크립트 — 붙잡은 자막 트랙들을 영상 위에 여러 줄로 동시에 그린다.
 * 사이트 자체 자막은 꺼도 되고 켜도 된다(켜면 그만큼 줄이 늘어날 뿐).
 */
(function () {
  'use strict';

  if (window.__dualsubContentLoaded) return;
  window.__dualsubContentLoaded = true;

  const P = window.DualSubParser;
  const MAX_LINES = 3;

  const state = {
    tracks: [],
    cuesByUrl: {},
    selected: [],
    candidates: [],
    status: '대기 중 — 재생하면 자막을 잡습니다',
    hookReady: false,
    inspected: 0,
    workerMessages: 0,
    host: ''
  };

  const settings = {
    enabled: true,
    autoAdd: true,
    fontSize: 22,
    fontSize2: 20,
    fontColor: '#ffffff',
    fontColor2: '#ffd97d',
    fontFamily: 'sans',
    fontWeight: 400,
    outline: 'shadow',
    outlineWidth: 2,
    bgColor: '#000000',
    bgOpacity: 65,
    bgRadius: 4,
    bgPadX: 12,
    bgPadY: 2,
    maxWidth: 92,
    lineHeight: 135,
    letterSpacing: 0,
    lineGap: 4,
    offsetMs: 0,
    speed: 1,
    bottomPercent: 18,
    preferredLanguage: 'en',
    theme: 'auto',
    // 고른 자막은 URL 이 아니라 "언어"로 기억한다. URL 은 작품마다 달라서 남겨두면
    // 다음 영상에서 이름 없는 유령 항목이 된다.
    langs: []
  };

  const FONT_STACKS = {
    sans: '"Noto Sans KR", "Malgun Gothic", Arial, sans-serif',
    serif: '"Noto Serif KR", "Batang", Georgia, serif',
    round: '"Nanum Gothic", "Gulim", "Trebuchet MS", sans-serif',
    mono: '"D2Coding", Consolas, "Courier New", monospace'
  };

  let overlay = null;
  let stack = null;
  let toastEl = null;
  let toastTimer = null;
  let currentVideo = null;
  let lastSignature = '';
  let dragBound = false;

  function hexToRgb(hex) {
    const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || '');
    if (!m) return '0,0,0';
    return [1, 2, 3].map((i) => parseInt(m[i], 16)).join(',');
  }

  /** 외곽선 종류·굵기를 text-shadow 로 만든다. */
  function outlineCss(kind, width) {
    const w = Math.max(0, width || 0);
    if (!w || kind === 'none') return 'none';
    if (kind === 'stroke') {
      const offsets = [
        [-1, -1], [1, -1], [-1, 1], [1, 1],
        [0, -1], [0, 1], [-1, 0], [1, 0]
      ];
      return offsets
        .map(([x, y]) => x * w + 'px ' + y * w + 'px 0 #000')
        .concat(['0 0 ' + w * 3 + 'px rgba(0,0,0,0.85)'])
        .join(',');
    }
    if (kind === 'glow') {
      return '0 0 ' + w * 3 + 'px rgba(0,0,0,0.95), 0 0 ' + w * 6 + 'px rgba(0,0,0,0.75)';
    }
    return '0 ' + w + 'px ' + w * 2 + 'px rgba(0,0,0,0.9)';
  }

  /* ---------- 설정 ---------- */

  chrome.storage.local.get('settings', (data) => {
    const saved = (data && data.settings) || {};
    Object.assign(settings, saved);
    if (!Array.isArray(settings.langs)) settings.langs = [];
    // 켬/끔으로 저장된 옛 값을 단계 값으로 옮긴다.
    if (saved.fontWeight === undefined) settings.fontWeight = saved.bold ? 700 : 400;
    applyStyle();
    applySpeed();
  });

  function saveSettings() {
    chrome.storage.local.set({ settings });
  }

  /* ---------- 오버레이 ---------- */

  function ensureOverlay() {
    if (overlay && overlay.isConnected) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'dualsub-overlay';
    stack = document.createElement('div');
    stack.className = 'dualsub-stack';
    toastEl = document.createElement('div');
    toastEl.className = 'dualsub-toast';
    toastEl.style.display = 'none';
    overlay.appendChild(toastEl);
    overlay.appendChild(stack);
    attachOverlay();
    applyStyle();
    enableDrag();
    lastSignature = '';
    return overlay;
  }

  /** 전체화면일 때는 전체화면 요소 안에 있어야 보인다. */
  function attachOverlay() {
    const host =
      document.fullscreenElement ||
      (currentVideo && currentVideo.parentElement) ||
      document.body;
    if (overlay.parentElement !== host) host.appendChild(overlay);
    if (host !== document.body && getComputedStyle(host).position === 'static') {
      host.style.position = 'relative';
    }
  }

  function lineStyle(el, index) {
    el.style.fontSize = (index === 0 ? settings.fontSize : settings.fontSize2) + 'px';
    el.style.color = index === 0 ? settings.fontColor : settings.fontColor2;
    el.style.fontFamily = FONT_STACKS[settings.fontFamily] || FONT_STACKS.sans;
    el.style.fontWeight = String(settings.fontWeight || 400);
    el.style.lineHeight = settings.lineHeight / 100;
    el.style.letterSpacing = settings.letterSpacing / 10 + 'px';
    el.style.padding = settings.bgPadY + 'px ' + settings.bgPadX + 'px';
    el.style.borderRadius = settings.bgRadius + 'px';
    el.style.background =
      'rgba(' + hexToRgb(settings.bgColor) + ',' + settings.bgOpacity / 100 + ')';
    el.style.textShadow = outlineCss(settings.outline, settings.outlineWidth);
  }

  function applyStyle() {
    if (!overlay) return;
    overlay.style.bottom = settings.bottomPercent + '%';
    overlay.style.display = settings.enabled ? '' : 'none';
    overlay.style.maxWidth = settings.maxWidth + '%';
    if (stack) stack.style.gap = settings.lineGap + 'px';
    if (stack) {
      Array.prototype.forEach.call(stack.children, (el, i) => lineStyle(el, i));
    }
    if (toastEl) toastEl.style.fontFamily = FONT_STACKS[settings.fontFamily];
  }

  function enableDrag() {
    if (dragBound) return;
    dragBound = true;
    let dragging = false;
    let startY = 0;
    let startBottom = 0;
    window.addEventListener('mousedown', (e) => {
      if (!e.altKey || !settings.enabled) return;
      dragging = true;
      startY = e.clientY;
      startBottom = settings.bottomPercent;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const host = overlay.parentElement || document.body;
      const height = host.clientHeight || window.innerHeight;
      settings.bottomPercent = Math.min(
        80,
        Math.max(0, startBottom + ((startY - e.clientY) / height) * 100)
      );
      applyStyle();
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      saveSettings();
    });
  }

  function toast(message) {
    ensureOverlay();
    toastEl.textContent = message;
    toastEl.style.display = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.style.display = 'none';
    }, 2600);
  }

  /* ---------- 배속 ----------
   * 디즈니+ 처럼 배속 버튼이 없는 플레이어를 위해 video.playbackRate 를 직접 건다.
   * 플레이어가 트랙을 바꾸거나 광고를 끼울 때 1 로 되돌리는 경우가 있어
   * ratechange 를 듣고 우리 값과 다르면 다시 건다. */

  let speedGuard = false;

  function applySpeed(video) {
    const v = video || findVideo();
    if (!v) return;
    const want = Math.min(4, Math.max(0.25, Number(settings.speed) || 1));
    if (Math.abs(v.playbackRate - want) < 0.001) return;
    speedGuard = true;
    try {
      v.playbackRate = want;
    } catch (e) {
      /* 일부 플레이어는 재생 준비 전 setter 에서 던진다. 다음 렌더에서 다시 시도한다. */
    }
    speedGuard = false;
  }

  function watchSpeed(video) {
    if (!video || video.__dualsubSpeed) return;
    video.__dualsubSpeed = true;
    video.addEventListener('ratechange', () => {
      if (!speedGuard) applySpeed(video);
    });
  }

  /* ---------- 영상 찾기 · 렌더 ---------- */

  /* querySelectorAll 은 섀도 루트를 넘지 않는다. 커스텀 엘리먼트로 플레이어를
     감싸는 사이트에서는 문서에 video 가 없는 것처럼 보인다.
     얕은 탐색이 빈손일 때만 섀도 루트를 훑는다 — 매 프레임 전체를 걷으면 비싸다. */
  function collectVideos(root, out, depth) {
    if (depth > 6) return;
    out.push.apply(out, root.querySelectorAll('video'));
    const all = root.querySelectorAll('*');
    for (let i = 0; i < all.length; i += 1) {
      const sr = all[i].shadowRoot;
      if (sr) collectVideos(sr, out, depth + 1);
    }
  }

  /* 왜 못 찾는지 팝업에서 보이게 남긴다. "영상 없음" 만으로는
     섀도 DOM 인지 iframe 인지 아직 안 붙은 것인지 구분할 수 없다. */
  const videoProbe = { shallow: 0, deep: 0, frames: 0, media: 0 };

  function findVideo() {
    let videos = Array.from(document.querySelectorAll('video'));
    videoProbe.shallow = videos.length;
    videoProbe.frames = window.frames.length;
    if (!videos.length) {
      const deep = [];
      try {
        collectVideos(document, deep, 0);
      } catch (e) {
        /* 문서가 바뀌는 중이면 던질 수 있다. 다음 렌더에서 다시 찾는다. */
      }
      videos = deep;
      videoProbe.deep = deep.length;
      /* audio 까지 세어 두면 "미디어 자체가 없다" 와 "video 만 없다" 가 갈린다. */
      try {
        videoProbe.media = document.querySelectorAll('video,audio').length;
      } catch (e) {
        videoProbe.media = 0;
      }
    }
    if (!videos.length) return null;
    const playing = videos.find((v) => !v.paused && v.duration > 60);
    if (playing) return playing;
    return videos.sort((a, b) => (b.duration || 0) - (a.duration || 0))[0];
  }

  function render() {
    if (!settings.enabled) {
      if (overlay) overlay.style.display = 'none';
      return;
    }
    const video = findVideo();
    if (video !== currentVideo) {
      currentVideo = video;
      if (overlay) attachOverlay();
      watchSpeed(video);
    }
    applySpeed(video);
    if (!video || !state.selected.length) {
      if (stack && stack.children.length) {
        stack.textContent = '';
        lastSignature = '';
      }
      return;
    }
    ensureOverlay();
    attachOverlay();

    const t = video.currentTime * 1000 - settings.offsetMs;
    const texts = state.selected.map((url) => {
      const cue = P.cueAt(state.cuesByUrl[url] || [], t);
      return cue ? cue.text : '';
    });

    const signature = JSON.stringify(texts);
    if (signature === lastSignature) return;
    lastSignature = signature;

    // 필요한 만큼만 줄 요소를 만들고 재사용한다.
    while (stack.children.length < texts.length) {
      const el = document.createElement('div');
      el.className = 'dualsub-line';
      stack.appendChild(el);
      lineStyle(el, stack.children.length - 1);
    }
    while (stack.children.length > texts.length) {
      stack.removeChild(stack.lastChild);
    }
    texts.forEach((text, i) => {
      const el = stack.children[i];
      el.textContent = text;
      el.style.display = text ? '' : 'none';
    });
  }

  document.addEventListener('fullscreenchange', () => {
    if (overlay) attachOverlay();
  });

  setInterval(render, 100);

  /* ---------- 트랙 관리 ---------- */

  function languageMatches(track, lang) {
    const l = (track.language || '').toLowerCase();
    return l === lang || l.startsWith(lang + '-');
  }

  function pickTrack(tracks) {
    const lang = (settings.preferredLanguage || 'en').toLowerCase();
    const matching = tracks.filter((t) => languageMatches(t, lang) && !t.forced);
    if (!matching.length) return null;
    return matching.find((t) => !t.closedCaptions) || matching[0];
  }

  function describeSelection() {
    const names = state.selected
      .map((url) => {
        const t = state.tracks.find((x) => x.url === url);
        return t ? t.label : null;
      })
      .filter(Boolean);
    if (!names.length) return '표시할 자막 없음';
    return names.join(' + ') + ' 표시 중';
  }

  /** 실제로 존재하는 트랙만 남겨 화면에 올린다. */
  function applySelection(urls) {
    const seen = new Set();
    state.selected = urls
      .filter((url) => {
        if (seen.has(url)) return false;
        seen.add(url);
        return state.tracks.some((t) => t.url === url);
      })
      .slice(0, MAX_LINES);
    lastSignature = '';
    state.selected.forEach(ensureCues);
    state.status = describeSelection();
  }

  /** 사용자가 직접 고른 경우 — 어떤 언어를 원하는지 기억해 둔다. */
  function setSelectionFromUser(urls) {
    applySelection(urls);
    settings.langs = state.selected
      .map((url) => {
        const t = state.tracks.find((x) => x.url === url);
        return t ? String(t.language || '').toLowerCase() : '';
      })
      .filter(Boolean);
    saveSettings();
  }

  /** 새 트랙이 잡혔을 때 기억해 둔 언어에 맞춰 자동으로 올린다. */
  function autoSelect() {
    if (!settings.autoAdd) return;

    if (settings.langs && settings.langs.length) {
      const picked = [];
      for (const lang of settings.langs) {
        const match = state.tracks.find(
          (t) => picked.indexOf(t.url) === -1 && languageMatches(t, lang)
        );
        if (match) picked.push(match.url);
      }
      if (picked.length && picked.join('|') !== state.selected.join('|')) {
        applySelection(picked);
      }
      return;
    }

    // 아직 고른 적이 없으면 선호 언어 하나만 올린다. 나머지는 사용자가 고른다.
    if (!state.selected.length) {
      const pick = pickTrack(state.tracks);
      if (pick) applySelection([pick.url]);
    }
  }

  function ensureCues(url) {
    if (state.cuesByUrl[url]) return;
    const track = state.tracks.find((t) => t.url === url);
    if (!track) return;
    if (track.format === 'inline') return; // 이미 본문을 받아 파싱해둔 트랙
    state.status = track.label + ' 불러오는 중…';
    chrome.runtime.sendMessage({ type: 'loadTrack', track }, (res) => {
      if (chrome.runtime.lastError || !res || !res.ok) {
        const msg = chrome.runtime.lastError
          ? chrome.runtime.lastError.message
          : (res && res.error) || '알 수 없음';
        state.status = '오류: ' + msg;
        toast('겹자막 오류: ' + msg);
        return;
      }
      state.cuesByUrl[url] = res.cues || [];
      lastSignature = '';
      state.status = describeSelection();
      toast('겹자막: ' + track.label + ' (' + (res.cues || []).length + '개 대사)');
    });
  }

  /* 같은 언어가 매니페스트·자막본문 등 여러 경로로 들어와 목록이 중복된다.
   * 언어(+해설·강제 구분)를 기준으로 하나만 남기고, 대사를 이미 가진 쪽을 우선한다. */
  // 언어를 확실히 아는 경우만 언어로 묶는다. 파일·추정 언어(eu/unknown)·빈 값은
  // 서로 다른 자막일 수 있으므로 URL 로 구분해 실수로 합쳐지지 않게 한다.
  const AMBIGUOUS_LANG = /^(|file|eu|unknown|und)$/;

  function trackKey(track) {
    const lang = String(track.language || '').toLowerCase();
    if (AMBIGUOUS_LANG.test(lang)) return 'url:' + track.url;
    return [lang, track.closedCaptions ? 'cc' : '', track.forced ? 'forced' : ''].join('|');
  }

  function hasCues(url) {
    return !!(state.cuesByUrl[url] && state.cuesByUrl[url].length);
  }

  function addTrack(track, cues) {
    if (state.tracks.some((t) => t.url === track.url)) return false;

    const key = trackKey(track);
    const at = state.tracks.findIndex((t) => trackKey(t) === key);
    if (at >= 0) {
      const existing = state.tracks[at];
      const incomingHasCues = !!(cues && cues.length);
      if (hasCues(existing.url) || !incomingHasCues) return false;

      // 새로 들어온 쪽은 이미 대사를 갖고 있다 — 내려받아야 하는 기존 것을 대체한다.
      const slot = state.selected.indexOf(existing.url);
      state.tracks[at] = track;
      state.cuesByUrl[track.url] = cues;
      delete state.cuesByUrl[existing.url];
      if (slot >= 0) state.selected[slot] = track.url;
      lastSignature = '';
      return true;
    }

    state.tracks.push(track);
    if (cues) state.cuesByUrl[track.url] = cues;
    return true;
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__dualsub !== 'DUALSUB') return;

    if (data.type === 'tracks') {
      let added = false;
      for (const t of data.payload.tracks || []) {
        if (addTrack(t, null)) added = true;
      }
      if (!added) return;
      state.status = state.tracks.length + '개 자막 트랙 발견';
      autoSelect();
      if (state.selected.length) state.status = describeSelection();
    } else if (data.type === 'subtitle') {
      const p = data.payload;
      const cues = P.sortAndClean(P.parse(p.text));
      if (!cues.length) return;
      const track = {
        language: p.language,
        label: p.label,
        forced: false,
        closedCaptions: false,
        format: 'inline',
        url: p.url
      };
      if (!addTrack(track, cues)) return;
      // 사이트 자막 언어를 직접 바꿔서 받아온 것이므로 바로 화면에 올린다.
      const live = state.tracks.find((t) => trackKey(t) === trackKey(track));
      if (settings.autoAdd && live && state.selected.indexOf(live.url) === -1 &&
          state.selected.length < MAX_LINES) {
        applySelection(state.selected.concat([live.url]));
        toast('겹자막: ' + p.label + ' 추가됨 (' + cues.length + '개 대사)');
      } else {
        state.status = describeSelection();
      }
    } else if (data.type === 'navigate') {
      // 다른 작품·에피소드로 넘어갔다 — 이전 자막을 그대로 두면 엉뚱한 대사가 뜬다.
      state.tracks = [];
      state.cuesByUrl = {};
      state.selected = [];
      state.candidates = [];
      lastSignature = '';
      // 고른 "언어"는 그대로 기억해 두고, 새 영상에서 같은 언어를 다시 찾아 올린다.
      state.status = '다른 영상으로 이동 — 자막을 다시 찾는 중';
      if (stack) stack.textContent = '';
    } else if (data.type === 'ready') {
      state.hookReady = true;
    } else if (data.type === 'stats') {
      state.hookReady = true;
      state.inspected = data.payload.inspected || 0;
      state.workerMessages = data.payload.workerMessages || 0;
      state.host = data.payload.host || '';
    } else if (data.type === 'candidate') {
      if (state.candidates.length < 40 &&
          !state.candidates.some((c) => c.url === data.payload.url)) {
        state.candidates.push(data.payload);
      }
    }
  });

  /* ---------- 팝업과의 통신 ---------- */

  function buildState() {
    return {
        tracks: state.tracks.map((t) => ({
          url: t.url,
          label: t.label,
          language: t.language,
          forced: t.forced,
          closedCaptions: t.closedCaptions,
          cueCount: (state.cuesByUrl[t.url] || []).length
        })),
        selected: state.selected,
        candidates: state.candidates,
        status: state.status,
        settings,
        maxLines: MAX_LINES,
        hasVideo: !!findVideo(),
        videoProbe: videoProbe,
        hookReady: state.hookReady,
        inspected: state.inspected,
        workerMessages: state.workerMessages,
        host: state.host || location.hostname
      };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return false;

    /* 팝업은 frameId 없이 보내므로 모든 프레임이 받고, 먼저 답한 하나만 전달된다.
       최상위 프레임이 빈손으로 먼저 답하면 정작 영상이 있는 iframe 의 답이 버려진다.
       보여줄 것이 없는 프레임은 조금 늦게 답해 자리를 양보한다. */
    if (msg.type === 'getState') {
      const empty = !findVideo() && !state.tracks.length && !state.candidates.length;
      if (!empty) {
        sendResponse(buildState());
        return false;
      }
      /* 늦게 답하는 사이 팝업이 닫히면 통로가 사라져 sendResponse 가 던진다.
         팝업은 1.5초마다 다시 물어보므로 놓친 응답은 문제가 되지 않는다. */
      const wait = window.top === window ? 120 : 250;
      setTimeout(() => {
        try {
          sendResponse(buildState());
        } catch (e) {
          /* 팝업이 이미 닫혔다. */
        }
      }, wait);
      return true;
    }



    if (msg.type === 'getCues') {
      const track = state.tracks.find((t) => t.url === msg.url);
      sendResponse({
        ok: !!track,
        cues: state.cuesByUrl[msg.url] || [],
        label: track ? track.label : '자막'
      });
      return false;
    }

    if (msg.type === 'setSelected') {
      setSelectionFromUser(Array.isArray(msg.urls) ? msg.urls : []);
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'updateSettings') {
      Object.assign(settings, msg.settings);
      saveSettings();
      applyStyle();
      applySpeed();
      lastSignature = '';
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'loadFile') {
      const cues = P.sortAndClean(P.parse(msg.text));
      if (!cues.length) {
        sendResponse({ ok: false, error: '자막을 읽지 못했습니다' });
        return false;
      }
      const url = 'file:' + (msg.name || '자막');
      addTrack(
        {
          language: 'file',
          label: msg.name || '파일 자막',
          forced: false,
          closedCaptions: false,
          format: 'inline',
          url
        },
        cues
      );
      state.cuesByUrl[url] = cues;
      applySelection(state.selected.concat([url]));
      toast('겹자막: ' + (msg.name || '파일') + ' (' + cues.length + '개 대사)');
      sendResponse({ ok: true, count: cues.length });
      return false;
    }

    return false;
  });

  /* ---------- 단축키 ---------- */

  window.addEventListener(
    'keydown',
    (e) => {
      if (!settings.enabled) return;
      const tag = (e.target && e.target.tagName) || '';
      if (/INPUT|TEXTAREA|SELECT/.test(tag) || (e.target && e.target.isContentEditable)) return;
      if (!e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;

      if (e.key === 'ArrowLeft') settings.offsetMs -= 500;
      else if (e.key === 'ArrowRight') settings.offsetMs += 500;
      else if (e.key === 'ArrowUp') {
        settings.fontSize = Math.min(60, settings.fontSize + 2);
        settings.fontSize2 = Math.min(60, settings.fontSize2 + 2);
      } else if (e.key === 'ArrowDown') {
        settings.fontSize = Math.max(10, settings.fontSize - 2);
        settings.fontSize2 = Math.max(10, settings.fontSize2 - 2);
      } else if (e.key === '<' || e.key === ',') {
        settings.speed = Math.max(0.25, Math.round((settings.speed - 0.25) * 100) / 100);
      } else if (e.key === '>' || e.key === '.') {
        settings.speed = Math.min(4, Math.round((settings.speed + 0.25) * 100) / 100);
      } else return;

      e.preventDefault();
      e.stopPropagation();
      applyStyle();
      saveSettings();
      lastSignature = '';
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        toast('싱크 ' + (settings.offsetMs / 1000).toFixed(1) + '초');
      } else if (/[<>,.]/.test(e.key)) {
        applySpeed();
        toast('배속 ' + settings.speed + '배');
      }
    },
    true
  );
})();
