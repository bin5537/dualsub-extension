'use strict';

const $ = (id) => document.getElementById(id);
let tabId = null;
let settings = null;
let snapshot = { tracks: [], selected: [], maxLines: 3 };

const FONT_STACKS = {
  sans: '"Noto Sans KR", "Malgun Gothic", Arial, sans-serif',
  serif: '"Noto Serif KR", "Batang", Georgia, serif',
  round: '"Nanum Gothic", "Gulim", "Trebuchet MS", sans-serif',
  mono: '"D2Coding", Consolas, "Courier New", monospace'
};
const FONT_NAMES = { sans: '고딕', serif: '명조', round: '둥근고딕', mono: '고정폭' };
const OUTLINE_NAMES = {
  shadow: '그림자',
  stroke: '검은 테두리',
  glow: '부드러운 번짐',
  none: '없음'
};
const WEIGHTS = [
  { value: 300, label: '가늘게' },
  { value: 400, label: '보통' },
  { value: 500, label: '조금 굵게' },
  { value: 600, label: '반굵게' },
  { value: 700, label: '굵게' },
  { value: 800, label: '아주 굵게' },
  { value: 900, label: '최대' }
];
const WEIGHT_NAMES = WEIGHTS.reduce((acc, w) => {
  acc[w.value] = w.label;
  return acc;
}, {});
const THEME_NAMES = { auto: '시스템 설정', light: '밝게', dark: '어둡게' };

/** 팝업이 열리자마자 적용해야 깜빡이지 않는다. */
function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
  else root.removeAttribute('data-theme');
}

chrome.storage.local.get('settings', (data) => {
  applyTheme((data && data.settings && data.settings.theme) || 'auto');
});

const STYLE_DEFAULTS = {
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
  bottomPercent: 18
};

/** 슬라이더 id → 설정 키 · 표시 형식. 한 곳에서만 정의한다. */
const SLIDERS = [
  ['fontSize', 'fontSize', (v) => v + 'px'],
  ['bottom', 'bottomPercent', (v) => v + '%'],
  ['maxWidth', 'maxWidth', (v) => v + '%'],
  ['lineGap', 'lineGap', (v) => v + 'px'],
  ['lineHeight', 'lineHeight', (v) => (v / 100).toFixed(2)],
  ['letterSpacing', 'letterSpacing', (v) => (v / 10).toFixed(1)],
  ['outlineWidth', 'outlineWidth', (v) => v + 'px'],
  ['bgOpacity', 'bgOpacity', (v) => v + '%'],
  ['bgRadius', 'bgRadius', (v) => v + 'px'],
  ['bgPadX', 'bgPadX', (v) => v + 'px'],
  ['bgPadY', 'bgPadY', (v) => v + 'px']
];

function send(message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (res) => {
      resolve(chrome.runtime.lastError ? null : res);
    });
  });
}

function hexToRgb(hex) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || '');
  if (!m) return '0,0,0';
  return [1, 2, 3].map((i) => parseInt(m[i], 16)).join(',');
}

/** content.js 의 outlineCss 와 같은 규칙 — 미리보기가 실제와 어긋나면 안 된다. */
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

function renderPreview() {
  const bg = 'rgba(' + hexToRgb(settings.bgColor) + ',' + settings.bgOpacity / 100 + ')';
  const shadow = outlineCss(settings.outline, settings.outlineWidth);
  const family = FONT_STACKS[settings.fontFamily] || FONT_STACKS.sans;
  $('previewWrap').style.gap = settings.lineGap + 'px';
  [
    [$('previewLine1'), settings.fontSize, settings.fontColor],
    [$('previewLine2'), settings.fontSize2, settings.fontColor2]
  ].forEach(([el, size, color]) => {
    el.style.fontSize = size + 'px';
    el.style.color = color;
    el.style.fontFamily = family;
    el.style.fontWeight = String(settings.fontWeight || 400);
    el.style.lineHeight = settings.lineHeight / 100;
    el.style.letterSpacing = settings.letterSpacing / 10 + 'px';
    el.style.padding = settings.bgPadY + 'px ' + settings.bgPadX + 'px';
    el.style.borderRadius = settings.bgRadius + 'px';
    el.style.background = bg;
    el.style.textShadow = shadow;
  });
}

function selectionLabel() {
  if (!snapshot.selected.length) return '없음';
  return snapshot.selected
    .map((url) => {
      const t = snapshot.tracks.find((x) => x.url === url);
      return t ? t.label : '자막';
    })
    .join(' + ');
}

