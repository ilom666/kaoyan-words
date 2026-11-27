/* ===== 刷单词 · 前端逻辑 ===== */
'use strict';

/* ---------- 工具 ---------- */
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 应用状态存服务端 SQLite；内存镜像让同步读写点无需大改，写回做 debounce
let STATE = {};
let STATE_LOAD_FAILED = false;
let _stateTimer = null;
let _stateDirty = false;

async function loadState() {
  try {
    const r = await fetch('/api/state', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    STATE = await r.json() || {};
    STATE_LOAD_FAILED = false;
  } catch (e) {
    // 加载失败时保持内存为空，但绝不写回：避免服务未就绪时空状态覆盖已有进度
    STATE = {};
    STATE_LOAD_FAILED = true;
  }
}
function store() { return STATE; }
function saveStore(obj) {
  STATE = obj || {};
  _stateDirty = true;
  clearTimeout(_stateTimer);
  _stateTimer = setTimeout(flushState, 300);
}
async function flushState() {
  if (!_stateDirty) return;
  _stateDirty = false;
  // 状态从未成功加载过：禁止把空状态写回，否则会覆盖服务端已有进度
  if (STATE_LOAD_FAILED) return;
  try {
    await fetch('/api/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(STATE) });
  } catch (e) { /* 离线时保留内存状态, 下次保存会重试 */ }
}
window.addEventListener('beforeunload', () => { if (_stateDirty) flushState(); });

function toast(msg, ms = 1800) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._tm);
  t._tm = setTimeout(() => t.hidden = true, ms);
}

const DEFAULT_KEYS = {
  start: ['Enter'],
  reveal: ['Space'],
  next: ['ArrowRight', 'N'],
  prev: ['ArrowLeft', 'P'],
  known: ['1'],
  unknown: ['2'],
  speak: ['E'],
  star: ['S'],
  quickEdit: ['Q'],
  game1: ['1'],
  game2: ['2'],
  game3: ['3'],
  game4: ['4'],
  gameSpeak: ['E'],
  gameQuit: ['Escape'],
  gameAgain: ['Enter'],
  readingBack: ['Escape'],
  readingAgain: ['Enter'],
};

const KEY_GROUPS = [
  { title: '通用 / 首页', actions: [
    ['start', '开始刷词'],
  ] },
  { title: '刷词页', actions: [
    ['reveal', '显示 / 隐藏词义'],
    ['next', '下一个'],
    ['prev', '上一个'],
    ['known', '标为认识'],
    ['unknown', '标为不认识'],
    ['speak', '朗读'],
    ['star', '收藏 / 取消收藏'],
    ['quickEdit', '快速修改'],
  ] },
  { title: '小游戏', actions: [
    ['game1', '选项 1'],
    ['game2', '选项 2'],
    ['game3', '选项 3'],
    ['game4', '选项 4'],
    ['gameSpeak', '再听一遍'],
    ['gameQuit', '退出 / 返回菜单'],
    ['gameAgain', '再来一局'],
  ] },
  { title: 'AI 阅读理解', actions: [
    ['readingBack', '返回 / 关闭弹层'],
    ['readingAgain', '再生成一篇'],
  ] },
];

const KEY_LABELS = {
  Space: '空格', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
  Escape: 'Esc', Enter: '回车', Backspace: '退格', Tab: 'Tab',
  Control: 'Ctrl', Alt: 'Alt', Meta: 'Meta', Shift: 'Shift',
};

let capturingKeyAction = null;

function cloneKeys(keys) {
  const out = {};
  for (const [k, v] of Object.entries(keys || {})) out[k] = Array.isArray(v) ? [...v] : [];
  return out;
}

function normalizeKeyEvent(e) {
  let key = e.key;
  if (key === ' ') key = 'Space';
  else if (key.length === 1) key = key.toUpperCase();
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.metaKey) parts.push('Meta');
  if (e.shiftKey) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

function keyLabel(k) {
  return String(k).split('+').map(p => KEY_LABELS[p] || p).join(' + ');
}

function keyMatches(action, e) {
  const list = S.settings.keys?.[action] || DEFAULT_KEYS[action] || [];
  return Array.isArray(list) && list.includes(normalizeKeyEvent(e));
}

/* ---------- 全局状态 ---------- */
const S = {
  words: [],
  byId: new Map(),
  lessons: [],          // [{key, label, part, unit, lesson, words:[], counts}]
  selected: new Set(),  // 选中的 lesson key
  currentPart: '1',     // 当前选中的 Part 标签
  queue: [], qi: 0,     // 学习队列
  studyFrom: 'home',    // 本轮刷词来源: home / list
  studyActive: false,   // 是否有进行中的刷词会话(切换到别的菜单后仍可恢复)
  known: {},            // id -> 1 认识 / 2 不认识
  starred: {},          // id -> 1 已收藏
  listMode: 'starred',  // 列表视图: starred / unknown
  listFrom: 'home',     // 列表来源视图
  listQ: '', listPage: 1, listSize: 50,
  listRevealed: new Set(),  // 当前已点开词义的词条 id
  settings: { maskMode: 'both', autoSpeak: false, autoReveal: false, autoNextKnown: false, shuffle: false, groupByBadge: false, unknownOnly: false, accent: 'uk', listMask: true, listGroupByUnit: false, listSize: 50, keys: cloneKeys(DEFAULT_KEYS) },
  mg: { q: '', lesson: '', page: 1, size: 50, selectedId: null },   // size 与 settings.listSize 共用
  editingId: null,
  editingAfterId: null,
};

function mergeSettings(src) {
  Object.assign(S.settings, src || {});
  S.settings.keys = { ...DEFAULT_KEYS, ...cloneKeys(src?.keys || {}) };
}

/* ---------- 数据加载 ---------- */
async function loadWords() {
  const res = await fetch('/api/words', { cache: 'no-store' });
  const data = await res.json();
  S.words = data.words || [];
  S.byId = new Map(S.words.map(w => [w.id, w]));
  buildLessons();
}

function syncQueueWords() {
  S.queue = S.queue.map(w => S.byId.get(w.id) || w);
}

const PART_META = {
  '1': { label: 'Part 1', title: '核心词 · 抓核心' },
  '2': { label: 'Part 2', title: '基础词 · 刷基础' },
  '3': { label: 'Part 3', title: '扩展词 · 扩词量' },
};

function letterGroup(c) {
  if (c < 'a' || c > 'z') return '其他';
  if (c <= 'c') return 'A–C';
  if (c <= 'f') return 'D–F';
  if (c <= 'j') return 'G–J';
  if (c <= 'o') return 'K–O';
  if (c <= 's') return 'P–S';
  return 'T–Z';
}

function lessonKey(w) {
  const p = String(w.part || '1');
  if (p === '3') return `3.${letterGroup((w.word || 'a').toLowerCase()[0])}`;
  return `${p}.${w.lesson || '0'}`;
}

function lessonLabel(l) {
  if (!l) return '';
  if (l.part === 3) return `扩展词 ${l.group}`;
  return `Lesson ${l.lesson || ''}`;
}

function wordLocation(w) {
  const l = S.lessons.find(x => x.key === lessonKey(w));
  const label = l?.label || (String(w.part || '1') === '3'
    ? `扩展词 ${letterGroup((w.word || 'a')[0].toLowerCase())}`
    : `Lesson ${w.lesson || ''}`);
  return w.seq ? `${label} · 第${w.seq}词` : label;
}

function buildLessons() {
  const map = new Map();
  for (const w of S.words) {
    const k = lessonKey(w);
    if (!map.has(k)) {
      const part = +(w.part || '1');
      map.set(k, {
        key: k, part,
        unit: w.unit || 0, lesson: w.lesson || 0,
        group: part === 3 ? letterGroup((w.word || 'a').toLowerCase()[0]) : '',
        words: [],
      });
    }
    map.get(k).words.push(w);
  }
  S.lessons = [...map.values()].sort((a, b) =>
    a.part - b.part || (a.part === 3 ? a.group.localeCompare(b.group) : a.lesson - b.lesson));
  for (const l of S.lessons) {
    l.known = l.words.filter(w => S.known[w.id] === 1).length;
    l.unknown = l.words.filter(w => S.known[w.id] === 2).length;
    l.label = lessonLabel(l);
  }
}

/* ---------- API ---------- */
async function apiSave(changes) {
  const res = await fetch('/api/save', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ changes }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || '保存失败');
  const hint = $('#save-hint');
  hint.textContent = '✓ 已保存';
  hint.classList.add('show');
  setTimeout(() => hint.classList.remove('show'), 1600);
}
async function apiAdd(word) {
  const res = await fetch('/api/add', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(word),
  });
  return res.json();
}
async function apiDelete(id) {
  const res = await fetch('/api/delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  return res.json();
}

/* ---------- 视图切换 ---------- */
function show(view) {
  $('#quick-mask').hidden = true;
  for (const v of ['home', 'study', 'manage', 'stats', 'words', 'game', 'reading', 'settings']) {
    $(`#view-${v}`).hidden = v !== view;
  }
  if (view !== 'game' && window.WordGames) WordGames.onHide();
  if (view !== 'reading' && window.WordReading) WordReading.onHide();
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'study') {
    document.body.classList.add('studying');
    layoutStudy();
  } else {
    document.body.classList.remove('studying');
  }
  if (view === 'home') renderHome();
  if (view === 'manage') renderManage();
  if (view === 'stats') renderStats();
  if (view === 'words') renderWordList();
  if (view === 'game' && window.WordGames) WordGames.onShow();
  if (view === 'reading' && window.WordReading) WordReading.onShow();
}

