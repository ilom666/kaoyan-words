/* ===== 单词小游戏 · 独立模块 =====
 * 通过依赖注入与主程序交互：只使用注入的 deps，不直接读写 app.js 的全局变量。
 * 这样游戏与刷词系统共享词库/进度/发音（业务耦合），但代码边界清晰、可单独维护（低耦合）。
 * 对外仅暴露 window.WordGames = { init, onShow, onHide, onKey }。
 */
(function () {
  'use strict';

  let D = null; // 依赖注入对象
  const E = (s) => D.esc(s);
  const LS_GAME = 'shuacidan_games_v1';

  // 游戏运行时状态（模块私有）
  const G = {
    game: 'quick',        // quick 快问快答 | listen 听音辨词
    scope: 'learned',     // learned 已学 | unknown 仅不认识 | starred 已收藏
    direction: 'zh2en',   // zh2en 看中文选英文 | en2zh 看英文选中文（仅 quick）
    total: 10,            // 每局题数
    perQ: 10,             // 每题秒数
    questions: [],
    idx: 0,
    score: 0,
    combo: 0,
    maxCombo: 0,
    correct: 0,
    wrongList: [],
    timeLeft: 0,
    timer: null,
    phase: 'menu',        // menu | playing | result
  };

  /* ---------- 依赖注入 ---------- */
  function init(deps) {
    D = deps;
    const root = document.getElementById('game-root');
    if (root) {
      // 事件委托：只绑一次，动态渲染的题目也能响应
      root.addEventListener('click', onClick);
    }
  }

  /* ---------- 题池与出题 ---------- */
  function learnedWords() {
    const all = D.getWords();
    let list;
    if (G.scope === 'unknown') {
      list = all.filter(w => D.getKnown()[w.id] === 2);
    } else if (G.scope === 'starred') {
      list = all.filter(w => D.getStarred()[w.id] === 1);
    } else {
      list = all.filter(w => D.getKnown()[w.id] === 1 || D.getKnown()[w.id] === 2);
    }
    return list.filter(w => (w.word || '').trim() && (w.meaning || '').trim());
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function sample(arr, n) {
    return shuffle(arr).slice(0, n);
  }

  function short(s, n) {
    s = String(s || '').trim();
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  // 为一题生成 4 个选项文本 + 正确下标；干扰项优先取同 Part，增加难度
  function makeOptions(correct, all, field) {
    const correctVal = field === 'word' ? correct.word.trim() : short(correct.meaning, 22);
    const samePart = all.filter(w => w.id !== correct.id && (w.part || '1') === (correct.part || '1'));
    const others = all.filter(w => w.id !== correct.id && w.word.trim() !== correct.word.trim());
    const pool = samePart.length >= 3 ? samePart : others;
    const distract = sample(pool.filter(w => {
      const v = field === 'word' ? w.word.trim() : short(w.meaning, 22);
      return v && v !== correctVal;
    }), 3).map(w => field === 'word' ? w.word.trim() : short(w.meaning, 22));

    // 去重后不足 3 个，从全库补齐
    const seen = new Set(distract);
    if (seen.size < 3) {
      for (const w of shuffle(others)) {
        const v = field === 'word' ? w.word.trim() : short(w.meaning, 22);
        if (v && !seen.has(v) && v !== correctVal) { distract.push(v); seen.add(v); }
        if (seen.size >= 3) break;
      }
    }
    const opts = shuffle([correctVal].concat(distract.slice(0, 3)));
    return { options: opts, answer: opts.indexOf(correctVal) };
  }

  function buildQuestions() {
    const pool = learnedWords();
    const all = D.getWords().filter(w => (w.word || '').trim() && (w.meaning || '').trim());
    const picked = sample(pool, Math.min(G.total, pool.length));
    return picked.map(w => {
      if (G.game === 'listen') {
        const mk = makeOptions(w, all, 'word');
        return { word: w, prompt: '🔊 点击播放，选出你听到的单词', options: mk.options, answer: mk.answer, field: 'word' };
      }
      if (G.direction === 'en2zh') {
        const mk = makeOptions(w, all, 'meaning');
        return { word: w, prompt: w.word, sub: D.phoneticOf(w), options: mk.options, answer: mk.answer, field: 'meaning' };
      }
      const mk = makeOptions(w, all, 'word');
      return { word: w, prompt: short(w.meaning, 60), sub: '选出对应的英文单词', options: mk.options, answer: mk.answer, field: 'word' };
    });
  }

  /* ---------- 流程控制 ---------- */
  function start() {
    const pool = learnedWords();
    if (pool.length < 1) {
      D.toast('还没有学过的单词，先去「选课」刷几个词再来玩吧～', 3500);
      return;
    }
    G.questions = buildQuestions();
    G.idx = 0; G.score = 0; G.combo = 0; G.maxCombo = 0;
    G.correct = 0; G.wrongList = []; G.phase = 'playing';
    renderQuestion();
    if (G.game === 'listen') speakCurrent();
  }

  function speakCurrent() {
    const q = G.questions[G.idx];
    if (q && q.word) D.speak(q.word.word);
  }

  function stopTimer() {
    if (G.timer) { clearInterval(G.timer); G.timer = null; }
  }

  function answer(choice) {
    if (G.phase !== 'playing' || !G.questions[G.idx]) return;
    stopTimer();
    const q = G.questions[G.idx];
    const ok = choice === q.answer;
    let gain = 0;
    if (ok) {
      G.combo++;
      G.maxCombo = Math.max(G.maxCombo, G.combo);
      G.correct++;
      gain = 100 + G.timeLeft * 10 + (G.combo - 1) * 20;
      G.score += gain;
    } else {
      G.combo = 0;
      G.score = Math.max(0, G.score - 50);
      G.wrongList.push({ word: q.word.word, meaning: q.word.meaning, picked: q.options[choice], right: q.options[q.answer] });
    }
    renderFeedback(ok, gain, choice);
    const timer = setTimeout(() => next(), ok ? 850 : 1500);
    G._advTimer = timer;
  }

  function next() {
    stopTimer();
    if (G.idx + 1 >= G.questions.length) { finish(); return; }
    G.idx++;
    renderQuestion();
    if (G.game === 'listen') speakCurrent();
  }

  function finish() {
    G.phase = 'result';
    stopTimer();
    const acc = G.questions.length ? Math.round(G.correct / G.questions.length * 100) : 0;
    const grade = acc >= 90 ? 'S' : acc >= 75 ? 'A' : acc >= 60 ? 'B' : acc >= 40 ? 'C' : 'D';
    const key = G.game + '_' + G.scope;
    let best = 0;
    try { best = JSON.parse(localStorage.getItem(LS_GAME) || '{}')[key] || 0; } catch { }
    if (G.score > best) {
      best = G.score;
      try {
        const all = JSON.parse(localStorage.getItem(LS_GAME) || '{}');
        all[key] = best;
        localStorage.setItem(LS_GAME, JSON.stringify(all));
      } catch { }
    }
    renderResult(grade, acc, best);
  }

  function abort() {
    stopTimer();
    if (G._advTimer) { clearTimeout(G._advTimer); G._advTimer = null; }
    G.phase = 'menu';
    renderMenu();
  }

  function tick() {
    if (G.phase !== 'playing') return;
    G.timeLeft--;
    const bar = document.getElementById('game-timebar');
    const num = document.getElementById('game-time');
    if (num) num.textContent = G.timeLeft + 's';
    if (bar) {
      bar.style.width = (G.timeLeft / G.perQ * 100) + '%';
      bar.style.background = G.timeLeft <= 3 ? 'var(--bad)' : G.timeLeft <= 6 ? 'var(--gold)' : 'var(--ok)';
    }
    if (G.timeLeft <= 0) answer(-1); // 超时按答错处理
  }

  /* ---------- 渲染 ---------- */
  function root() { return document.getElementById('game-root'); }

  function onShow() {
    if (G.phase === 'playing') { renderQuestion(); return; }
    if (G.phase === 'result') { renderResult(); return; }
    renderMenu();
  }

  function onHide() { stopTimer(); }

  function renderMenu() {
    const poolN = learnedWords().length;
    const known = D.getKnown();
    const unq = D.getWords().filter(w => known[w.id] === 2).length;
    const star = D.getWords().filter(w => D.getStarred()[w.id] === 1).length;
    let best = 0;
    try { best = JSON.parse(localStorage.getItem(LS_GAME) || '{}')[G.game + '_' + G.scope] || 0; } catch { }
    root().innerHTML = `
      <section class="panel game-panel">
        <h2 class="game-title">🎮 单词小游戏</h2>
        <p class="game-sub">从你学过的单词里出题，边玩边记 · 已学 <b>${poolN}</b> 词</p>

        <div class="game-cards">
          <button class="game-card ${G.game === 'quick' ? 'sel' : ''}" data-act="game" data-val="quick">
            <span class="game-card-ico">⚡</span>
            <span class="game-card-name">快问快答</span>
            <span class="game-card-desc">看释义/单词，限时四选一</span>
          </button>
          <button class="game-card ${G.game === 'listen' ? 'sel' : ''}" data-act="game" data-val="listen">
            <span class="game-card-ico">🎧</span>
            <span class="game-card-name">听音辨词</span>
            <span class="game-card-desc">听发音，选出正确的单词</span>
          </button>
        </div>

        <div class="game-config">
          <div class="game-config-row">
            <span class="game-config-label">出题范围</span>
            <div class="seg" id="game-scope">
              <button class="seg-btn ${G.scope === 'learned' ? 'on' : ''}" data-act="scope" data-val="learned">全部已学 (${poolN})</button>
              <button class="seg-btn ${G.scope === 'unknown' ? 'on' : ''}" data-act="scope" data-val="unknown">只刷不认识 (${unq})</button>
              <button class="seg-btn ${G.scope === 'starred' ? 'on' : ''}" data-act="scope" data-val="starred">已收藏 (${star})</button>
            </div>
          </div>
          <div class="game-config-row" id="game-dir-row" ${G.game === 'listen' ? 'hidden' : ''}>
            <span class="game-config-label">答题方向</span>
            <div class="seg" id="game-direction">
              <button class="seg-btn ${G.direction === 'zh2en' ? 'on' : ''}" data-act="direction" data-val="zh2en">看中文选英文</button>
              <button class="seg-btn ${G.direction === 'en2zh' ? 'on' : ''}" data-act="direction" data-val="en2zh">看英文选中文</button>
            </div>
          </div>
          <div class="game-config-row">
            <span class="game-config-label">题数 / 限时</span>
            <div class="seg" id="game-opts">
              ${[10, 20].map(n => `<button class="seg-btn ${G.total === n ? 'on' : ''}" data-act="total" data-val="${n}">${n} 题</button>`).join('')}
              ${[8, 15].map(s => `<button class="seg-btn ${G.perQ === s ? 'on' : ''}" data-act="perq" data-val="${s}">每题 ${s}s</button>`).join('')}
            </div>
          </div>
        </div>

        <div class="game-menu-foot">
          <span class="game-best">🏆 本模式最高分：<b>${best}</b></span>
          <button class="primary-btn big" data-act="start">开始游戏</button>
        </div>
        ${poolN === 0 ? '<p class="game-tip">提示：还没有已学单词。去「选课」刷词并标记认识/不认识后，就能在这里玩了。</p>' : ''}
      </section>`;
  }

  function renderQuestion() {
    const q = G.questions[G.idx];
    if (!q) return;
    G.timeLeft = G.perQ;
    root().innerHTML = `
      <section class="panel game-panel">
        <div class="game-hud">
          <span>第 <b>${G.idx + 1}</b> / ${G.questions.length} 题</span>
          <span class="game-hud-score">得分 <b id="game-score">${G.score}</b></span>
          <span class="game-hud-combo">连击 <b id="game-combo">×${G.combo}</b></span>
          <span class="game-hud-time">⏱ <b id="game-time">${G.timeLeft}s</b></span>
        </div>
        <div class="game-timebar-wrap"><i id="game-timebar" style="width:100%;background:var(--ok)"></i></div>

        <div class="game-question">
          ${q.sub && G.game === 'quick' && G.direction === 'en2zh' ? `<div class="game-q-phonetic">${E(q.sub)}</div>` : ''}
          <div class="game-q-main ${G.game === 'listen' || (G.game === 'quick' && G.direction === 'zh2en') ? 'small' : ''}">${E(q.prompt)}</div>
          ${G.game === 'listen' ? '<button class="game-replay" data-act="replay">🔊 再听一遍</button>' : ''}
        </div>

        <div class="game-options">
          ${q.options.map((o, i) => `<button class="game-opt" data-act="answer" data-i="${i}"><span class="game-opt-key">${i + 1}</span><span class="game-opt-text">${E(o)}</span></button>`).join('')}
        </div>
        <div class="game-keyhint">按键盘 <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd> 快速作答 · <kbd>Esc</kbd> 退出</div>
      </section>`;
    stopTimer();
    G.timer = setInterval(tick, 1000);
  }

  function renderFeedback(ok, gain, choice) {
    const q = G.questions[G.idx];
    document.querySelectorAll('.game-opt').forEach((el) => {
      const i = +el.dataset.i;
      el.disabled = true;
      if (i === q.answer) el.classList.add('right');
      else if (i === choice) el.classList.add('wrong');
    });
    const scoreEl = document.getElementById('game-score');
    const comboEl = document.getElementById('game-combo');
    if (scoreEl) scoreEl.textContent = G.score;
    if (comboEl) comboEl.textContent = '×' + G.combo;
    let tip = document.getElementById('game-feedback');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'game-feedback';
      tip.className = 'game-feedback';
      document.querySelector('.game-options').after(tip);
    }
    tip.className = 'game-feedback ' + (ok ? 'ok' : 'bad');
    tip.innerHTML = ok
      ? `✅ 答对了！+${gain}${G.combo > 1 ? ` · ${G.combo} 连击` : ''}`
      : `❌ 正确答案：${E(q.options[q.answer])} <span class="game-fb-word">${E(q.word.word)}</span>`;
    stopTimer();
  }

  function renderResult(grade, acc, best) {
    if (acc === undefined) {
      acc = G.questions.length ? Math.round(G.correct / G.questions.length * 100) : 0;
      grade = acc >= 90 ? 'S' : acc >= 75 ? 'A' : acc >= 60 ? 'B' : acc >= 40 ? 'C' : 'D';
      try { best = JSON.parse(localStorage.getItem(LS_GAME) || '{}')[G.game + '_' + G.scope] || 0; } catch { }
    }
    const wrongHtml = G.wrongList.length
      ? `<div class="game-wrong"><h3>错题回顾 <span>${G.wrongList.length}</span></h3>${G.wrongList.map(x => `
          <div class="game-wrong-row">
            <button class="icon-btn game-say" data-act="say" data-word="${E(x.word)}" title="朗读">🔊</button>
            <div><b>${E(x.word)}</b><div class="game-wrong-mean">${E(short(x.meaning, 80))}</div></div>
          </div>`).join('')}</div>`
      : '<p class="game-perfect">🎉 全对！太棒了！</p>';
    root().innerHTML = `
      <section class="panel game-panel">
        <div class="game-result">
          <div class="game-grade grade-${grade}">${grade}</div>
          <div class="game-result-main">
            <h2>本局结束</h2>
            <div class="game-result-stats">
              <div><b>${G.score}</b><span>得分</span></div>
              <div><b>${acc}%</b><span>正确率</span></div>
              <div><b>${G.correct}/${G.questions.length}</b><span>答对</span></div>
              <div><b>×${G.maxCombo}</b><span>最高连击</span></div>
            </div>
            <div class="game-result-best">🏆 最高分 ${best}</div>
          </div>
        </div>
        ${wrongHtml}
        <div class="game-menu-foot">
          <button class="ghost-btn" data-act="menu">返回菜单</button>
          <button class="primary-btn big" data-act="start">再来一局</button>
        </div>
      </section>`;
  }

  /* ---------- 事件 ---------- */
  function onClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const val = btn.dataset.val;
    if (act === 'game') {
      G.game = val;
      if (val === 'listen') renderMenu();
      else { document.getElementById('game-dir-row').hidden = false; renderMenu(); }
    } else if (act === 'scope') { G.scope = val; renderMenu(); }
    else if (act === 'direction') { G.direction = val; renderMenu(); }
    else if (act === 'total') { G.total = +val; renderMenu(); }
    else if (act === 'perq') { G.perQ = +val; renderMenu(); }
    else if (act === 'start') { if (G._advTimer) { clearTimeout(G._advTimer); G._advTimer = null; } start(); }
    else if (act === 'answer') { answer(+btn.dataset.i); }
    else if (act === 'replay') { speakCurrent(); }
    else if (act === 'say') { D.speak(btn.dataset.word); }
    else if (act === 'menu') { G.phase = 'menu'; renderMenu(); }
  }

  function onKey(e) {
    if (G.phase === 'playing') {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return false;
      if (['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault(); answer(+e.key - 1); return true;
      }
      if (e.key === 'Escape') { e.preventDefault(); abort(); return true; }
      if (e.key.toLowerCase() === 'e') { e.preventDefault(); speakCurrent(); return true; }
      return true; // 游戏进行中吞掉其他键，避免误触主程序快捷键
    }
    if (G.phase === 'result') {
      if (e.key === 'Escape') { e.preventDefault(); G.phase = 'menu'; renderMenu(); return true; }
      if (e.key === 'Enter') { e.preventDefault(); if (G._advTimer) clearTimeout(G._advTimer); start(); return true; }
      return true;
    }
    return false;
  }

  window.WordGames = { init, onShow, onHide, onKey };
})();