function syncLabels() {
  for (const [id, key, format] of SLIDERS) {
    const el = $(id + 'Value');
    if (el) el.textContent = format(settings[key]);
  }
  $('offsetValue').textContent = (settings.offsetMs / 1000).toFixed(1) + '초';
  $('speedValue').textContent = (settings.speed || 1).toFixed(2).replace(/0$/, '') + '배';
  $('fontValue').textContent = FONT_NAMES[settings.fontFamily] || '고딕';
  $('weightValue').textContent = WEIGHT_NAMES[settings.fontWeight] || '보통';
  $('themeValue').textContent = THEME_NAMES[settings.theme || 'auto'];
  $('outlineValue').textContent = OUTLINE_NAMES[settings.outline] || '그림자';
  $('trackValue').textContent = selectionLabel();
}

function pushSettings(patch) {
  Object.assign(settings, patch);
  syncLabels();
  renderPreview();
  send({ type: 'updateSettings', settings: patch });
}

function fillControls() {
  const active = document.activeElement;
  const skip = (id) => active && active.id === id;
  $('enabled').checked = settings.enabled;
  for (const [id, key] of SLIDERS) {
    if (!skip(id) && $(id)) $(id).value = settings[key];
  }
  if (!skip('fontColor')) $('fontColor').value = settings.fontColor;
  if (!skip('fontColor2')) $('fontColor2').value = settings.fontColor2;
  if (!skip('bgColor')) $('bgColor').value = settings.bgColor;
  syncLabels();
  renderPreview();
}

function renderState(state) {
  if (!state) {
    $('status').textContent = '이 탭에 아직 적용되지 않았습니다.';
    $('diagLine').textContent = '아래 버튼을 누르거나 페이지를 새로고침(Ctrl+R)하세요';
    $('injectBtn').style.display = '';
    return;
  }
  settings = state.settings;
  snapshot = {
    tracks: state.tracks || [],
    selected: state.selected || [],
    maxLines: state.maxLines || 3
  };
  $('status').textContent = state.status || '';
  $('diagLine').textContent = state.hookReady
    ? (state.host || '') + ' · 응답 ' + (state.inspected || 0) + '건 · 영상 ' +
      (state.hasVideo ? '감지됨' : '없음')
    : '⚠ 후킹 미적용 — 아래 버튼을 누르거나 Ctrl+R 하세요';
  $('injectBtn').style.display = state.hookReady ? 'none' : '';
  fillControls();

  if ($('diag').open) {
    const list = $('candidates');
    list.innerHTML = '';
    for (const c of state.candidates || []) {
      const li = document.createElement('li');
      li.textContent = c.url.slice(0, 160);
      list.appendChild(li);
    }
    if (!list.children.length) list.innerHTML = '<li>없음</li>';
  }
}

async function refresh() {
  renderState(await send({ type: 'getState' }));
}

/* ---------- iOS 시트 ---------- */

let sheetState = null;

function openSheet(config) {
  sheetState = {
    multi: !!config.multi,
    chosen: config.selected.slice(),
    onDone: config.onDone
  };
  $('sheetTitle').textContent = config.title;
  $('sheetNote').textContent = config.note || '';
  $('sheetDone').style.visibility = config.multi ? '' : 'hidden';
  renderSheetList(config.items, config.empty);
  $('sheet').hidden = false;
}

function renderSheetList(items, emptyText) {
  const list = $('sheetList');
  list.innerHTML = '';
  if (!items.length) {
    const div = document.createElement('div');
    div.className = 'sheet-empty';
    div.textContent = emptyText || '항목이 없습니다';
    list.appendChild(div);
    return;
  }
  items.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'list-item';
    const order = sheetState.chosen.indexOf(item.value);
    if (order >= 0) row.classList.add('on');

    const main = document.createElement('div');
    main.className = 'li-main';
    const label = document.createElement('div');
    label.className = 'li-label';
    label.textContent = item.label;
    main.appendChild(label);
    if (item.detail) {
      const sub = document.createElement('div');
      sub.className = 'li-sub';
      sub.textContent = item.detail;
      main.appendChild(sub);
    }
    row.appendChild(main);

    if (sheetState.multi && order >= 0) {
      const badge = document.createElement('span');
      badge.className = 'li-order';
      badge.textContent = String(order + 1);
      row.appendChild(badge);
    }
    const check = document.createElement('span');
    check.className = 'li-check';
    check.textContent = '✓';
    row.appendChild(check);

    row.addEventListener('click', () => {
      if (!sheetState.multi) {
        sheetState.chosen = [item.value];
        closeSheet(true);
        return;
      }
      const at = sheetState.chosen.indexOf(item.value);
      if (at >= 0) sheetState.chosen.splice(at, 1);
      else if (sheetState.chosen.length < snapshot.maxLines) {
        sheetState.chosen.push(item.value);
      }
      renderSheetList(items, emptyText);
    });
    list.appendChild(row);
  });
}

