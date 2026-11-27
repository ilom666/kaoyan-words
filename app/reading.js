/* ===== AI 阅读理解 · 独立模块 =====
 * 通过依赖注入与主程序交互，不直接读写 app.js / games.js 的内部变量。
 * 对外暴露 window.WordReading = { init, onShow, onHide, onKey, openMenu }。
 */
(function () {
  'use strict';

  let D = null;
  const E = (s) => D.esc(s);
  const LS_AI_KEY = 'shuacidan_ai_key';  // API Key 例外: 仅本地浏览器暂存

  const R = {
    phase: 'menu',        // menu | loading | result | list | error
    topic: '',
    length: 'medium',
    qCount: 3,
    key: '',
    remember: false,
    result: null,
    articleId: null,
    answers: {},
    transOpen: new Set(),
    qTransOpen: new Set(),
    showLocalWords: false,   // 查看界面：是否显示本文命中的本地词库单词
    seq: 0,
    pop: null,
  };

  function root() { return document.getElementById('reading-root'); }

  /* ---------- 依赖注入 ---------- */
  function init(deps) {
    D = deps;
    try {
      R.key = localStorage.getItem(LS_AI_KEY) || '';
      R.remember = !!R.key;
    } catch { }
    const el = root();
    if (el) {
      el.addEventListener('click', onClick);
      el.addEventListener('mouseup', onMouseUp);
    }
  }

  function openMenu() { R.phase = 'menu'; closePop(); renderMenu(); }
  function onShow() { renderMenu(); }
  function onHide() { closePop(); }

  function onKey(e) {
    const hit = (action) => D.matchKey ? D.matchKey(action, e) : false;
    if (hit('readingBack')) {
      e.preventDefault();
      if (R.pop) { closePop(); return true; }
      if (R.phase !== 'menu') { openMenu(); return true; }
      D.openGame();
      return true;
    }
    if (hit('readingAgain') && R.phase === 'result') { e.preventDefault(); generateReading(); return true; }
    return false;
  }

  /* ---------- 词库 / 存储 ---------- */
  function normalizeParagraphs(r) {
    if (!r) return [];
    if (Array.isArray(r.paragraphs) && r.paragraphs.length) {
      return r.paragraphs
        .filter(p => p && String(p.en || '').trim())
        .map(p => ({ en: String(p.en).trim(), zh: String(p.zh || '').trim() }));
    }
    const article = String(r.article || '').trim();
    if (!article) return [];
    const ens = article.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
    const zhAll = String(r.translation || '').trim();
    const zhs = zhAll ? zhAll.split(/\n\s*\n/).map(s => s.trim()) : [];
    return ens.map((en, i) => ({ en, zh: zhs[i] || (ens.length === 1 ? zhAll : '') }));
  }

  function loadSavedArticles() {
    const arr = D.getArticles();
    return Array.isArray(arr) ? arr : [];
  }

  function persistArticles(list) {
    D.saveArticles(list.slice(0, 50));
    return true;
  }

  function saveCurrentArticle(r) {
    const item = {
      id: Date.now(),
      title: String(r.title || '未命名阅读'),
      topic: R.topic || '',
      createdAt: Date.now(),
      paragraphs: normalizeParagraphs(r),
      questions: r.questions || [],
      used_words: r.used_words || [],
      vocab_size: r.vocab_size || 0,
      answers: {},
    };
    const list = loadSavedArticles();
    list.unshift(item);
    if (!persistArticles(list)) D.toast('文章已生成，但本机存储空间不足，未能保存', 3500);
    return item.id;
  }

  function syncSavedAnswers() {
    if (!R.articleId) return;
    const list = loadSavedArticles();
    const item = list.find(x => x.id === R.articleId);
    if (!item) return;
    item.answers = R.answers;
    persistArticles(list);
  }

  function openSavedArticle(id) {
    const item = loadSavedArticles().find(x => x.id === id);
    if (!item) { D.toast('这篇文章不存在或已被删除'); return; }
    closePop();
    R.result = item;
    R.answers = item.answers || {};
    R.articleId = item.id;
    R.transOpen = new Set();
    R.qTransOpen = new Set();
    R.phase = 'result';
    renderResult();
  }

  function deleteSavedArticle(id) {
    if (!window.confirm('确定删除这篇保存的文章？')) return;
    persistArticles(loadSavedArticles().filter(x => x.id !== id));
    renderList();
    D.toast('已删除');
  }

  /* ---------- 生成 ---------- */
  function captureInputs() {
    const topic = document.getElementById('ai-topic');
    if (topic) R.topic = topic.value.trim();
    const key = document.getElementById('ai-key');
    if (key) R.key = key.value.trim();
    const remember = document.getElementById('ai-remember');
    if (remember) R.remember = remember.checked;
  }

  async function generateReading() {
    captureInputs();
    const all = D.getWords();
    const learned = all.filter(w => D.getKnown()[w.id] === 1 || D.getKnown()[w.id] === 2);
    if (learned.length < 5) {
      D.toast('已学单词不足 5 个，先去刷几个词再来生成吧～', 3500);
      return;
    }
    try { localStorage.setItem(LS_AI_KEY, R.remember ? R.key : ''); } catch { }
    const picked = learned.slice().sort(() => Math.random() - 0.5).slice(0, 300).map(w => ({
      word: String(w.word || '').trim(),
      meaning: String(w.meaning || '').trim().slice(0, 40),
    }));
    const seq = (R.seq = (R.seq || 0) + 1);
    R.phase = 'loading';
    R.answers = {};
    closePop();
    renderLoading();
    let res;
    try {
      const resp = await fetch('/api/ai/reading', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: R.topic,
          length: R.length,
          questionCount: R.qCount,
          words: picked,
          apiKey: R.key,
        }),
      });
      res = await resp.json();
    } catch (e) {
      if (seq !== R.seq) return;
      renderError('连接本地服务失败，请确认 server.py 已启动。' + (e && e.message ? '（' + e.message + '）' : ''));
      return;
    }
    if (seq !== R.seq) return;
    if (!res || !res.ok) { renderError((res && res.error) || '生成失败，请稍后重试。'); return; }
    R.result = res;
    R.articleId = saveCurrentArticle(res);
    R.transOpen = new Set();
    R.qTransOpen = new Set();
    R.phase = 'result';
    renderResult();
  }

  /* ---------- 渲染 ---------- */
  function renderMenu() {
    const learned = D.getWords().filter(w => D.getKnown()[w.id] === 1 || D.getKnown()[w.id] === 2).length;
    root().innerHTML = `
      <section class="panel reading-panel">
        <div class="reading-head">
          <h2>🤖 AI 阅读理解</h2>
          <div class="reading-head-actions">
            <button class="ghost-btn" data-act="reading-back-game">🎮 返回小游戏</button>
            <button class="ghost-btn" data-act="reading-list">📚 已保存文章 (${loadSavedArticles().length})</button>
          </div>
        </div>
        <p class="reading-sub">用已学过的单词，让 AI 写一篇属于你的阅读理解 · 已学 <b>${learned}</b> 词</p>
        <div class="reading-config">
          <div class="game-config-row">
            <span class="game-config-label">文章主题（留空则随机）</span>
            <input id="ai-topic" class="ai-input" type="text" maxlength="120" placeholder="例如：大学生活、人工智能、环境保护" value="${E(R.topic)}">
          </div>
          <div class="game-config-row">
            <span class="game-config-label">文章长度</span>
            <div class="seg" id="ai-length">
              ${[['short', '约 150 词'], ['medium', '约 220 词'], ['long', '约 320 词']].map(([v, label]) => `<button class="seg-btn ${R.length === v ? 'on' : ''}" data-act="reading-length" data-val="${v}">${label}</button>`).join('')}
            </div>
          </div>
          <div class="game-config-row">
            <span class="game-config-label">题目数量</span>
            <div class="seg" id="ai-qcount">
              ${[3, 4, 5].map(n => `<button class="seg-btn ${R.qCount === n ? 'on' : ''}" data-act="reading-qcount" data-val="${n}">${n} 题</button>`).join('')}
            </div>
          </div>
          <details class="ai-key-box">
            <summary>DeepSeek API Key（可选）</summary>
            <input id="ai-key" class="ai-input" type="password" autocomplete="off" spellcheck="false" placeholder="留空则使用服务端环境变量 DEEPSEEK_API_KEY" value="${E(R.key)}">
            <label class="ai-remember"><input type="checkbox" id="ai-remember" ${R.remember ? 'checked' : ''}> 记住到本机浏览器（仅存 localStorage，不上传）</label>
          </details>
          <p class="ai-tip">从已学单词中最多取 300 个交给 AI，生成英文短文、逐段对照翻译和阅读理解题。阅读文章时，用鼠标拖动选中一个单词即可查看翻译。</p>
        </div>
        <div class="game-menu-foot">
          <span class="game-best">生成后自动保存到本机</span>
          <button class="primary-btn big" data-act="reading-generate">✨ 生成阅读</button>
        </div>
      </section>`;
  }

  function renderLoading() {
    root().innerHTML = `
      <section class="panel reading-panel">
        <div class="ai-loading">
          <div class="ai-spinner"></div>
          <h2 style="margin:0 0 8px">AI 正在写文章…</h2>
          <p class="ai-tip">正在用已学单词构思短文，一般需要 10~40 秒，请勿关闭页面。</p>
          <button class="ghost-btn" data-act="reading-back-menu" style="margin-top:14px">取消，返回菜单</button>
        </div>
      </section>`;
  }

  function renderError(msg) {
    root().innerHTML = `
      <section class="panel reading-panel">
        <div class="ai-error">
          <div style="font-size:34px;margin-bottom:8px">⚠️</div>
          <h2 style="margin:0 0 10px">生成失败</h2>
          <p class="ai-tip" style="color:var(--bad)">${E(msg)}</p>
          <div style="display:flex;gap:10px;justify-content:center;margin-top:18px;flex-wrap:wrap">
            <button class="ghost-btn" data-act="reading-back-menu">返回菜单</button>
            <button class="primary-btn" data-act="reading-generate">再试一次</button>
          </div>
        </div>
      </section>`;
  }

  function renderResult() {
    const r = R.result;
    if (!r) { openMenu(); return; }
    const paras = normalizeParagraphs(r);
    const used = r.used_words || [];
    const usedHtml = used.length
      ? `<div class="ai-used"><span>本文用到：</span>${used.map(w => `<button class="ai-chip" data-act="reading-say" data-word="${E(w)}">${E(w)}</button>`).join('')}</div>`
      : '';
    const localOn = R.showLocalWords;
    const escArticle = (s) => localOn ? highlightLocalWords(s) : E(s).replace(/\n/g, '<br>');
    const paraHtml = paras.map((p, i) => {
      const open = R.transOpen.has(i);
      return `<div class="ai-para">
        <div class="ai-para-en">${escArticle(p.en)}</div>
        ${p.zh ? `<button class="ai-trans-toggle${open ? ' open' : ''}" data-act="reading-para-trans" data-pi="${i}">${open ? '隐藏翻译' : '显示翻译'}</button>
        <div class="ai-para-zh" ${open ? '' : 'hidden'}>${E(p.zh).replace(/\n/g, '<br>')}</div>` : ''}
      </div>`;
    }).join('');
    root().innerHTML = `
      <section class="panel reading-panel">
        <div class="reading-head">
          <h2>📄 ${E(r.title)}</h2>
          <div class="reading-head-actions">
            <button class="ghost-btn" data-act="reading-back-game">🎮 返回小游戏</button>
            <button class="ghost-btn" data-act="reading-back-menu">返回菜单</button>
          </div>
        </div>
        <p class="reading-sub">拖动鼠标选中文章里的单词，即可查看翻译（优先本地词库）</p>
        <label class="ai-local-toggle"><input type="checkbox" id="ai-local-words" data-act="reading-local-toggle" ${localOn ? 'checked' : ''}> 在原文中标记本地词库单词（底纹）</label>
        <div class="ai-paper">
          <div class="ai-article">${paraHtml}</div>
          ${usedHtml}
        </div>
        <div class="ai-questions" id="ai-questions">${renderQuestions()}</div>
        <div class="game-menu-foot" style="margin-top:18px">
          <span class="game-best">词表 ${r.vocab_size || 0} 词 · 题目 ${(r.questions || []).length} 道 · 已自动保存到本机</span>
          <button class="primary-btn big" data-act="reading-generate">✨ 再生成一篇</button>
        </div>
      </section>`;
  }

  function renderQuestions() {
    const qs = (R.result && R.result.questions) || [];
    return `<h3>阅读理解（${qs.length} 题）</h3>` + qs.map((q, qi) => {
      const picked = R.answers[qi];
      const done = picked !== undefined;
      const opts = (q.options || []).map((o, oi) => {
        let cls = '';
        if (done) {
          if (oi === q.answer) cls = ' right';
          else if (oi === picked) cls = ' wrong';
        }
        return `<button class="ai-q-opt${cls}" data-act="reading-answer" data-qi="${qi}" data-oi="${oi}" ${done ? 'disabled' : ''}>${E(o)}</button>`;
      }).join('');
      const explain = done
        ? `<div class="ai-q-explain">${picked === q.answer ? '✅ 答对了。' : '❌ 答错了。'}参考答案：${E(q.options[q.answer] || '')}${q.explain ? ' · ' + E(q.explain) : ''}</div>`
        : '';
      const zhOpen = R.qTransOpen.has(qi);
      const zhHtml = q.question_zh
        ? `<button class="ai-trans-toggle${zhOpen ? ' open' : ''}" data-act="reading-qtrans" data-qi="${qi}">${zhOpen ? '隐藏题目翻译' : '显示题目翻译'}</button>
           <div class="ai-q-zh" ${zhOpen ? '' : 'hidden'}>${E(q.question_zh)}</div>`
        : '';
      return `<div class="ai-q">
        <div class="ai-q-title">${qi + 1}. ${E(q.question)}</div>
        ${zhHtml}
        <div class="ai-q-opts">${opts}</div>
        ${explain}
      </div>`;
    }).join('');
  }

  function answer(qi, oi) {
    if (R.answers[qi] !== undefined) return;
    R.answers[qi] = oi;
    const box = document.getElementById('ai-questions');
    if (box) box.innerHTML = renderQuestions();
    syncSavedAnswers();
  }

  function renderList() {
    const list = loadSavedArticles();
    root().innerHTML = `
      <section class="panel reading-panel">
        <div class="reading-head">
          <h2>📚 已保存文章（${list.length}）</h2>
          <div class="reading-head-actions">
            <button class="ghost-btn" data-act="reading-back-game">🎮 返回小游戏</button>
            <button class="ghost-btn" data-act="reading-back-menu">返回菜单</button>
          </div>
        </div>
        ${list.length ? list.map(x => `
          <div class="ai-saved-item">
            <div class="ai-saved-main">
              <b>${E(x.title)}</b>
              <div class="ai-saved-meta">${E(x.topic || '随机主题')} · ${new Date(x.createdAt).toLocaleString('zh-CN')} · ${(x.paragraphs || []).length} 段 · ${(x.questions || []).length} 题</div>
            </div>
            <button class="ghost-btn" data-act="reading-open" data-id="${x.id}">查看</button>
            <button class="ghost-btn danger" data-act="reading-del" data-id="${x.id}">删除</button>
          </div>`).join('') : '<p class="ai-tip">还没有保存的文章。生成后会自动保存在本机浏览器里。</p>'}
      </section>`;
  }

  /* ---------- 划词翻译 ---------- */
  function closePop() {
    if (!R.pop) return;
    R.pop.box.remove();
    R.pop.line.remove();
    R.pop = null;
  }

  function onMouseUp() {
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      const text = String(sel.toString() || '').trim();
      if (!/^[A-Za-z][A-Za-z'’-]{0,29}$/.test(text)) return;
      const anchor = sel.anchorNode;
      const el = anchor && (anchor.nodeType === 1 ? anchor : anchor.parentElement);
      if (!el || !el.closest || !el.closest('.ai-para-en')) return;
      const word = text.replace(/[’‘]/g, "'").toLowerCase();
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      showPop(word, rect);
    }, 0);
  }

  function normalizeWord(w) {
    const s = String(w || '').trim().toLowerCase();
    if (s.length > 4 && s.endsWith('ies')) return s.slice(0, -3) + 'y';
    if (s.length > 3 && /(ss|sh|ch|x)es$/.test(s)) return s.slice(0, -2);
    if (s.length > 3 && s.endsWith('es')) return s.slice(0, -1);
    if (s.length > 3 && s.endsWith('s') && !/(ss|us|is)$/.test(s)) return s.slice(0, -1);
    return s;
  }

  // 原文中命中本地词库的单词加底纹（保留原词形、标点与换行）
  function highlightLocalWords(text) {
    const byKey = new Map();
    D.getWords().forEach(w => {
      const key = normalizeWord(w.word);
      if (key) byKey.set(key, true);
    });
    const chunks = String(text || '').split(/([A-Za-z][A-Za-z'’-]{0,29})/);
    return chunks.map(part => {
      if (!/^[A-Za-z][A-Za-z'’-]{0,29}$/.test(part)) {
        return E(part).replace(/\n/g, '<br>');
      }
      const key = normalizeWord(part.replace(/[’‘]/g, "'"));
      const safe = E(part);
      return byKey.has(key) ? `<span class="ai-local-hit">${safe}</span>` : safe;
    }).join('');
  }

  async function lookupWord(word) {
    const words = D.getWords();
    const direct = words.find(w => String(w.word || '').trim().toLowerCase() === word);
    const hit = direct || words.find(w => normalizeWord(w.word) === normalizeWord(word));
    if (hit && String(hit.meaning || '').trim()) {
      const loc = D.wordLocation ? D.wordLocation(hit) : '';
      return {
        meaning: String(hit.meaning).trim(),
        phonetic: hit.phonetic_uk || hit.phonetic || '',
        source: '本地词库',
        location: loc,
      };
    }
    const j = await D.fetchYoudao(word);
    if (j && j.meaning) {
      return { meaning: j.meaning, phonetic: j.uk || j.us || '', source: '有道词典' };
    }
    return null;
  }

  function showPop(word, rect) {
    closePop();
    const mid = rect.left + rect.width / 2;
    const side = mid < window.innerWidth / 2 ? 'right' : 'left';
    const box = document.createElement('div');
    box.className = 'ai-word-pop ' + side;
    box.style.top = Math.round(Math.max(8, rect.top - 8)) + 'px';
    box.style.left = side === 'right'
      ? Math.round(rect.right + 12) + 'px'
      : Math.round(Math.max(8, rect.left - 224)) + 'px';
    box.innerHTML = `<div class="ai-word-pop-head">${E(word)}<span class="ai-word-src">查询中…</span></div><div class="ai-word-pop-body">正在查找翻译</div>`;
    const line = document.createElement('div');
    line.className = 'ai-word-line ' + side;
    line.style.top = Math.round(rect.top + rect.height / 2 - 1) + 'px';
    line.style.left = side === 'right' ? Math.round(rect.right + 1) + 'px' : Math.round(rect.left - 11) + 'px';
    document.body.appendChild(box);
    document.body.appendChild(line);
    R.pop = { box, line, word };
    lookupWord(word).then(info => {
      if (!R.pop || R.pop.word !== word) return;
      const body = box.querySelector('.ai-word-pop-body');
      const src = box.querySelector('.ai-word-src');
      if (info) {
        body.innerHTML = (info.phonetic ? `<div class="ai-word-ph">${E(info.phonetic)}</div>` : '')
          + `<div class="ai-word-mean">${E(info.meaning)}</div>`
          + (info.location ? `<div class="ai-word-loc">📍 ${E(info.location)}</div>` : '');
        src.textContent = info.source;
      } else {
        body.textContent = '未找到翻译';
        src.textContent = '本地词库 / 有道';
      }
    });
  }

  /* ---------- 事件 ---------- */
  function onClick(e) {
    if (R.pop && !e.target.closest('.ai-word-pop')) closePop();
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const val = btn.dataset.val;
    if (act === 'reading-back-game') { closePop(); D.openGame(); }
    else if (act === 'reading-back-menu') { R.seq++; openMenu(); }
    else if (act === 'reading-list') { R.phase = 'list'; renderList(); }
    else if (act === 'reading-length') { R.length = val; renderMenu(); }
    else if (act === 'reading-qcount') { R.qCount = +val; renderMenu(); }
    else if (act === 'reading-generate') { generateReading(); }
    else if (act === 'reading-local-toggle') {
      R.showLocalWords = btn.checked;
      if (R.result) renderResult();
    }
    else if (act === 'reading-open') { openSavedArticle(+btn.dataset.id); }
    else if (act === 'reading-del') { deleteSavedArticle(+btn.dataset.id); }
    else if (act === 'reading-answer') { answer(+btn.dataset.qi, +btn.dataset.oi); }
    else if (act === 'reading-say') { D.speak(btn.dataset.word); }
    else if (act === 'reading-para-trans') {
      const pi = +btn.dataset.pi;
      if (R.transOpen.has(pi)) R.transOpen.delete(pi); else R.transOpen.add(pi);
      const open = R.transOpen.has(pi);
      const zh = btn.parentElement.querySelector('.ai-para-zh');
      if (zh) zh.hidden = !open;
      btn.textContent = open ? '隐藏翻译' : '显示翻译';
      btn.classList.toggle('open', open);
    }
    else if (act === 'reading-qtrans') {
      const qi = +btn.dataset.qi;
      if (R.qTransOpen.has(qi)) R.qTransOpen.delete(qi); else R.qTransOpen.add(qi);
      const open = R.qTransOpen.has(qi);
      const zh = btn.parentElement.querySelector('.ai-q-zh');
      if (zh) zh.hidden = !open;
      btn.textContent = open ? '隐藏题目翻译' : '显示题目翻译';
      btn.classList.toggle('open', open);
    }
  }

  window.WordReading = { init, onShow, onHide, onKey, openMenu };
})();