function syncTopbarHeight() {
  const h = document.querySelector('.topbar')?.offsetHeight || 56;
  document.documentElement.style.setProperty('--topbar-h', h + 'px');
  return h;
}

function layoutStudy() {
  const h = syncTopbarHeight();
  $('#view-study').style.height = `calc(100dvh - ${h}px)`;
}

/* ---------- 发音 ---------- */
let _ttsAudio = null;

function speak(text, rate = 1, forceYoudao = false) {
  if (!text) return;
  const accent = S.settings.accent || 'uk';
  if (accent === 'sys' && !forceYoudao) { speakSystem(text, rate); return; }
  // 有道词典在线发音: type=2 美音 / type=1 英音, 音质远优于系统合成
  const type = accent === 'uk' ? 1 : 2;
  const url = `https://dict.youdao.com/dictvoice?type=${type}&audio=${encodeURIComponent(text)}`;
  try {
    if (!_ttsAudio) _ttsAudio = new Audio();
    _ttsAudio.src = url;
    const p = _ttsAudio.play();
    if (p && p.catch) p.catch(() => speakSystem(text, rate));
  } catch (e) {
    speakSystem(text, rate);
  }
}

function speakSystem(text, rate) {
  if (!window.speechSynthesis) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = accentLang();
  u.rate = rate;
  speechSynthesis.speak(u);
}

function accentLang() {
  const a = S.settings.accent || 'uk';
  return a === 'us' ? 'en-US' : 'en-GB';
}

/* 音标显示跟随发音口音: 默认英音, 缺失时回退美音 */
function phoneticOf(w) {
  if (!w) return '';
  if ((S.settings.accent || 'uk') !== 'us' && w.phonetic_uk) return w.phonetic_uk;
  return w.phonetic || '';
}

/* ---------- 有道词典(经服务端代理, 避开浏览器 CORS) ---------- */
async function fetchYoudao(word) {
  if (!word) return null;
  try {
    const r = await fetch('/api/youdao?q=' + encodeURIComponent(word), { cache: 'no-store' });
    const j = await r.json();
    return j.ok ? j : null;
  } catch (e) {
    return null;
  }
}

/* 只补空字段, 不覆盖用户已填写内容 */
async function autoFillEmpty(patch) {
  if (!patch.word) return patch;
  if (patch.phonetic && patch.phonetic_uk && patch.meaning) return patch;
  const j = await fetchYoudao(patch.word);
  if (!j) return patch;
  if (!patch.phonetic_uk) patch.phonetic_uk = j.uk || j.us || '';
  if (!patch.phonetic) patch.phonetic = j.us || j.uk || '';
  if (!patch.meaning) patch.meaning = j.meaning || '';
  return patch;
}

/* ---------- 首页渲染 ---------- */
function renderHome() {
  buildLessons();
  const total = S.words.length;
  const kCount = Object.values(S.known).filter(v => v === 1).length;
  const uCount = Object.values(S.known).filter(v => v === 2).length;
  const sCount = starredCount();
  $('#stats-row').innerHTML = `
    <div class="stat-box"><div class="num">${total}</div><div class="lbl">总词条</div></div>
    <div class="stat-box ok"><div class="num">${kCount}</div><div class="lbl">已认识</div></div>
    <div class="stat-box bad clickable" data-list="unknown" title="点击查看不认识的单词"><div class="num">${uCount}</div><div class="lbl">不认识 <span class="stat-go">›</span></div></div>
    <div class="stat-box star clickable" data-list="starred" title="点击查看已收藏的单词"><div class="num">${sCount}</div><div class="lbl">已收藏 <span class="stat-go">›</span></div></div>
    <div class="stat-box"><div class="num">${S.lessons.length}</div><div class="lbl">分组数</div></div>`;

  // Part 标签栏
  const parts = [...new Set(S.lessons.map(l => l.part))].sort();
  if (parts.length && !parts.includes(+S.currentPart)) S.currentPart = String(parts[0]);
  $('#part-tabs').innerHTML = parts.map(p => {
    const meta = PART_META[p] || { label: `Part ${p}`, title: '' };
    const cnt = S.lessons.filter(l => l.part === p).reduce((s, l) => s + l.words.length, 0);
    return `<button class="part-tab ${S.currentPart == p ? 'active' : ''}" data-part="${p}">
      <span class="pt-label">${meta.label}</span>
      <span class="pt-sub">${meta.title}</span>
      <span class="pt-count">${cnt} 词</span>
    </button>`;
  }).join('');
  $('#part-tabs').onclick = (e) => {
    const b = e.target.closest('.part-tab');
    if (!b) return;
    S.currentPart = b.dataset.part;
    renderHome();
  };
  $('#part-title').textContent = (PART_META[S.currentPart] || {}).title || '选择 Lesson';

  // 当前 Part 的 Lesson 列表
  const shown = S.lessons.filter(l => l.part === +S.currentPart);
  const grid = $('#lesson-grid');
  grid.innerHTML = shown.map(l => {
    const done = l.known + l.unknown;
    const pct = l.words.length ? Math.round(done / l.words.length * 100) : 0;
    return `<div class="lesson-card ${S.selected.has(l.key) ? 'on' : ''}" data-key="${l.key}">
      <div class="lc-name">${esc(l.label)}<span class="lc-check">✔</span></div>
      <div class="lc-count">${l.words.length} 词 · 认识 ${l.known} · 生词 ${l.unknown}</div>
      <div class="lc-bar"><i style="width:${pct}%"></i></div>
    </div>`;
  }).join('');
  grid.onclick = (e) => {
    const card = e.target.closest('.lesson-card');
    if (!card) return;
    const k = card.dataset.key;
    S.selected.has(k) ? S.selected.delete(k) : S.selected.add(k);
    persistSel();
    renderHome();
    document.activeElement?.blur?.();
  };
  updateSelCount();
}

function updateSelCount() {
  let n = 0;
  for (const l of S.lessons) if (S.selected.has(l.key)) n += l.words.length;
  $('#sel-count').textContent = S.selected.size ? `已选 ${S.selected.size} 个 Lesson · ${n} 个词` : '未选择 Lesson';
  $('#btn-start').disabled = !S.selected.size;
}

function persistSel() {
  const st = store();
  st.selected = [...S.selected];
  saveStore(st);
}

/* ---------- 收藏 & 单词列表 ---------- */
function starredCount() {
  return Object.keys(S.starred).filter(id => S.byId.has(+id)).length;
}

function persistStar() {
  saveStore({ ...store(), starred: S.starred });
}

function openWordList(mode, from) {
  S.listMode = mode;
  S.listFrom = from || 'home';
  S.listPage = 1;
  S.listQ = '';
  S.listRevealed.clear();
  $('#wl-search').value = '';
  show('words');
}

const LIST_SIZES = [20, 50, 100, 150];

function unitKeyOf(w) {
  return `${w.part || 1}.${w.unit || 0}`;
}

function listWords() {
  let arr = S.listMode === 'starred'
    ? S.words.filter(w => S.starred[w.id])
    : S.words.filter(w => S.known[w.id] === 2);
  const q = S.listQ.trim().toLowerCase();
  if (q) arr = arr.filter(w =>
    (w.word || '').toLowerCase().includes(q) ||
    (w.meaning || '').includes(S.listQ.trim()) ||
    (w.example_en || '').toLowerCase().includes(q));
  if (S.settings.listGroupByUnit) {
    arr = [...arr].sort((a, b) =>
      (a.part || 1) - (b.part || 1) || (a.unit || 0) - (b.unit || 0) ||
      (a.page - b.page) || (a.id - b.id));
  }
  return arr;
}