function closeSheet(commit) {
  /* 모양 시트는 고르는 시트가 아니라 옮겨 담은 것이다. 값은 조작 즉시 저장된다. */
  if (lookOpen) return closeLookSheet();
  if (!sheetState) return;
  const { chosen, onDone } = sheetState;
  $('sheet').hidden = true;
  sheetState = null;
  if (commit && onDone) onDone(chosen);
}

/* ---------- 모양 시트 ----------
 * 글자·외곽선·배경·배치를 시트에서 보여준다. 본문에 두면 팝업이 600px 을 넘어 잘린다.
 * 다시 그리지 않고 DOM 을 옮기기만 하므로 걸어 둔 이벤트가 그대로 살아 있다. */

let lookOpen = false;

function openLookSheet() {
  lookOpen = true;
  $('sheetTitle').textContent = '모양';
  $('sheetList').hidden = true;
  $('sheetNote').hidden = true;
  $('sheetDone').style.visibility = 'hidden';
  $('sheetCancel').textContent = '완료';
  $('sheetPanel').appendChild($('lookGroups'));
  $('sheet').hidden = false;
}

function closeLookSheet() {
  lookOpen = false;
  $('lookHost').appendChild($('lookGroups'));
  $('sheet').hidden = true;
  $('sheetList').hidden = false;
  $('sheetNote').hidden = false;
  $('sheetCancel').textContent = '취소';
}

/* ---------- .srt 로 내보내기 ----------
 * 안드로이드 오버레이 앱은 사이트 자막을 읽을 수 없다. 여기서 뽑아 파일로 넘겨준다. */

function srtStamp(ms) {
  const t = Math.max(0, Math.round(ms));
  const pad = (n, w) => String(n).padStart(w, '0');
  return (
    pad(Math.floor(t / 3600000), 2) + ':' +
    pad(Math.floor(t / 60000) % 60, 2) + ':' +
    pad(Math.floor(t / 1000) % 60, 2) + ',' +
    pad(t % 1000, 3)
  );
}

function toSrt(cues) {
  return cues
    .map((cue, i) =>
      i + 1 + '\n' + srtStamp(cue.start) + ' --> ' + srtStamp(cue.end) + '\n' + cue.text + '\n'
    )
    .join('\n');
}

function safeFileName(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || '자막';
}

function downloadText(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function exportTrack(url) {
  const res = await send({ type: 'getCues', url });
  if (!res || !res.ok || !res.cues.length) {
    $('status').textContent = '내보낼 대사가 없습니다. 먼저 목록에서 골라 불러오세요.';
    return;
  }
  downloadText(toSrt(res.cues), safeFileName(res.label) + '.srt');
  $('status').textContent = res.label + ' — ' + res.cues.length + '개 대사를 저장했습니다';
}

/* ---------- 주입 ---------- */

async function injectNow() {
  const btn = $('injectBtn');
  btn.disabled = true;
  btn.textContent = '적용 중…';
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['src/hook.js'],
      world: 'MAIN'
    });
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['src/parser.js', 'src/content.js'],
      world: 'ISOLATED'
    });
    await chrome.scripting.insertCSS({
      target: { tabId, allFrames: true },
      files: ['src/overlay.css']
    });
    btn.textContent = '적용됨';
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = '이 탭에 지금 적용하기';
      refresh();
    }, 2200);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '이 탭에 지금 적용하기';
    $('diagLine').textContent = '주입 실패: ' + (err && err.message);
  }
}

/* ---------- 시작 ---------- */

