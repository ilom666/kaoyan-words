/* ===== 刷单词 · 前端逻辑 ===== */
'use strict';

/* ---------- 工具 ---------- */
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LS_KEY = 'shuacidan_progress_v1';

function toast(msg, ms = 1800) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._tm);
  t._tm = setTimeout(() => t.hidden = true, ms);
}

function store() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; }
  catch { return {}; }
}
function saveStore(obj) { localStorage.setItem(LS_KEY, JSON.stringify(obj)); }

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
  settings: { maskMode: 'both', autoSpeak: false, autoReveal: false, autoNextKnown: false, shuffle: false, unknownOnly: false, accent: 'uk', listMask: true, listGroupByUnit: false, listSize: 50 },
  mg: { q: '', lesson: '', page: 1, size: 50, selectedId: null, swapMode: false, swapSel: [] },
  editingId: null,
  editingAfterId: null,
};

/* ---------- 数据加载 ---------- */
async function loadWords() {
  const res = await fetch('/api/words', { cache: 'no-store' });
  const data = await res.json();
  S.words = data.words || [];
  S.byId = new Map(S.words.map(w => [w.id, w]));
  buildLessons();
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
  for (const v of ['home', 'study', 'manage', 'stats', 'words', 'game', 'reading']) {
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

function speak(text, rate = 1) {
  if (!text) return;
  const accent = S.settings.accent || 'uk';
  if (accent === 'sys') { speakSystem(text, rate); return; }
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

const LIST_SIZES = [10, 20, 50, 100, 200];

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
  $('#wl-size').value = String(S.listSize);
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
  // 保持词库当前顺序(含手动交换/插入后的顺序), 仅在开启随机时打乱
  if (S.settings.shuffle) pool = [...pool].sort(() => Math.random() - .5);
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
  if (v === 1 && S.settings.autoNextKnown) setTimeout(next, 350);
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
    await apiSave([{ id: w.id, patch }]);
    Object.assign(w, patch);
    buildLessons();
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
      Object.assign(S.byId.get(S.editingId), patch);
    } else {
      const r = await apiAdd({ ...patch, after: S.editingAfterId });
      S.mg.selectedId = r.id;
      await loadWords();
      toast(`已新增词条 #${r.id}`);
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
  await apiDelete(S.editingId);
  await loadWords();
  $('#modal-mask').hidden = true;
  toast('已删除');
  renderManage(); renderHome();
  if (!$('#view-study').hidden) { S.queue = S.queue.filter(w => w.id !== S.editingId); S.qi = Math.min(S.qi, Math.max(0, S.queue.length - 1)); renderCard(); }
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
  const pages = Math.max(1, Math.ceil(list.length / S.mg.size));
  S.mg.page = Math.min(S.mg.page, pages);
  const slice = list.slice((S.mg.page - 1) * S.mg.size, S.mg.page * S.mg.size);
  $('#mg-list').innerHTML = slice.map(w => {
    const st = S.known[w.id];
    const sel = S.mg.selectedId === w.id ? ' selected' : '';
    const si = S.mg.swapSel.indexOf(w.id);
    const swapCls = si >= 0 ? ` swap-picked swap-${si === 0 ? 'a' : 'b'}` : '';
    const tag = S.mg.swapMode
      ? `<span class="swap-tag">${si >= 0 ? (si === 0 ? 'A' : 'B') : '○'}</span>` : '';
    return `<div class="mg-item${sel}${swapCls}" data-id="${w.id}">
      ${tag}
      <span class="mi-word">${esc(w.word)}</span>
      <span class="mi-ph">${esc(w.phonetic)}</span>
      <span class="mi-meaning">${esc((w.meaning || '').slice(0, 60))}</span>
      ${st === 1 ? '<span class="mi-badge k">认识</span>' : st === 2 ? '<span class="mi-badge u">生词</span>' : ''}
      <button class="mi-edit" data-id="${w.id}" title="编辑词条">✏️</button>
    </div>`;
  }).join('') || '<div style="color:var(--ink-2);text-align:center;padding:30px">无匹配词条</div>';
  $('#mg-page-info').dataset.base = `${S.mg.page} / ${pages} 页 · 共 ${list.length} 条`;
  updateMgSelection();
  updateSwapUI();

  // 单击: 交换模式下依次选 A/B; 普通模式只更新选中态(不重建 DOM, 否则双击无法触发)
  $('#mg-list').onclick = (e) => {
    const edit = e.target.closest('.mi-edit');
    if (edit) { openEdit(+edit.dataset.id); return; }
    const item = e.target.closest('.mg-item');
    if (!item) return;
    const id = +item.dataset.id;
    if (S.mg.swapMode) {
      const arr = S.mg.swapSel;
      const i = arr.indexOf(id);
      if (i >= 0) arr.splice(i, 1);
      else if (arr.length < 2) arr.push(id);
      else { arr.shift(); arr.push(id); }
      renderMgList();
      return;
    }
    S.mg.selectedId = S.mg.selectedId === id ? null : id;
    updateMgSelection();
  };

  // 双击某行 = 在该词后方插入新词(交换模式下禁用, 避免误触发)
  $('#mg-list').ondblclick = (e) => {
    if (S.mg.swapMode) return;
    if (e.target.closest('.mi-edit')) return;
    const item = e.target.closest('.mg-item');
    if (!item) return;
    window.getSelection()?.removeAllRanges();
    const id = +item.dataset.id;
    S.mg.selectedId = id;
    updateMgSelection();
    openEdit(null, id);
  };
}

/* ---------- 交换两行位置 ---------- */
function updateSwapUI() {
  const on = !!S.mg.swapMode;
  const [a, b] = S.mg.swapSel;
  const wa = a ? S.byId.get(a) : null;
  const wb = b ? S.byId.get(b) : null;
  $('#mg-swap-mode').textContent = on ? '✕ 退出交换' : '⇅ 交换位置';
  $('#mg-swap-mode').classList.toggle('active', on);
  $('#mg-swap-do').hidden = !on;
  $('#mg-swap-do').disabled = S.mg.swapSel.length !== 2;
  $('#mg-tip').innerHTML = on
    ? `💡 <b>交换模式</b>：依次点击两行（可跨页），A ${wa ? `「${esc(wa.word)}」` : '未选'} · B ${wb ? `「${esc(wb.word)}」` : '未选'}，选好后点「交换选中两行」`
    : '💡 单击选中 · <b>双击任意行 = 在其后插入新词</b> · 点 ✏️ 编辑 · 选中后点「+ 新增词条」效果相同';
}

function toggleSwapMode() {
  S.mg.swapMode = !S.mg.swapMode;
  S.mg.swapSel = [];
  renderMgList();
  toast(S.mg.swapMode ? '交换模式：请依次点击两行' : '已退出交换模式');
}

async function swapSelected() {
  if (S.mg.swapSel.length !== 2) return;
  const [a, b] = S.mg.swapSel;
  const ia = S.words.findIndex(w => w.id === a);
  const ib = S.words.findIndex(w => w.id === b);
  if (ia < 0 || ib < 0) { toast('词条不存在'); return; }
  try {
    const res = await fetch('/api/swap', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idA: a, idB: b }),
    });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || '交换失败');
    [S.words[ia], S.words[ib]] = [S.words[ib], S.words[ia]];
    buildLessons();
    S.mg.swapSel = [];
    renderMgList();
    const hint = $('#save-hint');
    hint.textContent = '✓ 顺序已保存';
    hint.classList.add('show');
    setTimeout(() => hint.classList.remove('show'), 1600);
    toast('已交换两行位置 ✓');
  } catch (e) {
    toast('交换失败: ' + e.message);
  }
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
      if (data.progress.settings) Object.assign(S.settings, data.progress.settings);
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