function renderWordList() {
  const starred = S.listMode === 'starred';
  const maskOn = !!S.settings.listMask;
  const grouped = !!S.settings.listGroupByUnit;
  const size = LIST_SIZES.includes(S.listSize) ? S.listSize : 50;
  S.listSize = size;
  const all = listWords();

  // 控件状态
  $('#wl-mask-toggle').checked = maskOn;
  $('#wl-group').checked = grouped;
  document.querySelectorAll('#wl-sizes .wl-size-btn').forEach(b =>
    b.classList.toggle('on', +b.dataset.size === S.listSize));
  $('#wl-reveal-all').disabled = !maskOn;

  $('#wl-title').textContent = starred ? '★ 已收藏的单词' : '😵 不认识的单词';
  $('#wl-count').textContent = `${all.length} 个词`;
  $('#wl-study').textContent = starred ? '刷已收藏的单词 →' : '刷不认识的单词 →';
  $('#wl-study').disabled = !all.length;

  const pages = Math.max(1, Math.ceil(all.length / size));
  S.listPage = Math.min(S.listPage, pages);
  const slice = all.slice((S.listPage - 1) * size, S.listPage * size);

  // 分组词数(全部结果, 非当前页)
  const gcounts = {};
  if (grouped) for (const x of all) gcounts[unitKeyOf(x)] = (gcounts[unitKeyOf(x)] || 0) + 1;

  let lastGroup = null;
  const rows = [];
  for (const w of slice) {
    if (grouped) {
      const gk = unitKeyOf(w);
      if (gk !== lastGroup) {
        const [p, u] = gk.split('.');
        rows.push(`<div class="wl-group-head">Part ${esc(p)} · ${u === '0' ? '未分组' : 'Unit ' + esc(u)}<span>${gcounts[gk]} 词</span></div>`);
        lastGroup = gk;
      }
    }
    const l = S.lessons.find(x => x.key === lessonKey(w));
    const act = starred
      ? `<button class="wl-act" data-act="unstar" data-id="${w.id}" title="取消收藏">★ 取消收藏</button>`
      : `<button class="wl-act" data-act="known" data-id="${w.id}" title="标记为认识">✓ 标为认识</button>`;
    const revealed = S.listRevealed.has(w.id);
    const meaning = `<div class="wl-meaning${maskOn ? ' is-masked' : ''}${revealed ? ' revealed' : ''}" data-meaning="${w.id}" title="${maskOn && !revealed ? '点击显示词义' : ''}">
      <span class="wl-meaning-text">${esc((w.meaning || '').slice(0, 80))}</span>
      ${maskOn && !revealed ? '<span class="wl-mask">点击显示词义</span>' : ''}
    </div>`;
    rows.push(`<div class="mg-item wl-item" data-id="${w.id}">
      <span class="mi-word">${esc(w.word)}</span>
      <span class="mi-ph">${esc(phoneticOf(w))}</span>
      ${meaning}
      <span class="wl-lesson">${esc(l ? l.label : '')}</span>
      <button class="wl-speak" data-say="${esc(w.word)}" title="朗读单词">🔊</button>
      ${act}
    </div>`);
  }
  $('#wl-list').innerHTML = rows.join('') || `<div class="wl-empty">${starred
    ? '还没有收藏单词，刷词时点右上角「☆ 收藏」即可加入'
    : '暂时没有标记为「不认识」的单词'}</div>`;

  $('#wl-page-info').textContent = `${S.listPage} / ${pages} 页 · 共 ${all.length} 条`;
  $('#wl-first').disabled = $('#wl-prev').disabled = S.listPage <= 1;
  $('#wl-last').disabled = $('#wl-next').disabled = S.listPage >= pages;

  $('#wl-list').onclick = (e) => {
    const mean = e.target.closest('.wl-meaning');
    if (mean) {
      S.listRevealed.add(+mean.dataset.meaning);
      mean.classList.add('revealed');
      const mk = mean.querySelector('.wl-mask');
      if (mk) mk.remove();
      return;
    }
    const sp = e.target.closest('.wl-speak');
    if (sp) { speak(sp.dataset.say); return; }
    const act = e.target.closest('.wl-act');
    if (!act) return;
    const id = +act.dataset.id;
    if (act.dataset.act === 'unstar') {
      delete S.starred[id];
      persistStar();
      toast('已取消收藏');
    } else {
      S.known[id] = 1;
      saveStore({ ...store(), known: S.known });
      toast('已标为认识');
    }
    renderWordList();
  };
}

function toggleStar() {
  const w = curWord();
  if (!w) return;
  const on = !S.starred[w.id];
  if (on) S.starred[w.id] = 1; else delete S.starred[w.id];
  persistStar();
  renderStarBtn(w);
  renderFlags(w);
  toast(on ? '已收藏 ★' : '已取消收藏');
}

function renderStarBtn(w) {
  const on = !!S.starred[w.id];
  const b = $('#btn-star');
  b.classList.toggle('on', on);
  b.textContent = on ? '★ 已收藏' : '☆ 收藏';
}

function renderFlags(w) {
  const st = S.known[w.id];
  const flags = [];
  if (st === 1) flags.push('<span class="flag">已认识</span>');
  if (st === 2) flags.push('<span class="flag warn">不认识</span>');
  if (S.starred[w.id]) flags.push('<span class="flag star">★ 已收藏</span>');
  if (w.suspect) flags.push(`<span class="flag warn" title="${esc(w.suspect)}">待校对</span>`);
  if (w.no) flags.push(`<span class="flag info">#${esc(w.no)}</span>`);
  $('#w-flags').innerHTML = flags.join('');
}

/* ---------- 学习队列 ---------- */
// Fisher-Yates 洗牌，避免 sort(Math.random) 的分布偏差
function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 按徽标编组名重排：同编组连续出现，组内始终保持词库原顺序
function groupPoolByBadge(pool, randomGroups) {
  const groups = new Map();
  for (const w of pool) {
    const key = String(w.group || '').trim();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(w);
  }
  const entries = [...groups.entries()];
  if (randomGroups) {
    // 开启随机时只交换组的位置，组内顺序不变
    return shuffled(entries.map(e => e[1])).flat();
  }
  // 未开随机：编组名按中文拼音升序，无编组的放最后；组内仍保持原顺序
  entries.sort((a, b) => {
    if (!a[0] && b[0]) return 1;
    if (a[0] && !b[0]) return -1;
    return a[0].localeCompare(b[0], 'zh-Hans-CN');
  });
  return entries.flatMap(e => e[1]);
}

function startStudy(customPool, from) {
  let pool;
  if (Array.isArray(customPool)) {
    pool = [...customPool];
    S.studyFrom = from || 'list';
  } else {
    pool = [];
    for (const l of S.lessons) {
      if (!S.selected.has(l.key)) continue;
      pool.push(...l.words);
    }
    if (S.settings.unknownOnly) pool = pool.filter(w => S.known[w.id] !== 1);
    S.studyFrom = 'home';
  }
  if (!pool.length) { toast('没有可刷的单词'); return; }
  // 默认保持词库当前顺序(含手动交换/插入后的顺序)
  // 按编组刷词: 同编组连续出现、组内保序；随机顺序只交换组的位置
  if (S.settings.groupByBadge) {
    const groupCount = new Set(pool.map(w => String(w.group || '').trim())).size;
    pool = groupPoolByBadge(pool, S.settings.shuffle);
    toast(`已按 ${groupCount} 个编组排列${S.settings.shuffle ? '（组间随机）' : '（组内保持原顺序）'}`);
  } else if (S.settings.shuffle) pool = shuffled(pool);
  S.queue = pool;
  S.qi = 0;
  S.studyActive = true;
  show('study');
  renderCard();
}

function exitStudy() {
  S.studyActive = false;
  show(S.studyFrom === 'list' ? 'words' : 'home');
}

// 从其他菜单返回时, 回到正在进行的刷词会话而非选课页
function resumeOrHome() {
  if (S.studyActive && S.queue.length && S.qi < S.queue.length) {
    show('study');
    renderCard();
  } else {
    S.studyActive = false;
    show('home');
  }
}

function curWord() { return S.queue[S.qi]; }

function renderCard(opts = {}) {
  const w = curWord();
  if (!w) { finishStudy(); return; }
  const l = S.lessons.find(l => l.key === lessonKey(w));
  $('#study-lesson').innerHTML = `<span>${esc(lessonLabel(l))}${w.group ? ' · ' + esc(w.group) : ''}<i class="badge-edit" title="点击修改">✎</i></span>`;
  $('#study-pos').textContent = `${S.qi + 1} / ${S.queue.length}`;
  $('#study-progress').style.width = `${Math.round((S.qi) / S.queue.length * 100)}%`;

  // 词头
  $('#w-word').textContent = w.word || '(缺词)';
  $('#w-word').classList.remove('masked');
  $('#w-phonetic').textContent = phoneticOf(w);

  // 状态标记 + 收藏按钮
  const st = S.known[w.id];
  renderFlags(w);
  renderStarBtn(w);

  // 词义
  const posMatch = (w.meaning || '').match(/^\s*(n|v|adj|adv|prep|conj|pron|vt|vi|art|num|int(?:erj)?|abbr|pl)\s*[\.．、]/i);
  let mHtml = esc(w.meaning || '(无词义)');
  if (posMatch) {
    mHtml = `<span class="pos">${esc(posMatch[1])}.</span>` + esc(w.meaning.slice(posMatch[0].length));
  }
  $('#w-meaning').innerHTML = mHtml || '<span style="color:var(--ink-2)">（无词义，点编辑补充）</span>';

  // 记忆+例句
  const mem = [];
  for (const h of (w.hints || [])) {
    if (!h.text && !h.type) continue;
    mem.push(`<div class="hint-item"><span class="h-type">${esc(h.type)}</span>${esc(h.text)}</div>`);
  }
  if (w.example_en || w.example_zh) {
    mem.push(`<div class="example-box"><div class="ex-en">${esc(w.example_en)}<button class="speak-ex" data-say="${esc(w.example_en)}" title="朗读例句">🔊</button></div><div class="ex-zh">${esc(w.example_zh)}</div></div>`);
  }
  if ((w.derivatives || []).length) {
    mem.push(`<div class="deriv-box"><div class="h-type" style="color:var(--gold);font-weight:700;font-size:13px;margin-bottom:4px">派生词</div>${(w.derivatives||[]).map(d=>{
      const m = String(d).match(/^([A-Za-z'’\-\s]+?)(\s*\/[^/]+\/)?\s*(.*)$/);
      return `<div class="d-line"><span class="d-word">${esc(m?m[1]:d)}</span>${m&&m[2]?`<span class="d-ph">${esc(m[2])}</span>`:''} <span>${esc(m&&m[3]?m[3]:'')}</span></div>`;
    }).join('')}</div>`);
  }
  if (w.synonyms) mem.push(`<div class="syn-box"><span class="s-label">近/同</span>${esc(w.synonyms)}</div>`);
  $('#w-mem').innerHTML = mem.join('') || '<span style="color:var(--ink-2)">（无记忆内容）</span>';

  // 更多
  const extras = [];
  if (w.compare) extras.push(['辨析', w.compare]);
  if ((w.phrases || []).length) extras.push(['短语搭配', w.phrases.join('；')]);
  if ((w.notes || []).length) extras.push(['知识链接/备注', w.notes.join('\n')]);
  if ((w.related || []).length) extras.push(['同组词', w.related.join(' · ')]);
  const wrap = $('#w-extra-wrap');
  wrap.hidden = !extras.length;
  $('#w-extra').innerHTML = extras.map(([k, v]) =>
    `<div class="x-block"><div class="x-label">${k}</div><div class="x-body">${esc(v)}</div></div>`).join('');

  applyMask();
  bindSpeakEx();
  const knowB = $('#btn-known'), unkB = $('#btn-unknown');
  knowB.classList.toggle('dim', st === 1);
  unkB.classList.toggle('dim', st === 2);

  if (!opts.skipSpeak && S.settings.autoSpeak) speak(w.word);
  if (S.settings.autoReveal) revealAll();
  fitCard();
}