document.addEventListener('DOMContentLoaded', async () => {
  $('version').textContent = 'v' + chrome.runtime.getManifest().version;
  $('injectBtn').addEventListener('click', injectNow);
  $('lookRow').addEventListener('click', openLookSheet);
  /* 되돌리기는 네 묶음 전부에 걸린다. */
  $('resetLookRow').addEventListener('click', () => $('resetStyle').click());

  $('sheetCancel').addEventListener('click', () => closeSheet(false));
  $('sheetBackdrop').addEventListener('click', () => closeSheet(false));
  $('sheetDone').addEventListener('click', () => closeSheet(true));

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  tabId = tab.id;
  await refresh();
  setInterval(() => {
    if (!sheetState) refresh();
  }, 1500);
  if (!settings) return;

  $('trackRow').addEventListener('click', () => {
    openSheet({
      title: '표시할 자막',
      multi: true,
      selected: snapshot.selected,
      items: snapshot.tracks.map((t) => ({
        value: t.url,
        label: t.label,
        detail: t.cueCount ? t.cueCount + '개 대사' : '고르면 불러옵니다'
      })),
      empty:
        '아직 잡힌 자막이 없습니다.\n재생 중에 사이트의 자막 언어를\n한 번씩 바꿔주면 그 자막을 붙잡습니다.',
      note:
        '최대 ' + snapshot.maxLines + '개까지 고를 수 있고, 고른 순서대로 위에서부터 표시됩니다.',
      onDone: async (chosen) => {
        snapshot.selected = chosen;
        syncLabels();
        await send({ type: 'setSelected', urls: chosen });
        setTimeout(refresh, 300);
      }
    });
  });

  $('fontRow').addEventListener('click', () => {
    openSheet({
      title: '글꼴',
      multi: false,
      selected: [settings.fontFamily],
      items: Object.keys(FONT_NAMES).map((k) => ({ value: k, label: FONT_NAMES[k] })),
      onDone: (chosen) => pushSettings({ fontFamily: chosen[0] })
    });
  });

  $('themeRow').addEventListener('click', () => {
    openSheet({
      title: '화면 모드',
      multi: false,
      selected: [settings.theme || 'auto'],
      items: Object.keys(THEME_NAMES).map((k) => ({ value: k, label: THEME_NAMES[k] })),
      note: '이 설정 창의 밝기입니다. 영상 위 자막 색은 "글자"에서 따로 정합니다.',
      onDone: (chosen) => {
        applyTheme(chosen[0]);
        pushSettings({ theme: chosen[0] });
      }
    });
  });

  $('exportRow').addEventListener('click', () => {
    const ready = snapshot.tracks.filter((t) => t.cueCount > 0);
    openSheet({
      title: '.srt 파일로 저장',
      multi: false,
      selected: [],
      items: ready.map((t) => ({
        value: t.url,
        label: t.label,
        detail: t.cueCount + '개 대사'
      })),
      empty:
        '아직 불러온 자막이 없습니다.\n"표시할 자막"에서 먼저 골라\n화면에 뜨는 것을 확인한 뒤 저장하세요.',
      onDone: (chosen) => {
        if (chosen[0]) exportTrack(chosen[0]);
      }
    });
  });

  $('weightRow').addEventListener('click', () => {
    openSheet({
      title: '글꼴 굵기',
      multi: false,
      selected: [settings.fontWeight],
      items: WEIGHTS.map((w) => ({ value: w.value, label: w.label })),
      note: '글꼴에 따라 일부 굵기는 가장 가까운 두께로 표시됩니다.',
      onDone: (chosen) => pushSettings({ fontWeight: chosen[0] })
    });
  });

  $('outlineRow').addEventListener('click', () => {
    openSheet({
      title: '외곽선',
      multi: false,
      selected: [settings.outline],
      items: Object.keys(OUTLINE_NAMES).map((k) => ({ value: k, label: OUTLINE_NAMES[k] })),
      onDone: (chosen) => pushSettings({ outline: chosen[0] })
    });
  });

  $('enabled').addEventListener('change', (e) => pushSettings({ enabled: e.target.checked }));

  for (const [id, key] of SLIDERS) {
    const el = $(id);
    if (!el) continue;
    el.addEventListener('input', (e) => {
      const value = parseInt(e.target.value, 10);
      // 크기는 두 줄이 같은 차이를 유지하도록 함께 움직인다.
      if (key === 'fontSize') {
        pushSettings({ fontSize: value, fontSize2: Math.max(10, value - 2) });
      } else {
        pushSettings({ [key]: value });
      }
    });
  }

  $('fontColor').addEventListener('input', (e) => pushSettings({ fontColor: e.target.value }));
  $('fontColor2').addEventListener('input', (e) => pushSettings({ fontColor2: e.target.value }));
  $('bgColor').addEventListener('input', (e) => pushSettings({ bgColor: e.target.value }));

  $('resetStyle').addEventListener('click', () => {
    pushSettings(Object.assign({}, STYLE_DEFAULTS));
    fillControls();
  });

  $('syncMinus').addEventListener('click', () =>
    pushSettings({ offsetMs: settings.offsetMs - 500 })
  );
  $('syncPlus').addEventListener('click', () =>
    pushSettings({ offsetMs: settings.offsetMs + 500 })
  );
  $('syncReset').addEventListener('click', () => pushSettings({ offsetMs: 0 }));

  /* 배속. 0.25 단위로 0.25~4배.
     정수 배수만 쓰면 1.5 · 1.75 처럼 실제로 자주 쓰는 값에 닿지 못한다. */
  const stepSpeed = (d) =>
    pushSettings({
      speed: Math.min(4, Math.max(0.25,
        Math.round(((settings.speed || 1) + d) * 100) / 100))
    });
  $('speedDown').addEventListener('click', () => stepSpeed(-0.25));
  $('speedUp').addEventListener('click', () => stepSpeed(0.25));
  $('speedReset').addEventListener('click', () => pushSettings({ speed: 1 }));

  $('file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const text = await file.text();
    const res = await send({ type: 'loadFile', text, name: file.name });
    if (res && !res.ok) $('status').textContent = '오류: ' + res.error;
    setTimeout(refresh, 300);
  });
});