/* ---------- 事件绑定 ---------- */
function bind() {
  $$('.nav-btn').forEach(b => b.onclick = () => {
    // 「选课」按钮: 有进行中的刷词会话则回到该会话, 否则进入选课页
    if (b.dataset.view === 'home') resumeOrHome();
    else show(b.dataset.view);
  });
  $('#nav-home').onclick = resumeOrHome;
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
  $('#wl-size').onchange = (e) => {
    S.listSize = LIST_SIZES.includes(+e.target.value) ? +e.target.value : 50;
    S.settings.listSize = S.listSize;
    saveSettings();
    S.listPage = 1; S.listRevealed.clear(); renderWordList();
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
  $('#mg-swap-mode').onclick = toggleSwapMode;
  $('#mg-swap-do').onclick = swapSelected;

  $('#btn-reset-progress').onclick = resetProgress;

  $('#btn-export').onclick = exportJson;
  $('#btn-import').onclick = () => $('#import-file').click();
  $('#import-file').onchange = (e) => { if (e.target.files[0]) importJson(e.target.files[0]); e.target.value = ''; };

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
    // 首页选中课程 / 列表页, 按 Enter 进入刷词
    if (e.key === 'Enter') {
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return;
      if (!$('#view-home').hidden) { e.preventDefault(); startStudy(); return; }
      if (!$('#view-words').hidden) { e.preventDefault(); startStudy(listWords(), 'list'); return; }
    }
    // 小游戏页: 交给游戏模块处理(答题数字键 / Esc 退出 / E 朗读)
    if (!$('#view-game').hidden && window.WordGames && WordGames.onKey(e)) return;
    // AI 阅读理解页: 交给阅读模块处理(Esc 返回)
    if (!$('#view-reading').hidden && window.WordReading && WordReading.onKey(e)) return;
    if ($('#view-study').hidden) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') { e.preventDefault(); revealAll(); }
    else if (e.key === 'ArrowRight' || e.key === 'n') next();
    else if (e.key === 'ArrowLeft' || e.key === 'p') prev();
    else if (e.key === '1') markKnown(1);
    else if (e.key === '2') markKnown(2);
    else if (e.key.toLowerCase() === 'e') speak(curWord()?.word);
    else if (e.key.toLowerCase() === 's') toggleStar();
    else if (e.key.toLowerCase() === 'q') openQuickEdit();
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

/* ---------- 启动 ---------- */
function syncSettingsUI() {
  $('#opt-shuffle').checked = S.settings.shuffle;
  $('#opt-unknown-only').checked = S.settings.unknownOnly;
  $('#opt-mask-mode').value = S.settings.maskMode;
  $('#opt-auto-speak').checked = S.settings.autoSpeak;
  $('#opt-auto-reveal').checked = S.settings.autoReveal;
  $('#opt-auto-next-known').checked = S.settings.autoNextKnown;
  $('#opt-accent').value = S.settings.accent || 'uk';
  $('#wl-mask-toggle').checked = !!S.settings.listMask;
  $('#wl-group').checked = !!S.settings.listGroupByUnit;
  S.listSize = LIST_SIZES.includes(+S.settings.listSize) ? +S.settings.listSize : 50;
  $('#wl-size').value = String(S.listSize);
}

async function init() {
  const st = store();
  S.known = st.known || {};
  S.starred = st.starred || {};
  Object.assign(S.settings, st.settings || {});
  // 一次性迁移: 默认口音改为英音(之后用户手动切换会被尊重)
  if (!st.accentV2) {
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
    phoneticOf,
    getWords: () => S.words,
    getKnown: () => S.known,
    getStarred: () => S.starred,
    openReading: () => show('reading'),
  });
  if (window.WordReading) WordReading.init({
    esc,
    toast,
    speak,
    fetchYoudao,
    getWords: () => S.words,
    getKnown: () => S.known,
    openGame: () => show('game'),
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