/* 自适应缩放: 词义/例句过多时等比缩小，保证一屏显示无需滚动 */
function fitCard() {
  const vp = $('#card-viewport');
  const card = $('#card');
  if (!vp || !card) return;
  card.style.zoom = '1';
  const avail = vp.clientHeight;
  const natural = card.offsetHeight;
  if (avail > 0 && natural > avail) {
    card.style.zoom = Math.max(0.5, avail / natural);
  }
}

function bindSpeakEx() {
  $$('.speak-ex').forEach(b => b.onclick = (e) => { e.stopPropagation(); speak(b.dataset.say, .95); });
}

/* ---------- 遮罩 ---------- */
function applyMask() {
  const wm = $('#mask-meaning'), wmem = $('#mask-mem'), pw = $('#part-word');
  const mode = S.settings.maskMode;
  [wm, wmem].forEach(el => el.classList.remove('blurred', 'revealed'));
  pw.classList.remove('word-masked');
  $('#w-word').classList.remove('masked');
  pw.onclick = null;
  wm.onclick = null;
  wmem.onclick = null;

  const clickReveal = (el) => el.onclick = () => { el.classList.add('revealed'); el.classList.remove('blurred'); };

  if (mode === 'none') {
    wm.classList.add('revealed'); wmem.classList.add('revealed');
  } else if (mode === 'both') {
    // 词义与记忆例句一起显示
    const revealBoth = () => { [wm, wmem].forEach(x => { x.classList.add('revealed'); x.classList.remove('blurred'); }); };
    wm.classList.add('blurred'); wmem.classList.add('blurred');
    wm.onclick = revealBoth; wmem.onclick = revealBoth;
  } else if (mode === 'separate') {
    wm.classList.add('blurred'); wmem.classList.add('blurred');
    clickReveal(wm); clickReveal(wmem);
  } else if (mode === 'mem-only') {
    wm.classList.add('revealed');
    wmem.classList.add('blurred');
    clickReveal(wmem);
  } else if (mode === 'word') {
    // 遮单词: 看意思回忆单词
    $('#w-word').classList.add('masked');
    $('#w-phonetic').textContent = '';
    pw.onclick = () => {
      $('#w-word').classList.remove('masked');
      $('#w-phonetic').textContent = phoneticOf(curWord());
    };
    wm.classList.add('revealed'); wmem.classList.add('revealed');
  }
}
function revealAll() {
  [$('#mask-meaning'), $('#mask-mem')].forEach(el => {
    el.classList.add('revealed');
    el.classList.remove('blurred');
    el.onclick = null;
  });
  $('#w-word').classList.remove('masked');
  if (S.settings.maskMode === 'word') $('#w-phonetic').textContent = phoneticOf(curWord());
}

/* ---------- 认识/翻页 ---------- */
function markKnown(v) {
  const w = curWord();
  if (!w) return;
  S.known[w.id] = v;
  const st = store();
  st.known = S.known;
  saveStore(st);
  renderCard();
  if (S.settings.autoNextKnown) setTimeout(next, 350);
}
function next() {
  if (S.qi < S.queue.length - 1) { S.qi++; renderCard(); }
  else finishStudy();
}
function prev() { if (S.qi > 0) { S.qi--; renderCard(); } }
function finishStudy() {
  const k = S.queue.filter(w => S.known[w.id] === 1).length;
  const u = S.queue.filter(w => S.known[w.id] === 2).length;
  toast(`本轮完成！认识 ${k} · 不认识 ${u}`, 3000);
  exitStudy();
}

/* ---------- 刷词快速修改 ---------- */
function openQuickEdit() {
  const w = curWord();
  if (!w) return;
  $('#q-word').value = w.word || '';
  $('#q-phonetic').value = w.phonetic || '';
  $('#q-phonetic-uk').value = w.phonetic_uk || '';
  $('#q-meaning').value = w.meaning || '';
  $('#q-group').value = w.group || '';
  $('#q-part').value = String(w.part || 1);
  $('#q-unit').value = w.unit || '';
  $('#q-lesson').value = w.lesson || '';
  $('#quick-mask').hidden = false;
  $('#q-word').focus();
}

function closeQuickEdit() {
  $('#quick-mask').hidden = true;
}

async function submitQuickEdit() {
  const w = curWord();
  if (!w) return;
  let patch = {
    word: $('#q-word').value.trim(),
    phonetic: $('#q-phonetic').value.trim(),
    phonetic_uk: $('#q-phonetic-uk').value.trim(),
    meaning: $('#q-meaning').value.trim(),
    group: $('#q-group').value.trim(),
    part: parseInt($('#q-part').value) || 1,
    unit: parseInt($('#q-unit').value) || '',
    lesson: parseInt($('#q-lesson').value) || '',
  };
  try {
    patch = await autoFillEmpty(patch);
    const id = w.id;
    await apiSave([{ id, patch }]);
    await loadWords();
    syncQueueWords();
    renderCard({ skipSpeak: true });
    closeQuickEdit();
    toast('已保存修改 ✓');
  } catch (e) {
    toast('保存失败: ' + e.message);
  }
}

/* ---------- 编辑弹窗 ---------- */
function openEdit(id, afterId) {
  const after = afterId ? S.byId.get(afterId) : null;
  const w = id ? S.byId.get(id)
    : { word: '', phonetic: '', meaning: '', hints: [], example_en: '', example_zh: '', derivatives: [], synonyms: '', phrases: [], compare: '', notes: [], unit: after?.unit ?? '', lesson: after?.lesson ?? '', part: after?.part ?? '' };
  if (!w) return;
  S.editingId = id || null;
  S.editingAfterId = afterId || null;
  $('#modal-title').textContent = id ? `编辑词条 #${id}` : (after ? `新增词条（插入到「${after.word}」之后）` : '新增词条');
  const hintsText = (w.hints || []).map(h => `${h.type ? h.type : ''}:${h.text || ''}`).join('\n');
  $('#modal-body').innerHTML = `
    <div class="two-col">
      <label>单词<input id="f-word" value="${esc(w.word)}"></label>
      <label>音标（英音 IPA · 默认显示）<input id="f-phonetic-uk" value="${esc(w.phonetic_uk || '')}"></label>
    </div>
    <label>音标（美音 IPA，可选）<input id="f-phonetic" value="${esc(w.phonetic)}"></label>
    <label>词义<input id="f-meaning" value="${esc(w.meaning)}"></label>
    <label>记忆提示（每行一条，格式 类型:内容，类型可为 谐音/联想/词根词缀/形近对照）<textarea id="f-hints">${esc(hintsText)}</textarea></label>
    <div class="two-col">
      <label>例句（英文）<textarea id="f-ex-en">${esc(w.example_en)}</textarea></label>
      <label>例句（中文）<textarea id="f-ex-zh">${esc(w.example_zh)}</textarea></label>
    </div>
    <div class="two-col">
      <label>派生词（每行一条）<textarea id="f-deriv">${esc((w.derivatives || []).join('\n'))}</textarea></label>
      <label>近/同义词<textarea id="f-syn">${esc(w.synonyms || '')}</textarea></label>
    </div>
    <div class="two-col">
      <label>短语搭配（每行一条）<textarea id="f-phrases">${esc((w.phrases || []).join('\n'))}</textarea></label>
      <label>辨析 / 备注<textarea id="f-extra">${esc([w.compare, (w.notes || []).join('\n')].filter(Boolean).join('\n'))}</textarea></label>
    </div>
    <div class="two-col">
      <label>Unit<input id="f-unit" value="${esc(w.unit ?? '')}"></label>
      <label>Lesson<input id="f-lesson" value="${esc(w.lesson ?? '')}"></label>
    </div>
    <label>Part
      <select id="f-part">
        <option value="1" ${(w.part ?? 1) == 1 ? 'selected' : ''}>Part 1 核心词</option>
        <option value="2" ${w.part == 2 ? 'selected' : ''}>Part 2 基础词</option>
        <option value="3" ${w.part == 3 ? 'selected' : ''}>Part 3 扩展词</option>
      </select>
    </label>`;
  $('#modal-delete').hidden = !id;
  $('#modal-mask').hidden = false;
  $('#f-word').focus();
}

async function submitEdit() {
  const parseHints = (txt) => txt.split('\n').map(s => s.trim()).filter(Boolean).map(line => {
    const i = line.indexOf(':') >= 0 ? line.indexOf(':') : line.indexOf('：');
    if (i > 0 && i <= 6) return { type: line.slice(0, i).trim(), text: line.slice(i + 1).trim() };
    return { type: '记忆', text: line };
  });
  const extraLines = $('#f-extra').value.split('\n').map(s => s.trim()).filter(Boolean);
  let patch = {
    word: $('#f-word').value.trim(),
    phonetic: $('#f-phonetic').value.trim(),
    phonetic_uk: $('#f-phonetic-uk').value.trim(),
    meaning: $('#f-meaning').value.trim(),
    hints: parseHints($('#f-hints').value),
    example_en: $('#f-ex-en').value.trim(),
    example_zh: $('#f-ex-zh').value.trim(),
    derivatives: $('#f-deriv').value.split('\n').map(s => s.trim()).filter(Boolean),
    synonyms: $('#f-syn').value.trim(),
    phrases: $('#f-phrases').value.split('\n').map(s => s.trim()).filter(Boolean),
    compare: extraLines[0] || '',
    notes: extraLines.slice(1),
    unit: parseInt($('#f-unit').value) || '',
    lesson: parseInt($('#f-lesson').value) || '',
    part: parseInt($('#f-part').value) || '',
  };
  try {
    patch = await autoFillEmpty(patch);
    if (S.editingId) {
      await apiSave([{ id: S.editingId, patch }]);
      await loadWords();
      syncQueueWords();
    } else {
      const r = await apiAdd({ ...patch, after: S.editingAfterId });
      await loadWords();
      syncQueueWords();
      S.mg.selectedId = r.id;
      toast(`已新增词条 #${r.id} · 本课第 ${r.seq} 个`);
    }
    $('#modal-mask').hidden = true;
    if (!$('#view-study').hidden) renderCard();
    if (!$('#view-manage').hidden) renderManage();
    if (!$('#view-home').hidden) renderHome();
  } catch (e) { toast('保存失败: ' + e.message); }
}

async function deleteCurrent() {
  if (!S.editingId) return;
  if (!confirm(`确定删除词条 "${S.byId.get(S.editingId)?.word}"？`)) return;
  const deletedId = S.editingId;
  await apiDelete(deletedId);
  await loadWords();
  syncQueueWords();
  $('#modal-mask').hidden = true;
  toast('已删除');
  renderManage(); renderHome();
  if (!$('#view-study').hidden) { S.queue = S.queue.filter(w => w.id !== deletedId); S.qi = Math.min(S.qi, Math.max(0, S.queue.length - 1)); renderCard(); }
}

/* ---------- 词库管理 ---------- */
function renderManage() {
  const sel = $('#mg-lesson');
  const cur = sel.value;
  sel.innerHTML = '<option value="">全部 Lesson</option>' +
    S.lessons.map(l => `<option value="${l.key}">${esc(l.label)} (${l.words.length})</option>`).join('');
  sel.value = cur;
  renderMgList();
}

function mgFiltered() {
  const q = S.mg.q.toLowerCase();
  let list = S.words;
  if (S.mg.lesson) {
    const l = S.lessons.find(x => x.key === S.mg.lesson);
    if (l) list = l.words;
  }
  if (q) list = list.filter(w =>
    (w.word || '').toLowerCase().includes(q) ||
    (w.meaning || '').includes(S.mg.q) ||
    (w.example_en || '').toLowerCase().includes(q) ||
    (w.example_zh || '').includes(S.mg.q));
  return list;
}

function renderMgList() {
  const list = mgFiltered();
  S.mg.size = S.listSize;
  document.querySelectorAll('#mg-sizes .wl-size-btn').forEach(b =>
    b.classList.toggle('on', +b.dataset.size === S.mg.size));
  const pages = Math.max(1, Math.ceil(list.length / S.mg.size));
  S.mg.page = Math.min(S.mg.page, pages);
  const slice = list.slice((S.mg.page - 1) * S.mg.size, S.mg.page * S.mg.size);
  $('#mg-list').innerHTML = slice.map(w => {
    const st = S.known[w.id];
    const sel = S.mg.selectedId === w.id ? ' selected' : '';
    return `<div class="mg-item${sel}" data-id="${w.id}">
      <span class="mi-drag" title="长按拖动排序" aria-hidden="true">⠿</span>
      <span class="mi-seq" title="本课序号">#${w.seq ?? ''}</span>
      <span class="mi-word">${esc(w.word)}</span>
      <span class="mi-ph">${esc(w.phonetic)}</span>
      <span class="mi-meaning">${esc((w.meaning || '').slice(0, 60))}</span>
      ${st === 1 ? '<span class="mi-badge k">认识</span>' : st === 2 ? '<span class="mi-badge u">生词</span>' : ''}
      <button class="mi-edit" data-id="${w.id}" title="编辑词条">✏️</button>
    </div>`;
  }).join('') || '<div style="color:var(--ink-2);text-align:center;padding:30px">无匹配词条</div>';
  $('#mg-page-info').dataset.base = `${S.mg.page} / ${pages} 页 · 共 ${list.length} 条`;
  updateMgSelection();

  // 单击只更新选中态(不重建 DOM, 否则双击无法触发)
  $('#mg-list').onclick = (e) => {
    if (suppressMgClick) return;
    const edit = e.target.closest('.mi-edit');
    if (edit) { openEdit(+edit.dataset.id); return; }
    const item = e.target.closest('.mg-item');
    if (!item) return;
    const id = +item.dataset.id;
    S.mg.selectedId = S.mg.selectedId === id ? null : id;
    updateMgSelection();
  };

  // 双击某行 = 在该词后方插入新词
  $('#mg-list').ondblclick = (e) => {
    if (suppressMgClick || e.target.closest('.mi-edit')) return;
    const item = e.target.closest('.mg-item');
    if (!item) return;
    window.getSelection()?.removeAllRanges();
    const id = +item.dataset.id;
    S.mg.selectedId = id;
    updateMgSelection();
    openEdit(null, id);
  };
}

/* ---------- 长按拖动排序 ---------- */
const MG_LONG_PRESS_MS = 380;
const MG_EDGE = 88;
const MG_MAX_SCROLL = 18;
let mgDrag = null;
let suppressMgClick = false;

function startMgPress(item, x, y, kind) {
  if (mgDrag || !item || !item.closest('#mg-list') || item.closest('button, input, select, a')) return;
  const rect = item.getBoundingClientRect();
  mgDrag = {
    kind, item, id: +item.dataset.id,
    startX: x, startY: y, pointerX: x, pointerY: y,
    offsetX: x - rect.left, offsetY: y - rect.top,
    active: false,
    timer: setTimeout(beginMgDrag, MG_LONG_PRESS_MS),
  };
  item.classList.add('mg-pressing');
}

function beginMgDrag() {
  const d = mgDrag;
  if (!d || d.active) return;
  const rect = d.item.getBoundingClientRect();
  const placeholder = document.createElement('div');
  placeholder.className = 'mg-drop-placeholder';
  placeholder.style.height = `${rect.height}px`;
  d.originalNext = d.item.nextElementSibling;
  d.item.parentNode.insertBefore(placeholder, d.item);
  d.placeholder = placeholder;
  d.originalOrder = [...$('#mg-list').querySelectorAll('.mg-item')].map(el => +el.dataset.id);
  d.lessonKey = lessonKey(S.byId.get(d.id));
  d.item.style.left = `${rect.left}px`;
  d.item.style.top = `${rect.top}px`;
  d.item.style.width = `${rect.width}px`;
  d.item.classList.remove('mg-pressing');
  d.item.classList.add('mg-dragging');
  d.active = true;
  document.body.classList.add('mg-drag-active');
  $('#mg-drag-cancel').hidden = false;
  updateMgCancelState(d.pointerX, d.pointerY);
  d.autoScrollRaf = requestAnimationFrame(autoScrollMg);
}

function isOverMgCancel(x, y) {
  const el = $('#mg-drag-cancel');
  if (!el || el.hidden) return false;
  const r = el.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

function updateMgCancelState(x, y) {
  const over = isOverMgCancel(x, y);
  $('#mg-drag-cancel').classList.toggle('over', over);
  return over;
}

function updateMgPlaceholder(y) {
  const d = mgDrag;
  if (!d?.active) return;
  const list = $('#mg-list');
  const sameLesson = [...list.querySelectorAll('.mg-item:not(.mg-dragging)')]
    .filter(el => lessonKey(S.byId.get(+el.dataset.id)) === d.lessonKey);
  let before = null;
  for (const el of sameLesson) {
    const r = el.getBoundingClientRect();
    if (y < r.top + r.height / 2) { before = el; break; }
  }
  if (before) {
    if (d.placeholder.nextElementSibling !== before) list.insertBefore(d.placeholder, before);
    return;
  }
  const last = sameLesson[sameLesson.length - 1];
  const after = last?.nextElementSibling || null;
  if (last && d.placeholder.nextElementSibling !== after) list.insertBefore(d.placeholder, after);
}

function autoScrollMg() {
  const d = mgDrag;
  if (!d?.active) return;
  if (isOverMgCancel(d.pointerX, d.pointerY)) {
    d.autoScrollRaf = requestAnimationFrame(autoScrollMg);
    return;
  }
  const vh = window.innerHeight;
  let dy = 0;
  if (d.pointerY < MG_EDGE) dy = -Math.ceil((MG_EDGE - d.pointerY) / MG_EDGE * MG_MAX_SCROLL);
  else if (d.pointerY > vh - MG_EDGE) dy = Math.ceil((d.pointerY - (vh - MG_EDGE)) / MG_EDGE * MG_MAX_SCROLL);
  if (dy) {
    const before = window.scrollY;
    window.scrollBy(0, dy);
    if (window.scrollY !== before) updateMgPlaceholder(d.pointerY);
  }
  d.autoScrollRaf = requestAnimationFrame(autoScrollMg);
}

function moveMgPress(x, y) {
  const d = mgDrag;
  if (!d) return;
  if (!d.active) {
    if (Math.hypot(x - d.startX, y - d.startY) > 9) cancelMgPress();
    return;
  }
  d.pointerX = x;
  d.pointerY = y;
  d.item.style.left = `${x - d.offsetX}px`;
  d.item.style.top = `${y - d.offsetY}px`;
  if (!updateMgCancelState(x, y)) updateMgPlaceholder(y);
}

function resetMgDragStyles(item, d) {
  if (d?.autoScrollRaf) cancelAnimationFrame(d.autoScrollRaf);
  const cancel = $('#mg-drag-cancel');
  cancel.hidden = true;
  cancel.classList.remove('over');
  item.classList.remove('mg-pressing', 'mg-dragging');
  item.style.left = item.style.top = item.style.width = '';
  document.body.classList.remove('mg-drag-active');
}

function cancelMgPress() {
  const d = mgDrag;
  if (!d) return;
  clearTimeout(d.timer);
  if (d.active) {
    if (d.originalNext?.parentNode) d.originalNext.parentNode.insertBefore(d.item, d.originalNext);
    else d.placeholder.parentNode.appendChild(d.item);
    d.placeholder.remove();
  }
  resetMgDragStyles(d.item, d);
  mgDrag = null;
}

function endMgPress() {
  const d = mgDrag;
  if (!d) return;
  clearTimeout(d.timer);
  if (!d.active) {
    d.item.classList.remove('mg-pressing');
    mgDrag = null;
    return;
  }
  if (isOverMgCancel(d.pointerX, d.pointerY)) {
    cancelMgPress();
    suppressMgClick = true;
    setTimeout(() => { suppressMgClick = false; }, 350);
    toast('已取消拖动，顺序未变');
    return;
  }
  const newOrder = [];
  for (const node of $('#mg-list').children) {
    if (node === d.item) continue;
    if (node === d.placeholder) { newOrder.push(d.id); continue; }
    if (!node.classList.contains('mg-item')) continue;
    const id = +node.dataset.id;
    if (lessonKey(S.byId.get(id)) === d.lessonKey) newOrder.push(id);
  }
  d.placeholder.parentNode.insertBefore(d.item, d.placeholder);
  d.placeholder.remove();
  resetMgDragStyles(d.item, d);
  mgDrag = null;
  suppressMgClick = true;
  setTimeout(() => { suppressMgClick = false; }, 350);
  if (d.originalOrder.join(',') !== newOrder.join(',')) saveMgOrder(newOrder, d.id, d.lessonKey);
}

async function saveMgOrder(visibleOrder, movedId, key) {
  const globalOrder = S.words.map(w => w.id);
  const without = globalOrder.filter(id => id !== movedId);
  const idx = visibleOrder.indexOf(movedId);
  const nextId = visibleOrder[idx + 1];
  const prevId = visibleOrder[idx - 1];
  let insertAt = nextId != null ? without.indexOf(nextId) : prevId != null ? without.indexOf(prevId) + 1 : idx;
  if (insertAt < 0) insertAt = without.length;
  without.splice(insertAt, 0, movedId);
  const lessonIds = without.filter(id => lessonKey(S.byId.get(id)) === key);
  try {
    const res = await fetch('/api/reorder', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: lessonIds }),
    });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || '排序保存失败');
    lessonIds.forEach((id, i) => { S.byId.get(id).seq = i + 1; });
    S.words = without.map(id => S.byId.get(id)).filter(Boolean);
    buildLessons();
    renderMgList();
    const hint = $('#save-hint');
    hint.textContent = '✓ 顺序已保存';
    hint.classList.add('show');
    setTimeout(() => hint.classList.remove('show'), 1600);
    toast('顺序已保存 ✓');
  } catch (e) {
    renderMgList();
    toast('排序保存失败: ' + e.message, 3000);
  }
}

function bindMgDrag() {
  const list = $('#mg-list');
  list.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' || e.button !== 0) return;
    const item = e.target.closest('.mg-item');
    if (item) startMgPress(item, e.clientX, e.clientY, 'pointer');
  });
  document.addEventListener('pointermove', (e) => {
    if (mgDrag?.kind === 'pointer') moveMgPress(e.clientX, e.clientY);
  }, { passive: false });
  document.addEventListener('pointerup', () => {
    if (mgDrag?.kind === 'pointer') endMgPress();
  });
  document.addEventListener('pointercancel', () => {
    if (mgDrag?.kind === 'pointer') cancelMgPress();
  });

  list.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { cancelMgPress(); return; }
    const item = e.target.closest('.mg-item');
    if (!item) return;
    const t = e.touches[0];
    startMgPress(item, t.clientX, t.clientY, 'touch');
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (mgDrag?.kind !== 'touch') return;
    const t = e.touches[0];
    if (t) moveMgPress(t.clientX, t.clientY);
    if (mgDrag?.active) e.preventDefault();
  }, { passive: false });
  document.addEventListener('touchend', (e) => {
    if (mgDrag?.kind !== 'touch') return;
    const t = e.changedTouches[0];
    if (t) moveMgPress(t.clientX, t.clientY);
    if (mgDrag?.kind === 'touch') endMgPress();
  }, { passive: false });
  document.addEventListener('touchcancel', () => {
    if (mgDrag?.kind === 'touch') cancelMgPress();
  }, { passive: true });
}

/* 局部刷新词库列表的选中态与提示(保持行节点不变) */
function updateMgSelection() {
  const selWord = S.mg.selectedId ? S.byId.get(S.mg.selectedId) : null;
  const base = $('#mg-page-info').dataset.base || '';
  $('#mg-page-info').textContent = base +
    (selWord ? ` · 已选中「${selWord.word}」，新增/双击将插入其后` : '');
  $$('#mg-list .mg-item').forEach(el =>
    el.classList.toggle('selected', +el.dataset.id === S.mg.selectedId));
}

/* ---------- 统计 ---------- */
function renderStats() {
  buildLessons();
  const total = S.words.length;
  const kCount = Object.values(S.known).filter(v => v === 1).length;
  const uCount = Object.values(S.known).filter(v => v === 2).length;
  const sCount = starredCount();
  $('#stats-row2').innerHTML = `
    <div class="stat-box"><div class="num">${total}</div><div class="lbl">总词条</div></div>
    <div class="stat-box ok"><div class="num">${kCount}</div><div class="lbl">认识</div></div>
    <div class="stat-box bad clickable" data-list="unknown" title="点击查看不认识的单词"><div class="num">${uCount}</div><div class="lbl">不认识 <span class="stat-go">›</span></div></div>
    <div class="stat-box star clickable" data-list="starred" title="点击查看已收藏的单词"><div class="num">${sCount}</div><div class="lbl">已收藏 <span class="stat-go">›</span></div></div>
    <div class="stat-box"><div class="num">${total ? Math.round((kCount + uCount) / total * 100) : 0}%</div><div class="lbl">已刷过</div></div>`;
  $('#stats-lessons').innerHTML = S.lessons.map(l => {
    const ok = l.known, bad = l.unknown, n = l.words.length;
    return `<div class="st-lesson">
      <div class="st-head"><span>${esc(l.label)}</span><span>${ok + bad}/${n} · 认识 ${ok} · 生词 ${bad}</span></div>
      <div class="st-bar"><span class="b-ok" style="width:${n ? ok / n * 100 : 0}%"></span><span class="b-bad" style="width:${n ? bad / n * 100 : 0}%"></span></div>
    </div>`;
  }).join('');
}

/* ---------- 导入/导出 ---------- */
function closeIoMenu() {
  $('#io-dropdown').hidden = true;
  $('#io-menu').classList.remove('open');
  $('#btn-io').setAttribute('aria-expanded', 'false');
}
function exportJson() {
  const payload = {
    source: 'export',
    words: S.words,
    progress: { known: S.known, starred: S.starred, settings: S.settings },
  };
  const blob = new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `words_backup_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
}
async function importJson(file) {
  try {
    const data = JSON.parse(await file.text());
    const words = data.words || data;
    if (!Array.isArray(words)) throw new Error('格式不对');
    // 按 id 更新/追加
    const changes = words.filter(w => w.id && S.byId.has(w.id)).map(w => ({ id: w.id, patch: w }));
    if (changes.length) await apiSave({ changes });
    // 备份中若含学习状态, 一并恢复
    let restored = false;
    if (data.progress) {
      if (data.progress.known) S.known = data.progress.known;
      if (data.progress.starred) S.starred = data.progress.starred;
      if (data.progress.settings) mergeSettings(data.progress.settings);
      saveStore({ ...store(), known: S.known, starred: S.starred, settings: S.settings });
      syncSettingsUI();
      restored = true;
    }
    toast(`已导入 ${changes.length} 条更新${restored ? '，并恢复收藏/进度' : ''}`);
    await loadWords();
    renderHome();
    if (!$('#view-words').hidden) renderWordList();
  } catch (e) { toast('导入失败: ' + e.message); }
}

function exportExcel() { window.location.href = '/api/export.xlsx'; }
function downloadExcelTemplate() { window.location.href = '/api/export.xlsx?template=1'; }
async function importExcel(file) {
  try {
    const buf = await file.arrayBuffer();
    const res = await fetch('/api/import.xlsx', {
      method: 'POST', headers: { 'Content-Type': 'application/vnd.ms-excel' }, body: buf,
    });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || '导入失败');
    toast(`Excel 导入完成：更新 ${j.updated} · 新增 ${j.added} · 跳过 ${j.skipped}`);
    await loadWords();
    renderHome();
    if (!$('#view-words').hidden) renderWordList();
  } catch (e) { toast('Excel 导入失败: ' + e.message, 4000); }
}

/* ---------- 事件绑定 ---------- */
function bind() {
  $$('.nav-btn').forEach(b => b.onclick = () => {
    // 「选课」按钮: 有进行中的刷词会话则回到该会话, 否则进入选课页
    if (b.dataset.view === 'home') resumeOrHome();
    else show(b.dataset.view);
  });
  $('#nav-home').onclick = resumeOrHome;
  $('#keys-groups').onclick = (e) => {
    const btn = e.target.closest('.key-bind');
    if (btn) startKeyCapture(btn);
  };
  $('#keys-reset').onclick = () => {
    S.settings.keys = cloneKeys(DEFAULT_KEYS);
    saveSettings();
    renderKeySettings();
    toast('已恢复默认按键');
  };
  $('#btn-back').onclick = exitStudy;
  $('#btn-start').onclick = () => startStudy();

  // 统计卡点击进入单词列表(事件委托, 容器不变)
  ['#stats-row', '#stats-row2'].forEach(sel => {
    $(sel).onclick = (e) => {
      const box = e.target.closest('.stat-box[data-list]');
      if (box) openWordList(box.dataset.list, sel === '#stats-row2' ? 'stats' : 'home');
    };
  });

  // 单词列表: 收藏 / 不认识
  $('#wl-back').onclick = () => show(S.listFrom);
  $('#wl-search').oninput = (e) => { S.listQ = e.target.value; S.listPage = 1; S.listRevealed.clear(); renderWordList(); };
  const wlPage = (n) => { S.listPage = n; S.listRevealed.clear(); renderWordList(); };
  $('#wl-prev').onclick = () => { if (S.listPage > 1) wlPage(S.listPage - 1); };
  $('#wl-next').onclick = () => { if (S.listPage < Math.ceil(listWords().length / S.listSize)) wlPage(S.listPage + 1); };
  $('#wl-first').onclick = () => wlPage(1);
  $('#wl-last').onclick = () => wlPage(Math.max(1, Math.ceil(listWords().length / S.listSize)));
  const setPageSize = (size) => {
    if (!LIST_SIZES.includes(size) || size === S.listSize) return;
    S.listSize = size;
    S.mg.size = size;
    S.settings.listSize = size;
    saveSettings();
    S.listPage = 1; S.mg.page = 1;
    S.listRevealed.clear();
    renderWordList();
    if (!$('#view-manage').hidden) renderMgList();
  };
  $('#wl-sizes').onclick = (e) => {
    const b = e.target.closest('.wl-size-btn');
    if (b) setPageSize(+b.dataset.size);
  };
  $('#mg-sizes').onclick = (e) => {
    const b = e.target.closest('.wl-size-btn');
    if (b) setPageSize(+b.dataset.size);
  };
  $('#wl-mask-toggle').onchange = (e) => {
    S.settings.listMask = e.target.checked;
    S.listRevealed.clear();
    saveSettings();
    renderWordList();
  };
  $('#wl-group').onchange = (e) => {
    S.settings.listGroupByUnit = e.target.checked;
    S.listPage = 1;
    S.listRevealed.clear();
    saveSettings();
    renderWordList();
  };
  $('#wl-reveal-all').onclick = () => {
    listWords().slice((S.listPage - 1) * S.listSize, S.listPage * S.listSize)
      .forEach(w => S.listRevealed.add(w.id));
    renderWordList();
  };
  $('#wl-study').onclick = () => startStudy(listWords(), 'list');

  $('#sel-all').onclick = () => { S.lessons.forEach(l => S.selected.add(l.key)); persistSel(); renderHome(); };
  $('#sel-none').onclick = () => { S.selected.clear(); persistSel(); renderHome(); };
  $('#sel-unk').onclick = () => {
    S.selected.clear();
    S.lessons.forEach(l => { if (l.unknown > 0) S.selected.add(l.key); });
    persistSel(); renderHome();
  };
  $('#sel-reset').onclick = resetProgress;

  $('#opt-shuffle').onchange = (e) => { S.settings.shuffle = e.target.checked; saveSettings(); };
  $('#opt-group-badge').onchange = (e) => { S.settings.groupByBadge = e.target.checked; saveSettings(); };
  $('#opt-unknown-only').onchange = (e) => { S.settings.unknownOnly = e.target.checked; saveSettings(); };
  $('#opt-mask-mode').onchange = (e) => { S.settings.maskMode = e.target.value; saveSettings(); renderCard(); };
  $('#opt-auto-speak').onchange = (e) => { S.settings.autoSpeak = e.target.checked; saveSettings(); if (e.target.checked) speak(curWord()?.word); };
  $('#opt-auto-reveal').onchange = (e) => { S.settings.autoReveal = e.target.checked; saveSettings(); if (e.target.checked) revealAll(); };
  $('#opt-auto-next-known').onchange = (e) => { S.settings.autoNextKnown = e.target.checked; saveSettings(); };
  $('#opt-accent').onchange = (e) => {
    S.settings.accent = e.target.value;
    saveSettings();
    if (!$('#view-study').hidden) {
      $('#w-phonetic').textContent = phoneticOf(curWord());
      if ($('#opt-auto-speak').checked) speak(curWord()?.word);
    }
  };

  $('#btn-speak').onclick = () => speak(curWord()?.word);
  $('#btn-known').onclick = () => markKnown(1);
  $('#btn-unknown').onclick = () => markKnown(2);
  $('#btn-next').onclick = next;
  $('#btn-prev').onclick = prev;
  $('#btn-edit-current').onclick = () => openEdit(curWord()?.id);
  $('#btn-star').onclick = toggleStar;
  $('#study-lesson').onclick = openQuickEdit;

  $('#quick-close').onclick = $('#quick-cancel').onclick = closeQuickEdit;
  $('#quick-save').onclick = submitQuickEdit;
  $('#quick-mask').onclick = (e) => { if (e.target === $('#quick-mask')) closeQuickEdit(); };
  $('#quick-full').onclick = () => { closeQuickEdit(); openEdit(curWord()?.id); };

  $('#mg-search').oninput = (e) => { S.mg.q = e.target.value; S.mg.page = 1; renderMgList(); };
  $('#mg-lesson').onchange = (e) => { S.mg.lesson = e.target.value; S.mg.page = 1; renderMgList(); };
  $('#mg-prev').onclick = () => { if (S.mg.page > 1) { S.mg.page--; renderMgList(); } };
  $('#mg-next').onclick = () => { S.mg.page++; renderMgList(); };
  $('#mg-add').onclick = () => openEdit(null, S.mg.selectedId);
  bindMgDrag();

  $('#btn-reset-progress').onclick = resetProgress;

  $('#btn-export').onclick = exportJson;
  $('#btn-import').onclick = () => $('#import-file').click();
  $('#import-file').onchange = (e) => { if (e.target.files[0]) importJson(e.target.files[0]); e.target.value = ''; };
  $('#btn-export-xlsx').onclick = exportExcel;
  $('#btn-template-xlsx').onclick = downloadExcelTemplate;
  $('#btn-import-xlsx').onclick = () => $('#import-xlsx-file').click();
  $('#import-xlsx-file').onchange = (e) => { if (e.target.files[0]) importExcel(e.target.files[0]); e.target.value = ''; };

  const ioMenu = $('#io-menu');
  $('#btn-io').onclick = (e) => {
    e.stopPropagation();
    const willOpen = $('#io-dropdown').hidden;
    $('#io-dropdown').hidden = !willOpen;
    ioMenu.classList.toggle('open', willOpen);
    $('#btn-io').setAttribute('aria-expanded', String(willOpen));
  };
  $('#io-dropdown').addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.target.closest('button')) closeIoMenu();
  });
  document.addEventListener('click', (e) => {
    if (!ioMenu.contains(e.target)) closeIoMenu();
  });

  $('#modal-close').onclick = $('#modal-cancel').onclick = () => $('#modal-mask').hidden = true;
  $('#modal-youdao').onclick = async () => {
    const word = $('#f-word').value.trim();
    if (!word) { toast('请先填写单词'); return; }
    toast('正在查询有道…');
    const j = await fetchYoudao(word);
    if (!j) { toast('未查到该词'); return; }
    let n = 0;
    if (!$('#f-phonetic-uk').value.trim() && j.uk) { $('#f-phonetic-uk').value = j.uk; n++; }
    if (!$('#f-phonetic').value.trim() && j.us) { $('#f-phonetic').value = j.us; n++; }
    if (!$('#f-meaning').value.trim() && j.meaning) { $('#f-meaning').value = j.meaning; n++; }
    toast(n ? `已补全 ${n} 项 ✓（保存后生效）` : '没有需要补全的空字段');
  };
  $('#modal-save').onclick = submitEdit;
  $('#modal-delete').onclick = deleteCurrent;
  $('#modal-mask').onclick = (e) => { if (e.target === $('#modal-mask')) $('#modal-mask').hidden = true; };

  // 键盘快捷键
  document.addEventListener('keydown', (e) => {
    if (!$('#modal-mask').hidden) {
      if (e.key === 'Escape') $('#modal-mask').hidden = true;
      return;
    }
    if (!$('#quick-mask').hidden) {
      if (e.key === 'Escape') closeQuickEdit();
      else if (e.key === 'Enter' && e.target.tagName === 'INPUT') submitQuickEdit();
      return;
    }
    if (capturingKeyAction) {
      e.preventDefault();
      if (e.key === 'Escape') finishKeyCapture();
      else if (!['Control', 'Alt', 'Meta', 'Shift'].includes(e.key)) finishKeyCapture(normalizeKeyEvent(e));
      return;
    }
    if (mgDrag) { if (e.key === 'Escape') cancelMgPress(); return; }
    if (!$('#io-dropdown').hidden && e.key === 'Escape') { closeIoMenu(); return; }
    // 首页选中课程 / 列表页, 按自定义键进入刷词
    if (keyMatches('start', e)) {
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return;
      if (!$('#view-home').hidden) { e.preventDefault(); startStudy(); return; }
      if (!$('#view-words').hidden) { e.preventDefault(); startStudy(listWords(), 'list'); return; }
    }
    // 小游戏页 / 阅读理解页交给各自模块处理
    if (!$('#view-game').hidden && window.WordGames && WordGames.onKey(e)) return;
    if (!$('#view-reading').hidden && window.WordReading && WordReading.onKey(e)) return;
    if ($('#view-study').hidden) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    if (keyMatches('reveal', e)) { e.preventDefault(); revealAll(); }
    else if (keyMatches('next', e)) { e.preventDefault(); next(); }
    else if (keyMatches('prev', e)) { e.preventDefault(); prev(); }
    else if (keyMatches('known', e)) { e.preventDefault(); markKnown(1); }
    else if (keyMatches('unknown', e)) { e.preventDefault(); markKnown(2); }
    else if (keyMatches('speak', e)) { e.preventDefault(); speak(curWord()?.word); }
    else if (keyMatches('star', e)) { e.preventDefault(); toggleStar(); }
    else if (keyMatches('quickEdit', e)) { e.preventDefault(); openQuickEdit(); }
  });
}

function resetProgress() {
  if (!confirm('确定清空所有认识/不认识记录？')) return;
  S.known = {};
  saveStore({ ...store(), known: {} });
  toast('学习进度已清空');
  renderHome(); renderStats();
}

function saveSettings() {
  const st = store();
  st.settings = S.settings;
  saveStore(st);
}

function renderKeySettings() {
  const box = $('#keys-groups');
  if (!box) return;
  box.innerHTML = KEY_GROUPS.map(g => `
    <div class="key-group">
      <h3>${esc(g.title)}</h3>
      ${g.actions.map(([id, label]) => {
        const keys = S.settings.keys?.[id] || DEFAULT_KEYS[id] || [];
        const caps = keys.map(k => `<kbd>${esc(keyLabel(k))}</kbd>`).join('<span> / </span>');
        return `<div class="key-row" data-action="${id}">
          <span class="key-label">${esc(label)}</span>
          <span class="key-values">${caps || '<span style="color:var(--bad)">未设置</span>'}</span>
          <button class="ghost-btn key-bind" data-action="${id}" type="button">修改</button>
        </div>`;
      }).join('')}
    </div>`).join('');
}

function startKeyCapture(btn) {
  $$('.key-bind.capturing').forEach(b => { b.classList.remove('capturing'); b.textContent = '修改'; });
  capturingKeyAction = btn.dataset.action;
  btn.classList.add('capturing');
  btn.textContent = '按键…';
  toast('请按下新按键（Esc 取消）');
}

function finishKeyCapture(key) {
  if (!capturingKeyAction) return;
  const action = capturingKeyAction;
  capturingKeyAction = null;
  if (key === undefined) { renderKeySettings(); toast('已取消按键捕获'); return; }
  S.settings.keys[action] = key ? [key] : [];
  saveSettings();
  renderKeySettings();
  toast(key ? '按键已更新' : '已清除该按键');
}

/* ---------- 启动 ---------- */
function syncSettingsUI() {
  $('#opt-shuffle').checked = S.settings.shuffle;
  $('#opt-group-badge').checked = !!S.settings.groupByBadge;
  $('#opt-unknown-only').checked = S.settings.unknownOnly;
  $('#opt-mask-mode').value = S.settings.maskMode;
  $('#opt-auto-speak').checked = S.settings.autoSpeak;
  $('#opt-auto-reveal').checked = S.settings.autoReveal;
  $('#opt-auto-next-known').checked = S.settings.autoNextKnown;
  $('#opt-accent').value = S.settings.accent || 'uk';
  $('#wl-mask-toggle').checked = !!S.settings.listMask;
  $('#wl-group').checked = !!S.settings.listGroupByUnit;
  S.listSize = LIST_SIZES.includes(+S.settings.listSize) ? +S.settings.listSize : 50;
  S.settings.listSize = S.listSize;
  S.mg.size = S.listSize;
  document.querySelectorAll('.wl-size-btns .wl-size-btn').forEach(b =>
    b.classList.toggle('on', +b.dataset.size === S.listSize));
  renderKeySettings();
}

async function init() {
  await loadState();
  const st = store();
  S.known = st.known || {};
  S.starred = st.starred || {};
  mergeSettings(st.settings || {});
  // 一次性迁移: 默认口音改为英音(之后用户手动切换会被尊重)
  // 状态加载失败时不做迁移写入, 避免空状态覆盖已有进度
  if (!st.accentV2 && !STATE_LOAD_FAILED) {
    S.settings.accent = 'uk';
    saveStore({ ...store(), accentV2: true, settings: S.settings });
  }
  if (st.selected) S.selected = new Set(st.selected);
  syncSettingsUI();

  syncTopbarHeight();
  window.addEventListener('load', syncTopbarHeight);
  window.addEventListener('resize', () => {
    syncTopbarHeight();
    if (!$('#view-study').hidden) fitCard();
  });
  bind();
  // 向小游戏模块注入依赖(不暴露内部变量,保持低耦合)
  if (window.WordGames) WordGames.init({
    esc,
    toast,
    speak,
    speakYoudao: (text) => speak(text, 1, true),
    phoneticOf,
    getWords: () => S.words,
    getKnown: () => S.known,
    getStarred: () => S.starred,
    getGames: () => store().games || {},
    saveGames: (games) => saveStore({ ...store(), games }),
    matchKey: (action, e) => keyMatches(action, e),
    openReading: () => show('reading'),
  });
  if (window.WordReading) WordReading.init({
    esc,
    toast,
    speak,
    fetchYoudao,
    getWords: () => S.words,
    getKnown: () => S.known,
    wordLocation,
    matchKey: (action, e) => keyMatches(action, e),
    openGame: () => show('game'),
    getArticles: () => store().articles || [],
    saveArticles: (list) => saveStore({ ...store(), articles: list }),
  });
  try {
    await loadWords();
  } catch (e) {
    toast('词库加载失败，请确认 server.py 已启动', 4000);
    return;
  }
  renderHome();
}
init();
