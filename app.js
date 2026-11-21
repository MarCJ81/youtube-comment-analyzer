/* ============================================================
   댓글 레이더 · app.js
   UI wiring: collection (YouTube API / demo / paste), dashboard,
   insights, exports. All state stays in this browser.
   ============================================================ */
(function () {
  'use strict';

  const C = window.CommentCore;
  const D = window.CommentData;
  const RC = window.RadarCopy || null;      // engines/radar-copy.js
  const B = window.AiBridge || null;        // engines/ai-bridge.js
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  const LS = {
    key: 'commentradar.v1.ytApiKey',
    legacyKey: 'radar.v1.ytApiKey',
    last: 'commentradar.v1.last',
    theme: 'commentradar.v1.theme',
    geminiKey: 'commentradar.v1.geminiKey',
    geminiModel: 'commentradar.v1.geminiModel',
    studioMode: 'commentradar.v1.studioMode',
    bundleSize: 'commentradar.v1.bundleSize',
  };
  const PAGE = 30;

  const state = {
    view: 'dashboard',
    mode: 'live',
    video: null,
    comments: [],
    demo: null,
    stats: null,
    keywords: [],
    faq: [],
    ideas: [],
    pinned: '',
    prompt: '',
    pinnedScore: null,
    ideaScores: [],
    filter: 'all',
    keyword: '',
    query: '',
    sort: 'likes',
    limit: PAGE,
    apiKey: '',
    busy: false,
    settings: { geminiKey: '', geminiModel: '' },
    studio: {
      mode: 'script',
      size: 6,
      bundle: null,
      prompt: '',
      promptInfo: null,
      cards: [],
      fw: 'PAS',
      fwResult: null,
      fwInit: false,
      geminiBusy: false,
    },
  };

  /* ── utils ─────────────────────────────────────────── */
  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function readLS(name) {
    try { return window.localStorage.getItem(name); } catch (e) { return null; }
  }
  function writeLS(name, value) {
    try { window.localStorage.setItem(name, value); return true; } catch (e) { return false; }
  }
  function removeLS(name) {
    try { window.localStorage.removeItem(name); } catch (e) { /* ignore */ }
  }
  function unquote(raw) {
    if (!raw) return '';
    let s = raw;
    if (s.charAt(0) === '"') {
      try { s = JSON.parse(s); } catch (e) { s = s.replace(/^"|"$/g, ''); }
    }
    return String(s || '').trim();
  }

  function toast(message, action) {
    const root = $('#toastRoot');
    if (!root) return;
    const el = document.createElement('div');
    el.className = 'toast';
    const text = document.createElement('span');
    text.textContent = message;
    el.appendChild(text);
    if (action && typeof action.run === 'function') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toast-action';
      btn.textContent = action.label || '되돌리기';
      btn.addEventListener('click', function () {
        try { action.run(); } catch (e) { /* ignore */ }
        el.remove();
      });
      el.appendChild(btn);
    }
    root.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .2s'; }, 3200);
    setTimeout(() => { el.remove(); }, 3500);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', 'readonly');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch (err) { return false; }
    }
  }

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 400);
  }

  function todayStamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  /* ── theme ─────────────────────────────────────────── */
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const btn = $('[data-action="toggle-theme"]');
    if (btn) btn.setAttribute('aria-label', theme === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환');
  }
  function initTheme() {
    const saved = readLS(LS.theme);
    if (saved === 'dark' || saved === 'light') applyTheme(saved);
    else applyTheme(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }
  function toggleTheme() {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    writeLS(LS.theme, next);
  }

  /* ── api key ───────────────────────────────────────── */
  function getKey() {
    const own = unquote(readLS(LS.key));
    if (own) return own;
    const legacy = unquote(readLS(LS.legacyKey));
    return legacy || '';
  }
  function setKey(key) {
    const prev = readLS(LS.key);
    const saved = writeLS(LS.key, JSON.stringify(key));
    if (!saved) { if (prev !== null) writeLS(LS.key, prev); return false; }
    state.apiKey = key;
    return true;
  }
  function clearKey() {
    removeLS(LS.key);
    state.apiKey = '';
  }
  function maskKey(key) {
    if (!key) return '';
    const tail = key.slice(-4);
    return '•••• •••• ' + tail;
  }
  function renderKeyState() {
    const has = !!state.apiKey;
    const dot = $('#apiDot');
    if (dot) dot.classList.toggle('on', has);
    const label = $('#apiButtonLabel');
    if (label) label.textContent = has ? 'API 연결됨' : 'API 키';
    const btn = $('#apiButton');
    if (btn) btn.classList.toggle('is-on', has);
    const hint = $('#keyHint');
    if (hint) {
      hint.className = 'hint' + (has ? '' : ' warn');
      hint.textContent = has
        ? 'API 키가 저장되어 있습니다. 링크를 넣고 [댓글 수집]을 누르면 실제 댓글을 가져옵니다.'
        : 'API 키가 없습니다. 데모 3종이나 붙여넣기로 먼저 체험할 수 있습니다.';
    }
  }

  /* ── data pipeline ─────────────────────────────────── */
  function analyze(comments) {
    const classified = C.classifyAll(comments);
    const stats = C.computeStats(classified);
    const keywords = C.topKeywords(classified, 15);
    const faq = C.buildFaq(classified, 3);
    const ideas = C.buildContentIdeas(classified, stats);
    const pinned = C.buildPinnedComment(state.video, stats, faq);
    const prompt = C.buildPrompt(state.video, classified, stats, faq, { maxComments: 50 });
    const pinnedScore = RC ? RC.scorePinned(pinned) : null;
    const ideaScores = RC ? ideas.map(idea => RC.scoreIdea(idea)) : [];
    return { comments: classified, stats, keywords, faq, ideas, pinned, prompt, pinnedScore, ideaScores };
  }

  function applyDataset(input, opts) {
    const o = opts || {};
    state.video = input.video;
    state.demo = input.demo || null;
    const built = analyze(input.comments || []);
    state.comments = built.comments;
    state.stats = built.stats;
    state.keywords = built.keywords;
    state.faq = built.faq;
    state.ideas = built.ideas;
    state.pinned = built.pinned;
    state.prompt = built.prompt;
    state.pinnedScore = built.pinnedScore;
    state.ideaScores = built.ideaScores;
    state.filter = 'all';
    state.keyword = '';
    state.query = '';
    state.limit = PAGE;
    const search = $('#feedSearch');
    if (search) search.value = '';
    const clear = $('.search-clear');
    if (clear) clear.hidden = true;
    if (!o.skipSave) saveLast();
    resetStudioResult();
    resetFwInputs();
    renderAll();
    rebuildStudio();
  }

  function resetFwInputs() {
    ['#fwProblem', '#fwSolution', '#fwProof'].forEach(function (sel) {
      const el = $(sel);
      if (el) el.value = '';
    });
    state.studio.fwInit = false;
  }

  function saveLast() {
    if (!state.video || !state.comments.length) return;
    const payload = {
      savedAt: new Date().toISOString(),
      video: state.video,
      demo: state.demo,
      comments: state.comments.map(c => ({
        id: c.id, author: c.author, text: c.text, likeCount: c.likeCount,
        replyCount: c.replyCount, publishedAt: c.publishedAt, source: c.source,
      })),
    };
    const text = JSON.stringify(payload);
    if (text.length > 3500000) return;
    writeLS(LS.last, text);
  }

  function loadLast() {
    const raw = readLS(LS.last);
    if (!raw) return false;
    try {
      const payload = JSON.parse(raw);
      if (!payload || !payload.video || !Array.isArray(payload.comments) || !payload.comments.length) return false;
      applyDataset(payload, { skipSave: true });
      return true;
    } catch (e) { return false; }
  }

  /* ── covers ────────────────────────────────────────── */
  function demoCoverSVG(demoKey, title, hook, compact) {
    const palette = {
      kitchen: ['#e81f5a', '#ff9a3d'],
      laptop: ['#7c5cff', '#2fb4d9'],
      money: ['#0f9488', '#7cb342'],
    };
    const pair = palette[demoKey] || ['#e81f5a', '#ff7a3d'];
    if (compact) {
      return '<svg viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice" role="img" aria-label="' + esc(title) + '">' +
        '<defs><linearGradient id="gc-' + esc(demoKey) + '" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0" stop-color="' + pair[0] + '"/><stop offset="1" stop-color="' + pair[1] + '"/></linearGradient></defs>' +
        '<rect width="320" height="180" fill="url(#gc-' + esc(demoKey) + ')"/>' +
        '<circle cx="268" cy="140" r="92" fill="rgba(0,0,0,.13)"/>' +
        '<path d="M96 52h128a15 15 0 0 1 15 15v60a15 15 0 0 1-15 15h-58l-34 26v-26h-36a15 15 0 0 1-15-15V67a15 15 0 0 1 15-15z" ' +
        'fill="rgba(255,255,255,.22)" stroke="#fff" stroke-width="7" stroke-linejoin="round"/>' +
        '<circle cx="132" cy="97" r="7" fill="#fff"/><circle cx="160" cy="97" r="7" fill="#fff"/><circle cx="188" cy="97" r="7" fill="#fff"/>' +
        '<text x="52" y="34" fill="#fff" font-size="17" font-weight="700" letter-spacing="2" font-family="PlexKR, sans-serif">DEMO</text>' +
      '</svg>';
    }
    const words = String(hook || title || '').split(' ');
    const lines = [];
    let line = '';
    words.forEach(w => {
      if ((line + ' ' + w).trim().length > 12) { if (line) lines.push(line.trim()); line = w; }
      else line = (line + ' ' + w).trim();
    });
    if (line) lines.push(line.trim());
    const text = lines.slice(0, 2).map((l, i) =>
      '<text x="20" y="' + (50 + i * 22) + '" fill="#ffffff" font-size="15" font-weight="700" font-family="PlexKR, sans-serif">' +
      esc(l) + '</text>').join('');
    return '<svg viewBox="0 0 320 100" preserveAspectRatio="xMidYMid slice" role="img" aria-label="' + esc(title) + '">' +
      '<defs><linearGradient id="g-' + esc(demoKey) + '" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="' + pair[0] + '"/><stop offset="1" stop-color="' + pair[1] + '"/></linearGradient></defs>' +
      '<rect width="320" height="100" fill="url(#g-' + esc(demoKey) + ')"/>' +
      '<circle cx="286" cy="82" r="62" fill="rgba(0,0,0,.13)"/>' +
      '<circle cx="308" cy="8" r="40" fill="rgba(255,255,255,.10)"/>' +
      '<rect x="236" y="14" width="48" height="17" rx="8.5" fill="rgba(0,0,0,.3)"/>' +
      '<text x="260" y="26" text-anchor="middle" fill="#fff" font-size="9" font-weight="700" letter-spacing="1" font-family="PlexKR, sans-serif">DEMO</text>' +
      text + '</svg>';
  }

  /* ── render: tabs ──────────────────────────────────── */
  function setView(view) {
    state.view = view;
    $$('.view').forEach(s => { s.hidden = s.id !== 'view-' + view; });
    $$('.tab').forEach(t => {
      const on = t.dataset.tab === view;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (view === 'collect') renderKeyState();
    if (view === 'studio') renderStudio();
    window.scrollTo({ top: 0 });
  }

  function setMode(mode) {
    state.mode = mode;
    $$('#collectTabs .ctab').forEach(t => {
      const on = t.dataset.mode === mode;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $('#panel-live').hidden = mode !== 'live';
    $('#panel-demo').hidden = mode !== 'demo';
    $('#panel-paste').hidden = mode !== 'paste';
    if (mode === 'live') renderKeyState();
  }

  /* ── render: source ────────────────────────────────── */
  function sourceBadge(video, demo) {
    if (demo) return '<span class="source-badge demo">데모 데이터 · 실제 영상 아님</span>';
    if (video && video.source === 'paste') return '<span class="source-badge paste">붙여넣은 댓글</span>';
    return '<span class="source-badge live">YouTube Data API v3 실시간</span>';
  }

  function renderSource() {
    const v = state.video;
    const bar = $('#sourceBar');
    if (!v) { bar.innerHTML = ''; return; }
    let cover = '';
    if (state.demo) {
      cover = demoCoverSVG(state.demo.key, v.title, state.demo.hook, true);
    } else if (v.thumbnail && v.source === 'live') {
      cover = '<img src="' + esc(v.thumbnail) + '" alt="" loading="lazy" referrerpolicy="no-referrer" data-fallback="1" />';
    } else {
      cover = demoCoverSVG('paste', v.title, '붙여넣기 분석');
    }
    const meta = [];
    if (v.channelTitle) meta.push('<span>채널 <b>' + esc(v.channelTitle) + '</b></span>');
    if (v.viewCount) meta.push('<span>조회 <b>' + C.formatCount(v.viewCount) + '</b></span>');
    if (v.likeCount) meta.push('<span>좋아요 <b>' + C.formatCount(v.likeCount) + '</b></span>');
    if (v.commentCount) meta.push('<span>댓글 <b>' + C.formatCount(v.commentCount) + '</b></span>');
    if (v.publishedAt) meta.push('<span>' + esc(C.relativeTime(v.publishedAt, Date.now())) + ' 공개</span>');
    meta.push('<span>모은 댓글 <b>' + state.comments.length + '개</b></span>');

    const ytLink = (v.source === 'live' && v.id)
      ? '<a class="btn btn-ghost" href="https://www.youtube.com/watch?v=' + encodeURIComponent(v.id) +
        '" target="_blank" rel="noopener noreferrer">유튜브에서 열기 ↗</a>'
      : '';
    bar.innerHTML =
      '<div class="source-cover">' + cover + '</div>' +
      '<div class="source-meta">' + sourceBadge(v, state.demo) +
      '<div class="source-title">' + esc(v.title || '(제목 없음)') + '</div>' +
      '<div class="source-sub">' + meta.join('') + '</div></div>' +
      '<div class="source-actions">' + ytLink +
      '<button class="btn btn-ghost" data-action="go-collect">다른 영상 분석</button></div>';

    const img = bar.querySelector('img[data-fallback]');
    if (img) {
      img.addEventListener('error', function () {
        const box = img.parentNode;
        box.innerHTML = demoCoverSVG('paste', v.title, v.channelTitle || '썸네일 없음');
      });
    }
  }

  /* ── render: kpi / types / keywords ────────────────── */
  function renderKpi() {
    const s = state.stats;
    const grid = $('#kpiGrid');
    if (!s) { grid.innerHTML = ''; return; }
    const pos = s.positiveRatio;
    const neg = s.negativeRatio;
    grid.innerHTML =
      '<div class="kpi">' +
        '<div class="kpi-label">총 수집 댓글</div>' +
        '<div class="kpi-value">' + s.total.toLocaleString('en-US') + '<small>개</small></div>' +
        '<div class="kpi-sub">답글 ' + s.totalReplies.toLocaleString('en-US') + '개 · 좋아요 합 ' + C.formatCount(s.totalLikes) + '</div>' +
      '</div>' +
      '<div class="kpi">' +
        '<div class="kpi-label">평균 좋아요</div>' +
        '<div class="kpi-value">' + s.avgLikes.toLocaleString('en-US') + '</div>' +
        '<div class="kpi-sub">최고 ' + s.topLike.toLocaleString('en-US') + '개</div>' +
      '</div>' +
      '<div class="kpi purchase">' +
        '<div class="kpi-label">구매의향 비율</div>' +
        '<div class="kpi-value">' + s.purchaseRatio + '<small>%</small></div>' +
        '<div class="kpi-sub">' + s.counts.purchase + '개 · 링크 요청 포함</div>' +
      '</div>' +
      '<div class="kpi question">' +
        '<div class="kpi-label">질문 비율</div>' +
        '<div class="kpi-value">' + s.questionRatio + '<small>%</small></div>' +
        '<div class="kpi-sub">' + s.counts.question + '개 · 답변 대기</div>' +
      '</div>' +
      '<div class="kpi sentiment">' +
        '<div class="kpi-label">긍정 / 부정</div>' +
        '<div class="kpi-value">' + pos + '% <span class="muted" style="font-size:13px">/</span> ' + neg + '%</div>' +
        '<div class="sent-bar"><i class="pos" style="width:' + pos + '%"></i><i class="neg" style="width:' + neg + '%"></i><i class="neu" style="width:' + Math.max(0, 100 - pos - neg) + '%"></i></div>' +
        '<div class="sent-legend"><span>긍정 <b>' + s.counts.positive + '</b></span><span>부정 <b>' + s.counts.negative + '</b></span><span>기타 <b>' + s.counts.other + '</b></span></div>' +
      '</div>';
  }

  function renderTypes() {
    const s = state.stats;
    const box = $('#typeBars');
    if (!s) { box.innerHTML = ''; return; }
    box.innerHTML = C.TYPE_ORDER.map(key => {
      const cat = C.CATEGORIES[key];
      const count = s.counts[key];
      const pct = s.total ? Math.round((count / s.total) * 1000) / 10 : 0;
      return '<div class="type-row">' +
        '<div class="type-name"><i class="tone-' + key + '"></i>' + esc(cat.short) + '</div>' +
        '<div class="type-track"><div class="type-fill tone-' + key + '" style="width:' + pct + '%"></div></div>' +
        '<div class="type-val"><b>' + count + '</b> · ' + pct + '%</div>' +
      '</div>';
    }).join('');
    const hint = $('#typeHint');
    if (hint) hint.textContent = s.total + '개 댓글 · 규칙 기반 자동 분류';
  }

  function renderKeywords() {
    const box = $('#keywordChips');
    box.innerHTML = state.keywords.map(k =>
      '<button type="button" class="kw-chip' + (state.keyword === k.word ? ' is-active' : '') +
      '" data-kw="' + esc(k.word) + '" aria-pressed="' + (state.keyword === k.word) + '" title="' +
      esc(k.count + '개 댓글에서 언급') + '">' + esc(k.word) + '<span class="n">' + k.count + '</span></button>'
    ).join('');
    const clear = $('#clearKeyword');
    if (clear) clear.hidden = !state.keyword;
    const badge = $('#kwBadge');
    if (badge) badge.textContent = 'TOP ' + state.keywords.length;
  }

  /* ── render: feed ──────────────────────────────────── */
  const FILTERS = [
    { key: 'all', label: '전체' },
    { key: 'best', label: '베스트 좋아요' },
    { key: 'purchase', label: '구매의향' },
    { key: 'question', label: '질문' },
    { key: 'positive', label: '긍정' },
    { key: 'negative', label: '불만' },
  ];

  function baseComments() {
    let list = state.comments;
    if (state.filter === 'best') {
      list = C.sortComments(list, 'likes').slice(0, 10);
    } else if (state.filter !== 'all') {
      list = list.filter(c => c.type === state.filter);
    }
    if (state.keyword) list = C.keywordFilter(list, state.keyword);
    list = C.searchComments(list, state.query);
    return C.sortComments(list, state.sort);
  }

  function filterCount(key) {
    if (key === 'all') return state.comments.length;
    if (key === 'best') return Math.min(10, state.comments.length);
    return state.comments.filter(c => c.type === key).length;
  }

  function renderFilters() {
    const box = $('#feedFilters');
    box.innerHTML = FILTERS.map(f =>
      '<button type="button" class="fchip' + (state.filter === f.key ? ' is-active' : '') +
      '" data-filter="' + f.key + '" aria-pressed="' + (state.filter === f.key) + '">' +
      f.label + '<span class="n">' + filterCount(f.key) + '</span></button>'
    ).join('');
  }

  function renderFeed() {
    const list = baseComments();
    const shown = list.slice(0, state.limit);
    const box = $('#commentList');
    const empty = $('#feedEmpty');
    box.hidden = !shown.length;
    empty.hidden = !!shown.length;
    box.innerHTML = shown.map(c => {
      const type = c.type || 'other';
      const cat = C.CATEGORIES[type] || C.CATEGORIES.other;
      const link = (state.video && state.video.source === 'live' && c.source === 'live')
        ? '<a href="https://www.youtube.com/watch?v=' + encodeURIComponent(state.video.id) +
          '&lc=' + encodeURIComponent(c.id) + '" target="_blank" rel="noopener noreferrer">원문 ↗</a>' : '';
      return '<article class="cmt" data-id="' + esc(c.id) + '" data-type="' + type + '">' +
        '<div class="cmt-avatar" aria-hidden="true">' + esc(C.authorInitial(c.author)) + '</div>' +
        '<div class="cmt-body">' +
          '<div class="cmt-top">' +
            '<span class="cmt-author">' + esc(c.author) + '</span>' +
            '<span class="cmt-time">' + esc(C.relativeTime(c.publishedAt, Date.now())) + '</span>' +
            (type === 'other' ? '' : '<span class="pill ' + type + '">' + cat.short + '</span>') +
          '</div>' +
          '<p class="cmt-text">' + esc(c.text) + '</p>' +
          '<div class="cmt-foot">' +
            '<span>👍 ' + (Number(c.likeCount) || 0).toLocaleString('en-US') + '</span>' +
            '<span>답글 ' + (Number(c.replyCount) || 0) + '</span>' +
            link +
          '</div>' +
        '</div>' +
      '</article>';
    }).join('');

    const parts = [];
    parts.push(shown.length + ' / ' + list.length + '개');
    if (state.keyword) parts.push('키워드 「' + state.keyword + '」');
    if (state.query) parts.push('검색 「' + state.query + '」');
    $('#feedCount').textContent = parts.join(' · ');

    const more = $('#feedMore');
    const rest = list.length - shown.length;
    more.innerHTML = rest > 0
      ? '<button class="btn btn-ghost" data-action="feed-more">더 보기 (' + rest + '개 남음)</button>'
      : '';
  }

  /* ── render: insights ──────────────────────────────── */
  function renderInsights() {
    const s = state.stats;
    $('#faqList').innerHTML = state.faq.length
      ? state.faq.map(f =>
        '<div class="faq-item">' +
          '<div class="faq-q"><span class="rank">' + f.rank + '</span><span>' + esc(f.question) + '</span></div>' +
          '<div class="faq-meta">「' + esc(f.keyword) + '」 · 댓글 ' + f.count + '개 · 좋아요 ' + f.likes + '</div>' +
          '<div class="faq-a">→ ' + esc(f.hint) + '</div>' +
          (f.samples && f.samples[0] ? '<div class="faq-sample"><' + esc(f.samples[0].author) + '> ' +
            esc(C.shorten(f.samples[0].text, 70)) + '</div>' : '') +
        '</div>'
      ).join('')
      : '<p class="muted" style="font-size:12.5px">질문·구매의향 댓글이 아직 없습니다.</p>';

    $('#faqSource').textContent = s
      ? '질문 ' + s.counts.question + ' · 구매의향 ' + s.counts.purchase + '에서 추출'
      : '';

    $('#pinnedOut').textContent = state.pinned || '';
    $('#promptOut').textContent = state.prompt || '';

    const ps = state.pinnedScore;
    const badge = $('#pinnedScore');
    if (badge) {
      badge.textContent = ps ? ps.score.grade.id + ' · ' + ps.score.total + '점' : '—';
      badge.className = 'psych-badge ' + (ps ? gradeClass(ps.score.grade) : 'g-na');
      badge.title = ps ? '8개 트리거 가중 평균 · ' + ps.score.grade.title : '';
    }
    const prow = $('#pinnedPsych');
    if (prow) prow.innerHTML = ps ? psychChips(ps.score, { strong: 3, gaps: 2 }) : '';
    const fixBox = $('#pinnedFixBox');
    const fix = $('#pinnedFix');
    if (fixBox && fix) {
      const corr = ps && ps.correction;
      if (corr) {
        fix.textContent = corr.text +
          (corr.warnings.length ? '\n\n⚠ ' + corr.warnings.join('\n⚠ ') : '') +
          (corr.applied.length ? '\n\n바뀐 곳: ' + corr.applied.slice(0, 4).map(a => a.from + ' → ' + a.to).join(' / ') : '');
        fixBox.hidden = !corr.text;
      } else {
        fixBox.hidden = true;
      }
    }

    const scoreRows = state.ideaScores || [];
    const ideaAvgEl = $('#ideaAvg');
    if (ideaAvgEl) {
      const avg = scoreRows.length ? Math.round(scoreRows.reduce((n, s) => n + s.score.total, 0) / scoreRows.length) : 0;
      ideaAvgEl.textContent = scoreRows.length ? '제목 점수 평균 ' + avg + '점' : '불만 · 질문 · 구매의향에서';
    }
    $('#ideaList').innerHTML = state.ideas.length
      ? state.ideas.map((idea, i) => {
        const sc = scoreRows[i] ? scoreRows[i].score : null;
        const cover = sc ? (sc.stats && typeof sc.stats.coverage === 'number' ? sc.stats.coverage : 0) : 0;
        return '<div class="idea"><span class="idea-num">' + (i + 1) + '</span><div class="idea-body">' +
          '<div class="idea-title">' + esc(idea.title) +
            (sc ? '<span class="idea-score" title="제목만 채점 · 8개 트리거 중 ' + cover + '축 · 점수 ' + sc.total + '">' + sc.total + '점</span>' : '') +
          '</div>' +
          '<div class="idea-why">' + esc(idea.why) + '</div>' +
          '<div class="idea-ev">근거 · ' + esc(idea.evidence) + '</div>' +
          (sc && sc.gaps.length ? '<div class="idea-gap">다음 한 줄: ' + esc(sc.gaps[0].name) + ' +' + sc.gaps[0].impact + '</div>' : '') +
        '</div></div>';
      }).join('')
      : '<p class="muted" style="font-size:12.5px">댓글을 모으면 소재를 뽑아 드립니다.</p>';

    const v = state.video || {};
    $('#exportMeta').innerHTML =
      '<dt>소스</dt><dd>' + (state.demo ? '데모 · ' + esc(state.demo.label) : esc(v.channelTitle || '—')) + '</dd>' +
      '<dt>댓글 수</dt><dd>' + state.comments.length + '개</dd>' +
      '<dt>분석 시각</dt><dd>' + new Date().toLocaleString('ko-KR') + '</dd>' +
      '<dt>파일명</dt><dd>comments-' + esc(v.id || 'paste') + '-' + todayStamp() + '</dd>';
  }

  function renderDemoGrid() {
    const box = $('#demoGrid');
    box.innerHTML = D.listDemos().map(d =>
      '<button class="demo-card" type="button" data-demo="' + esc(d.key) + '">' +
        '<div class="demo-cover">' + demoCoverSVG(d.key, d.title, d.hook) + '</div>' +
        '<div class="demo-body">' +
          '<div class="demo-kind">' + esc(d.kind) + '</div>' +
          '<div class="demo-title">' + esc(d.title) + '</div>' +
          '<div class="demo-sub">' + esc(d.channelTitle) + ' · 댓글 ' + d.count + '개 · 좋아요 ' + C.formatCount(d.viewCount) + '회</div>' +
          '<div class="demo-cta">이 데모 분석하기 →</div>' +
        '</div>' +
      '</button>'
    ).join('');
  }

  /* ── 카피 스튜디오 ──────────────────────────────────── */

  function gradeClass(grade) {
    const id = grade && grade.id ? grade.id : 'D';
    return 'g-' + (/^[SABCD]$/.test(id) ? id : 'D');
  }

  function psychChips(score, opts) {
    const o = opts || {};
    if (!score) return '';
    const strong = (score.strengths || []).slice(0, o.strong || 3).map(s =>
      '<span class="tchip on" title="이미 강한 축">' + esc(s.name) + ' <b>' + s.score + '</b></span>');
    const gaps = (score.gaps || []).slice(0, o.gaps || 2).map(g =>
      '<span class="tchip" title="' + esc(g.action) + '">빈틈 ' + esc(g.name) + ' <b>+' + g.impact + '</b></span>');
    const chips = strong.concat(gaps);
    if (score.friction && score.friction.count) {
      chips.push('<span class="tchip warn" title="추상어·공급자 중심 표현">감점 표현 <b>' + score.friction.count + '</b></span>');
    }
    return chips.join('');
  }

  function loadSettings() {
    const key = unquote(readLS(LS.geminiKey));
    state.settings.geminiKey = key || '';
    const model = readLS(LS.geminiModel);
    state.settings.geminiModel = model ? String(model) : (B ? B.GEMINI_DEFAULT_MODEL : 'gemini-3.5-flash-lite');
    const mode = readLS(LS.studioMode);
    if (mode && C.BRIDGE_MODES.some(m => m.id === mode)) state.studio.mode = mode;
    const size = Number(readLS(LS.bundleSize));
    if (size >= 3 && size <= 12) state.studio.size = size;
  }

  function saveGeminiKey(key) {
    state.settings.geminiKey = key || '';
    if (key) writeLS(LS.geminiKey, JSON.stringify(key));
    else removeLS(LS.geminiKey);
  }

  function briefOf() {
    const b = state.studio.bundle || {};
    return {
      video: state.video,
      stats: state.stats,
      faq: state.faq,
      keywords: state.keywords,
      questions: b.questions || [],
      purchases: b.purchases || [],
      negatives: b.negatives || [],
    };
  }

  function resetStudioResult() {
    state.studio.cards = [];
    const ta = $('#studioResult');
    if (ta) ta.value = '';
    const meta = $('#resultMeta');
    if (meta) meta.innerHTML = '';
    const cards = $('#resultCards');
    if (cards) cards.innerHTML = '';
    const note = $('#resultNote');
    if (note) note.hidden = true;
  }

  function rebuildStudio() {
    if (!RC || !C.buildBridgeBundle) return;
    state.studio.bundle = C.buildBridgeBundle(state.comments, state.stats, state.faq, {
      perCategory: state.studio.size,
      keywords: state.keywords,
    });
    updateStudioPrompt();
    if (state.view === 'studio') renderStudio();
  }

  function updateStudioPrompt() {
    if (!C.buildBridgePrompt) return;
    const info = C.buildBridgePrompt(state.video, state.studio.bundle, state.studio.mode, { maxChars: 4200 });
    state.studio.prompt = info.prompt;
    state.studio.promptInfo = info;
    return info;
  }

  function renderScoreStrip() {
    const box = $('#scoreStrip');
    if (!box) return;
    if (!RC) {
      box.innerHTML = '<div class="score-card"><b>엔진을 불러오지 못했습니다</b><span>engines/copy-psych-engine.js 경로를 확인하세요.</span></div>';
      return;
    }
    const ps = state.pinnedScore;
    const scores = state.ideaScores || [];
    const avg = scores.length ? Math.round(scores.reduce((n, s) => n + s.score.total, 0) / scores.length) : 0;
    const b = state.studio.bundle;
    const hasKey = !!state.settings.geminiKey;
    const cards = [
      {
        label: '고정 댓글 카피',
        value: ps ? ps.score.total + '점' : '—',
        sub: ps ? ps.score.grade.id + '등급 · ' + ps.score.grade.title + ' · 감점 표현 ' + ps.score.friction.count + '개 (광고 카피 기준)'
          : '댓글을 모으면 채점합니다',
      },
      {
        label: '다음 영상 소재',
        value: scores.length + '개',
        sub: '제목 점수 평균 ' + avg + '점 · 후킹을 붙이면 올라갑니다',
      },
      {
        label: '보낼 댓글 묶음',
        value: b ? b.sampled + '개' : '—',
        sub: b ? '질문 ' + b.counts.question + ' · 구매의향 ' + b.counts.purchase + ' · 불만 ' + b.counts.negative + ' / 전체 ' + b.total : '',
      },
      {
        label: '구독 AI 브리지',
        value: '3종',
        sub: hasKey ? 'Gemini 키 저장됨 · 새 창 없이 생성 가능' : 'ChatGPT · Claude · Gemini (로그인 그대로)',
      },
    ];
    box.innerHTML = cards.map(c =>
      '<div class="score-card">' +
        '<div class="score-label">' + esc(c.label) + '</div>' +
        '<div class="score-value">' + esc(c.value) + '</div>' +
        '<div class="score-sub">' + esc(c.sub) + '</div>' +
      '</div>').join('');
  }

  function renderBundle() {
    const box = $('#bundleCols');
    if (!box) return;
    const b = state.studio.bundle;
    if (!b) { box.innerHTML = ''; return; }
    const cols = [
      ['questions', '질문', 'question', b.counts.question],
      ['purchases', '구매의향', 'purchase', b.counts.purchase],
      ['negatives', '불만', 'negative', b.counts.negative],
    ];
    box.innerHTML = cols.map(col => {
      const rows = b[col[0]] || [];
      return '<div class="bundle-col">' +
        '<div class="bundle-head"><span class="pill ' + col[2] + '">' + col[1] + '</span>' +
          '<span class="muted">' + rows.length + ' / ' + col[3] + '개</span></div>' +
        (rows.length
          ? '<ol class="bundle-list">' + rows.map(r =>
              '<li title="좋아요 ' + r.likes + '"><span>' + esc(C.shorten(r.text, 74)) + '</span><b>👍 ' + r.likes + '</b></li>'
            ).join('') + '</ol>'
          : '<p class="muted bundle-empty">해당 유형 댓글이 없습니다.</p>') +
      '</div>';
    }).join('');
    const meta = $('#bundleMeta');
    if (meta) meta.textContent = b.sampled + '개 · ' + b.chars.toLocaleString('en-US') + '자';
    const kw = $('#bundleKeywords');
    if (kw) {
      kw.innerHTML = (b.keywords || []).map(k =>
        '<span class="kw-static">' + esc(k.word) + '<span class="n">' + k.count + '</span></span>').join('');
    }
    const faq = $('#bundleFaq');
    if (faq) {
      faq.innerHTML = (b.faq || []).map(f =>
        '<li><b>' + esc(f.keyword) + '</b> — ' + esc(f.question) + '<span>→ ' + esc(f.hint) + '</span></li>').join('');
    }
  }

  function renderModeSeg() {
    const seg = $('#modeSeg');
    if (!seg) return;
    seg.innerHTML = C.BRIDGE_MODES.map(m =>
      '<button type="button" class="' + (state.studio.mode === m.id ? 'is-on' : '') + '" data-action="set-bridge-mode" data-mode="' + m.id + '" title="' + esc(m.desc) + '">' + esc(m.label) + '</button>').join('');
    const hint = $('#bridgeModeHint');
    const info = C.bridgeModeInfo(state.studio.mode);
    if (hint) hint.textContent = info.desc;
  }

  function renderPromptBox() {
    const pre = $('#studioPrompt');
    if (pre) pre.textContent = state.studio.prompt || '';
    const meta = $('#studioPromptMeta');
    if (!meta) return;
    const info = state.studio.promptInfo;
    if (!info) { meta.textContent = ''; return; }
    meta.textContent = info.chars.toLocaleString('en-US') + '자 · 8개 트리거 지시 포함' +
      (info.trimmed ? ' · 길어서 댓글을 줄였습니다' : '');
  }

  function renderBridge() {
    const box = $('#bridgeBtns');
    if (!box) return;
    if (!B) {
      box.innerHTML = '<span class="muted" style="font-size:12px">AI 브리지를 불러오지 못했어요. engines/ai-bridge.js를 확인하세요.</span>';
      return;
    }
    const prompt = state.studio.prompt || '';
    box.innerHTML = B.listProviders().map(p => {
      const link = B.linkFor(p.id, prompt);
      return '<a class="btn btn-ghost btn-sm bridge-btn" href="' + esc(link.url) + '" target="_blank" rel="noopener noreferrer" ' +
        'data-action="bridge-open" data-provider="' + esc(p.id) + '" title="' + esc(link.note) + '">' +
        '<span class="prov-dot ' + esc(p.id) + '" aria-hidden="true"></span>' +
        esc(p.label) + ' 열기<span class="b-tag' + (link.prefilled ? '' : ' paste') + '">' +
        (link.prefilled ? '자동 입력' : '붙여넣기') + '</span></a>';
    }).join('');
    const note = $('#bridgeNote');
    if (note) {
      note.innerHTML = 'ChatGPT Plus · Claude Pro · Gemini 구독은 <b>웹 로그인 상태 그대로</b> 씁니다. 이 앱은 대신 API를 부르지 않고, 프롬프트를 복사해 새 창을 열어 드립니다(구독 요금제를 외부 앱이 API처럼 호출하는 것은 각사 약관에서 막혀 있습니다). 버튼을 누르면 프롬프트가 클립보드에 복사됩니다.';
    }
  }

  function renderResult() {
    const ta = $('#studioResult');
    const meta = $('#resultMeta');
    const box = $('#resultCards');
    if (!ta || !meta || !box) return;
    const raw = (ta.value || '').trim();
    const note = $('#resultNote');
    if (note) note.hidden = !raw;
    if (!raw) {
      state.studio.cards = [];
      meta.innerHTML = '<span class="muted">결과를 붙여넣으면 8개 트리거로 채점합니다.</span>';
      box.innerHTML = '';
      return;
    }
    if (!RC) { meta.textContent = '카피 엔진을 불러오지 못했습니다.'; return; }
    const defs = state.studio.mode === 'pinned'
      ? C.splitCandidates(raw)
      : [{ label: '', title: '', text: raw, chars: raw.length }];
    const cards = defs.map(d => ({
      label: d.label, title: d.title, text: d.text, chars: d.text.length, score: RC.scoreText(d.text),
    }));
    state.studio.cards = cards;
    const overall = RC.scoreText(raw);
    meta.innerHTML = '<div class="result-chips">' +
      '<span class="rchip">' + raw.length.toLocaleString('en-US') + '자</span>' +
      '<span class="rchip">' + cards.length + '개 후보</span>' +
      '<span class="rchip score ' + gradeClass(overall.grade) + '">전체 ' + overall.total + '점 · ' + overall.grade.id + '</span>' +
      '</div>';

    const canPin = state.studio.mode === 'pinned';
    box.innerHTML = cards.map((cd, i) =>
      '<article class="result-card">' +
        '<div class="result-head">' +
          (cd.label ? '<span class="result-label">' + esc(cd.label) + '</span>' : '') +
          (cd.title ? '<span class="result-title">' + esc(cd.title) + '</span>' : '') +
          '<span class="psych-badge ' + gradeClass(cd.score.grade) + '">' + cd.score.grade.id + ' · ' + cd.score.total + '점</span>' +
          '<span class="muted">' + cd.chars.toLocaleString('en-US') + '자 · 감점 표현 ' + cd.score.friction.count + '</span>' +
        '</div>' +
        '<pre class="result-text">' + esc(cd.text) + '</pre>' +
        '<div class="psych-row">' + psychChips(cd.score) + '</div>' +
        '<div class="result-actions">' +
          '<button class="btn btn-ghost btn-sm" type="button" data-action="copy-result" data-index="' + i + '">복사</button>' +
          (canPin ? '<button class="btn btn-primary btn-sm" type="button" data-action="apply-result" data-index="' + i + '">고정 댓글로 적용</button>' : '') +
        '</div>' +
      '</article>').join('');
  }

  function renderFw() {
    const out = $('#fwOut');
    const seg = $('#fwSeg');
    if (!out || !seg || !RC || !state.studio.bundle) return;
    const base = RC.inputFromBrief(briefOf());
    const overrides = {};
    const pi = $('#fwProblem');
    const si = $('#fwSolution');
    const ci = $('#fwProof');
    if (!state.studio.fwInit) {
      if (pi) pi.value = base.problem || '';
      if (si) si.value = base.solution || '';
      if (ci) ci.value = base.proof || '';
      state.studio.fwInit = true;
    }
    if (pi && pi.value.trim()) overrides.problem = pi.value.trim();
    if (si && si.value.trim()) overrides.solution = si.value.trim();
    if (ci && ci.value.trim()) overrides.proof = ci.value.trim();

    const data = RC.frameworks(briefOf(), { input: Object.assign({}, base, overrides) });
    state.studio.fwResult = data;
    seg.innerHTML = data.items.map(f =>
      '<button type="button" class="' + (state.studio.fw === f.id ? 'is-on' : '') + '" data-action="set-fw" data-fw="' + f.id + '">' +
        esc(f.id) + '<small>' + esc(f.name) + '</small></button>').join('');
    const item = data.items.filter(f => f.id === state.studio.fw)[0] || data.items[0];
    const bestTag = $('#fwBest');
    if (bestTag) {
      bestTag.textContent = '점수 1위 ' + data.best + ' · 추천 ' + data.recommendation.id;
    }
    out.innerHTML =
      '<div class="fw-head">' +
        '<div><h3>' + esc(item.title) + '</h3>' +
          '<p class="muted">' + esc(item.name) + ' · ' + item.chars + '자 · 추천 근거: ' + esc((data.recommendation.reasons || [])[0] || '점수 기준') + '</p></div>' +
        '<span class="psych-badge ' + gradeClass(item.psych.grade) + '">' + item.psych.grade.id + ' · ' + item.psych.total + '점</span>' +
      '</div>' +
      '<div class="fw-sections">' + item.sections.map(s =>
        '<div class="fw-sec"><span>' + esc(s.label) + '</span><p>' + esc(s.text) + '</p></div>').join('') + '</div>' +
      '<div class="fw-pinned">' +
        '<div class="fw-sub">고정 댓글 초안 <b>' + item.pinned.score.total + '점 · ' + item.pinned.score.grade.id + '</b> · ' + item.pinned.chars + '자</div>' +
        '<pre class="pinned-out sm">' + esc(item.pinned.text) + '</pre>' +
      '</div>' +
      '<div class="result-actions">' +
        '<button class="btn btn-ghost btn-sm" type="button" data-action="copy-fw-body">본문 복사</button>' +
        '<button class="btn btn-ghost btn-sm" type="button" data-action="copy-fw-pinned">고정 댓글 초안 복사</button>' +
        '<button class="btn btn-primary btn-sm" type="button" data-action="apply-fw-pinned">고정 댓글로 적용</button>' +
      '</div>';
  }

  function renderStudio() {
    renderScoreStrip();
    renderBundle();
    renderModeSeg();
    renderPromptBox();
    renderBridge();
    renderResult();
    renderFw();
  }

  function renderAll() {
    renderSource();
    renderKpi();
    renderTypes();
    renderKeywords();
    renderFilters();
    renderFeed();
    renderInsights();
    const tc = $('#tabCommentCount');
    if (tc) {
      tc.textContent = state.comments.length || '';
      tc.hidden = !state.comments.length;
    }
  }

  /* ── interactions: feed ────────────────────────────── */
  function setFilter(key) {
    state.filter = key;
    state.limit = PAGE;
    renderFilters();
    renderFeed();
  }

  function setKeyword(word) {
    state.keyword = state.keyword === word ? '' : word;
    state.limit = PAGE;
    renderKeywords();
    renderFilters();
    renderFeed();
    if (state.keyword) {
      const feed = $('.feed');
      if (feed && feed.getBoundingClientRect().top < 0) feed.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }

  function resetFeed() {
    state.filter = 'all';
    state.keyword = '';
    state.query = '';
    state.sort = 'likes';
    state.limit = PAGE;
    const search = $('#feedSearch');
    if (search) search.value = '';
    const sort = $('#sortSelect');
    if (sort) sort.value = 'likes';
    renderKeywords();
    renderFilters();
    renderFeed();
  }

  /* ── interactions: modal ───────────────────────────── */
  function closeModal() {
    const root = $('#modalRoot');
    root.hidden = true;
    root.innerHTML = '';
  }

  function openSettings() {
    const key = state.apiKey || getKey();
    const root = $('#modalRoot');
    root.hidden = false;
    root.innerHTML =
      '<div class="modal-backdrop" data-action="close-modal"></div>' +
      '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="keyTitle">' +
        '<div class="modal-head"><h2 id="keyTitle">YouTube Data API 키</h2>' +
          '<button class="modal-close" type="button" data-action="close-modal" aria-label="닫기">✕</button></div>' +
        '<p class="modal-sub">키는 이 브라우저(localStorage)에만 저장되고, youtube.googleapis.com 호출에만 쓰입니다. 코드·파일 어디에도 남기지 않습니다.</p>' +
        '<div class="key-state"><span class="status-dot' + (key ? ' on' : '') + '"></span>' +
          (key ? '저장됨 · ' + esc(maskKey(key)) : '아직 저장된 키가 없습니다') + '</div>' +
        '<div class="key-row">' +
          '<label class="field"><span class="field-label">API 키</span>' +
            '<input id="apiKeyInput" type="password" autocomplete="off" spellcheck="false" placeholder="AIza…" value="">' +
          '</label>' +
          '<button class="btn btn-ghost" type="button" data-action="toggle-key-visible" aria-label="키 보이기">보기</button>' +
        '</div>' +
        '<p class="hint" style="margin-top:8px">발급: Google Cloud 콘솔 → YouTube Data API v3 사용 설정 → 사용자 인증 정보 → API 키 만들기</p>' +
        '<div class="key-warning">하루 무료 할당량은 10,000 units입니다. 이 앱은 영상 정보 1회 + 댓글 100개당 1회로, 300개를 모아도 4 units만 씁니다. 키를 다른 사람과 공유하거나 코드에 넣지 마세요.</div>' +
        '<div class="modal-foot">' +
          '<button class="btn btn-primary" type="button" data-action="save-key">저장</button>' +
          '<button class="btn btn-ghost" type="button" data-action="delete-key">키 삭제</button>' +
          '<button class="btn btn-ghost" type="button" data-action="close-modal">닫기</button>' +
        '</div>' +
      '</div>';
    const input = $('#apiKeyInput');
    if (input) setTimeout(() => input.focus(), 30);
  }

  function saveKeyFromModal() {
    const input = $('#apiKeyInput');
    const value = (input ? input.value : '').trim();
    if (value.length < 12) {
      toast('API 키가 너무 짧습니다. 콘솔에서 만든 키를 붙여넣어 주세요.');
      return;
    }
    if (!setKey(value)) {
      toast('저장에 실패했습니다. 브라우저 저장 공간이 막혀 있는지 확인해 주세요.');
      return;
    }
    renderKeyState();
    closeModal();
    toast(value.slice(0, 4) === 'AIza' ? 'API 키를 저장했습니다.' : '저장했습니다. (키 형식이 AIza…가 아닙니다)');
  }

  function deleteKeyFromModal() {
    clearKey();
    renderKeyState();
    closeModal();
    toast('API 키를 삭제했습니다. 데모·붙여넣기 분석은 그대로 됩니다.');
  }

  /* ── interactions: collect ─────────────────────────── */
  function showError(target, err) {
    const box = $('#' + target);
    if (!box) return;
    box.hidden = false;
    const code = err && (err.status || err.code) ? String(err.status || err.code) : '';
    let msg = (err && (err.hint || err.message)) || '잠시 뒤 다시 시도해 주세요.';
    if (!code && err && /fetch|network/i.test(String(err.message || ''))) {
      msg = 'API 호출이 막혔습니다. 인터넷 연결과, 파일(file://) 대신 http 주소로 열었는지 확인해 주세요.';
    }
    box.innerHTML = '<b>수집하지 못했습니다' + (code ? ' (' + esc(code) + ')' : '') + '</b>' + esc(msg);
  }
  function clearError(target) {
    const box = $('#' + target);
    if (box) { box.hidden = true; box.innerHTML = ''; }
  }

  function setBusy(busy, status) {
    state.busy = busy;
    const btn = $('#collectLiveBtn');
    if (btn) {
      btn.disabled = busy;
      btn.textContent = busy ? '수집 중…' : '댓글 수집';
    }
    const st = $('#collectStatus');
    if (st) st.textContent = status || '';
  }

  async function collectLive() {
    if (state.busy) return;
    clearError('collectError');
    const raw = ($('#videoInput').value || '').trim();
    const videoId = C.parseVideoId(raw);
    if (!videoId) {
      showError('collectError', { status: 'ID', hint: '유튜브 영상·쇼츠 링크나 11자리 영상 ID를 넣어 주세요. 예: https://youtu.be/abcdefghijk' });
      return;
    }
    const key = state.apiKey || getKey();
    if (!key) {
      showError('collectError', { status: 'KEY', hint: 'API 키가 없습니다. [API 키 설정]에서 저장하거나, 데모·붙여넣기로 체험해 보세요.' });
      openSettings();
      return;
    }
    const max = Number($('#maxSelect').value) || 100;
    const order = $('#orderSelect').value || 'relevance';
    setBusy(true, '영상 정보를 가져오는 중…');
    try {
      const res = await C.collectComments({ videoId, apiKey: key, max, order }, {
        onPage(p) { setBusy(true, '댓글 ' + p.got + '개 수집 · 페이지 ' + p.page + ' · ' + p.units + ' units'); },
      });
      if (!res.comments.length) {
        showError('collectError', { status: 'EMPTY', hint: '이 영상에는 공개된 최상위 댓글이 없습니다. 댓글이 달린 다른 영상으로 시도해 보세요.' });
        setBusy(false, '');
        return;
      }
      applyDataset({ video: res.video, comments: res.comments, demo: null });
      setBusy(false, '완료 · ' + res.comments.length + '개 · ' + res.units + ' units');
      setView('dashboard');
      toast('댓글 ' + res.comments.length + '개를 분석했습니다.');
    } catch (err) {
      setBusy(false, '');
      showError('collectError', err);
    }
  }

  function collectDemo(key) {
    const built = D.buildDemo(key, Date.now());
    applyDataset({ video: built.video, comments: built.comments, demo: built.demo });
    setView('dashboard');
    toast('데모 「' + built.demo.label + '」 ' + built.comments.length + '개 댓글을 분석했습니다.');
  }

  function collectPaste() {
    clearError('pasteError');
    const text = $('#pasteInput').value || '';
    if (!text.trim()) {
      showError('pasteError', { status: 'EMPTY', hint: '댓글을 붙여넣어 주세요. 한 줄에 하나씩, 또는 CSV 헤더(댓글,좋아요,작성자)를 넣으면 됩니다.' });
      return;
    }
    const parsed = C.parsePasted(text, Date.now());
    if (!parsed.comments.length) {
      showError('pasteError', { status: 'EMPTY', hint: '댓글을 읽지 못했습니다. 한 줄에 댓글 하나씩 넣거나, 첫 줄에 「댓글,좋아요」 헤더를 넣어 주세요.' });
      return;
    }
    if (parsed.comments.length < 3) {
      showError('pasteError', { status: 'SHORT', hint: '댓글이 ' + parsed.comments.length + '개뿐이라 분류가 의미 없습니다. 5개 이상 넣어 주세요.' });
      return;
    }
    const video = {
      id: 'paste',
      title: '붙여넣은 댓글 ' + parsed.comments.length + '개',
      channelTitle: '직접 입력',
      description: '',
      publishedAt: new Date().toISOString(),
      viewCount: 0,
      likeCount: 0,
      commentCount: parsed.comments.length,
      thumbnail: '',
      source: 'paste',
    };
    applyDataset({ video, comments: parsed.comments, demo: null });
    setView('dashboard');
    toast(parsed.format === 'csv' ? 'CSV ' + parsed.comments.length + '개를 분석했습니다.' : '댓글 ' + parsed.comments.length + '개를 분석했습니다.');
  }

  /* ── interactions: exports ─────────────────────────── */
  function exportCSV() {
    if (!state.comments.length) { toast('내보낼 댓글이 없습니다.'); return; }
    const csv = C.toCSV(state.comments, state.video);
    download('comments-' + ((state.video && state.video.id) || 'paste') + '-' + todayStamp() + '.csv',
      '\uFEFF' + csv, 'text/csv;charset=utf-8');
    toast('CSV로 내려받았습니다. (엑셀 한글 호환)');
  }

  function exportJSON() {
    if (!state.comments.length) { toast('내보낼 댓글이 없습니다.'); return; }
    const json = C.toJSON(state.video, state.comments, state.stats, { now: Date.now() });
    download('comments-' + ((state.video && state.video.id) || 'paste') + '-' + todayStamp() + '.json',
      json, 'application/json;charset=utf-8');
    toast('JSON으로 내려받았습니다.');
  }

  async function copyPinned() {
    if (!state.pinned) { toast('고정 댓글 문구가 아직 없습니다.'); return; }
    const ok = await copyText(state.pinned);
    toast(ok ? '고정 댓글 문구를 복사했습니다.' : '복사에 실패했습니다. 직접 선택해 복사해 주세요.');
  }

  async function copyPrompt() {
    if (!state.prompt) { toast('프롬프트가 아직 없습니다.'); return; }
    const ok = await copyText(state.prompt);
    toast(ok ? 'AI 분석 프롬프트를 복사했습니다.' : '복사에 실패했습니다. 직접 선택해 복사해 주세요.');
  }

  /* ── interactions: 카피 스튜디오 ──────────────────── */
  async function studioCopyPrompt() {
    if (!state.studio.prompt) { toast('보낼 프롬프트가 아직 없습니다.'); return; }
    const ok = await copyText(state.studio.prompt);
    toast(ok ? 'AI 프롬프트를 복사했습니다. 구독 AI 창에 붙여넣으세요.' : '복사에 실패했습니다. 프롬프트를 직접 선택해 주세요.');
  }

  function setBridgeMode(mode) {
    if (!C.BRIDGE_MODES.some(m => m.id === mode)) return;
    state.studio.mode = mode;
    writeLS(LS.studioMode, mode);
    updateStudioPrompt();
    renderModeSeg();
    renderPromptBox();
    renderBridge();
    renderResult();
  }

  function bridgeOpen(id) {
    if (!B) return;
    const link = B.linkFor(id, state.studio.prompt);
    // 팝업 차단을 피하려고 먼저 열고, 복사는 그다음에 한다.
    // (noopener로 열면 반환값이 null이라 창 차단 여부는 반환값으로 판단하지 않는다)
    window.open(link.url, '_blank', 'noopener');
    copyText(state.studio.prompt).then(ok => {
      toast(link.prefilled
        ? link.label + ' 창에 프롬프트를 채웠습니다. 그대로 보내면 됩니다.' + (ok ? '' : ' (자동 입력이 비어 있으면 Ctrl+V)')
        : link.label + ' 창을 열었습니다. ' + (ok ? '프롬프트를 붙여넣으세요(Ctrl+V).' : '프롬프트를 직접 복사해 붙여넣으세요.'));
    });
  }

  function applyPinnedText(text, label) {
    if (!text || !String(text).trim()) { toast('적용할 문구가 비어 있습니다.'); return; }
    const prev = state.pinned;
    state.pinned = String(text).trim();
    state.pinnedScore = RC ? RC.scorePinned(state.pinned) : null;
    renderInsights();
    renderScoreStrip();
    toast((label || '고정 댓글을 바꿨어요') + ' · ' +
      (state.pinnedScore ? state.pinnedScore.score.total + '점 ' + state.pinnedScore.score.grade.id : ''), {
      label: '되돌리기',
      run: function () {
        state.pinned = prev;
        state.pinnedScore = RC ? RC.scorePinned(prev) : null;
        renderInsights();
        renderScoreStrip();
      },
    });
  }

  function setGeminiStatus(message, kind) {
    const el = $('#geminiStatus');
    if (!el) return;
    el.className = 'gemini-status' + (kind ? ' ' + kind : '');
    el.textContent = message || '';
  }

  function saveGeminiSettings(showToast) {
    const keyEl = $('#geminiKey');
    const modelEl = $('#geminiModel');
    const typed = keyEl ? keyEl.value.trim() : '';
    if (typed) {
      saveGeminiKey(typed);
      if (keyEl) keyEl.value = '';
    }
    const model = (modelEl && modelEl.value.trim()) || state.settings.geminiModel || (B ? B.GEMINI_DEFAULT_MODEL : 'gemini-3.5-flash-lite');
    state.settings.geminiModel = model;
    writeLS(LS.geminiModel, model);
    if (modelEl) modelEl.value = model;
    if (keyEl) {
      keyEl.placeholder = state.settings.geminiKey ? '저장됨 · ' + (B ? B.maskKey(state.settings.geminiKey) : '••••') : 'AIza…';
    }
    setGeminiStatus(state.settings.geminiKey
      ? '키 저장됨 · ' + (B ? B.maskKey(state.settings.geminiKey) : '••••') + (typed ? '' : ' (이미 저장된 키를 씁니다)')
      : '저장된 키가 없습니다.', 'ok');
    renderScoreStrip();
    if (showToast) toast(typed ? 'Gemini 키를 저장했습니다. (화면에는 끝 4자만 표시)' : '설정을 저장했습니다.');
  }

  async function geminiGenerate() {
    if (!B || !RC) { setGeminiStatus('엔진을 불러오지 못했습니다.', 'err'); return; }
    if (state.studio.geminiBusy) return;
    if (!state.comments.length) { toast('댓글을 먼저 모아 주세요.'); return; }
    const keyEl = $('#geminiKey');
    const modelEl = $('#geminiModel');
    const typed = keyEl ? keyEl.value.trim() : '';
    const key = typed || state.settings.geminiKey;
    const model = (modelEl && modelEl.value.trim()) || state.settings.geminiModel || B.GEMINI_DEFAULT_MODEL;
    if (!key) {
      setGeminiStatus('키가 없습니다. 위 ChatGPT·Claude·Gemini 버튼을 쓰거나, 무료 키를 넣어 주세요.', 'err');
      return;
    }
    if (typed) saveGeminiKey(typed);
    if (keyEl) { keyEl.value = ''; keyEl.placeholder = '저장됨 · ' + B.maskKey(key); }
    state.settings.geminiModel = model;
    writeLS(LS.geminiModel, model);

    let req;
    try {
      req = B.buildGeminiRequest({ apiKey: key, model: model, prompt: state.studio.prompt, maxOutputTokens: 4096 });
    } catch (e) {
      setGeminiStatus(e.message, 'err');
      return;
    }

    state.studio.geminiBusy = true;
    const btn = $('#geminiBtn');
    if (btn) { btn.disabled = true; btn.textContent = '생성 중…'; }
    setGeminiStatus('Gemini가 쓰는 중… (10~30초)', '');

    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, 60000);
    try {
      const res = await fetch(req.url, Object.assign({}, req.init, { signal: controller.signal }));
      clearTimeout(timer);
      const rawText = await res.text();
      let json = null;
      try { json = JSON.parse(rawText); } catch (e) { json = null; }
      if (!res.ok) {
        const detail = json && json.error && json.error.message ? json.error.message : rawText;
        setGeminiStatus(B.explainStatus(res.status, detail), 'err');
        return;
      }
      const out = B.parseGeminiResponse(json);
      if (!out.ok) { setGeminiStatus(out.error, 'err'); return; }
      const ta = $('#studioResult');
      if (ta) ta.value = out.text;
      renderResult();
      const usage = out.usage && out.usage.total ? ' · ' + out.usage.total.toLocaleString('en-US') + ' 토큰' : '';
      setGeminiStatus('받았습니다' + usage + (out.warnings.length ? ' · ' + out.warnings[0] : '') + ' — 아래에서 채점·적용하세요.', 'ok');
      toast('Gemini 결과를 받았습니다. 아래 카드에서 채점·적용하세요.');
    } catch (e) {
      clearTimeout(timer);
      setGeminiStatus(e && e.name === 'AbortError'
        ? '응답이 늦어 취소했습니다. 다시 시도하거나 모델을 바꿔 보세요.'
        : '연결하지 못했습니다. 키·네트워크·브라우저 차단을 확인하세요.', 'err');
    } finally {
      state.studio.geminiBusy = false;
      if (btn) { btn.disabled = false; btn.textContent = 'Gemini로 받기'; }
      renderScoreStrip();
    }
  }

  function currentFwItem() {
    const data = state.studio.fwResult;
    if (!data) return null;
    return data.items.filter(f => f.id === state.studio.fw)[0] || data.items[0];
  }

  async function copyResultCard(i) {
    const cd = state.studio.cards[i];
    if (!cd) return;
    const ok = await copyText(cd.text);
    toast(ok ? '결과를 복사했습니다.' : '복사에 실패했습니다.');
  }

  function applyResultCard(i) {
    const cd = state.studio.cards[i];
    if (!cd) return;
    applyPinnedText(cd.text, (cd.label ? cd.label + ' ' : '') + '고정 댓글을 적용했어요');
    setView('insights');
  }

  function fwAutofill() {
    if (!RC || !state.studio.bundle) return;
    const base = RC.inputFromBrief(briefOf());
    const pi = $('#fwProblem');
    const si = $('#fwSolution');
    const ci = $('#fwProof');
    if (pi) pi.value = base.problem || '';
    if (si) si.value = base.solution || '';
    if (ci) ci.value = base.proof || '';
    state.studio.fwInit = true;
    renderFw();
    toast('댓글에서 문제·해결·근거를 다시 채웠습니다.');
  }

  async function copyFwPinned() {
    const item = currentFwItem();
    if (!item) return;
    const ok = await copyText(item.pinned.text);
    toast(ok ? '고정 댓글 초안을 복사했습니다.' : '복사에 실패했습니다.');
  }

  async function copyFwBody() {
    const item = currentFwItem();
    if (!item) return;
    const text = item.title + '\n\n' + item.body;
    const ok = await copyText(text);
    toast(ok ? '카피 본문을 복사했습니다.' : '복사에 실패했습니다.');
  }

  function applyFwPinned() {
    const item = currentFwItem();
    if (!item) return;
    applyPinnedText(item.pinned.text, item.id + ' 고정 댓글 초안을 적용했어요');
  }

  /* ── event wiring ──────────────────────────────────── */
  function onClick(ev) {
    const tab = ev.target.closest('[data-tab]');
    if (tab) { setView(tab.dataset.tab); return; }

    const ctab = ev.target.closest('#collectTabs [data-mode]');
    if (ctab) { setMode(ctab.dataset.mode); return; }

    const filter = ev.target.closest('[data-filter]');
    if (filter) { setFilter(filter.dataset.filter); return; }

    const kw = ev.target.closest('[data-kw]');
    if (kw) { setKeyword(kw.dataset.kw); return; }

    const demo = ev.target.closest('[data-demo]');
    if (demo) { collectDemo(demo.dataset.demo); return; }

    const actionEl = ev.target.closest('[data-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.action;

    switch (action) {
      case 'toggle-theme': toggleTheme(); break;
      case 'go-dashboard': ev.preventDefault(); setView('dashboard'); break;
      case 'go-collect': setView('collect'); break;
      case 'go-insights': setView('insights'); break;
      case 'go-studio': setView('studio'); break;
      case 'open-settings': openSettings(); break;
      case 'close-modal': closeModal(); break;
      case 'save-key': saveKeyFromModal(); break;
      case 'delete-key': deleteKeyFromModal(); break;
      case 'toggle-key-visible': {
        const input = $('#apiKeyInput');
        if (input) {
          const show = input.type === 'password';
          input.type = show ? 'text' : 'password';
          actionEl.textContent = show ? '숨기기' : '보기';
        }
        break;
      }
      case 'collect-live': collectLive(); break;
      case 'collect-paste': collectPaste(); break;
      case 'fill-sample-paste': {
        const ta = $('#pasteInput');
        if (ta) {
          ta.value = [
            '실리콘 주걱 진짜 잘 긁히네요 어디서 사요?',
            '128 | 3만원대면 가성비 미쳤다',
            '저 수납함 링크 좀 주세요 ㅠㅠ',
            '42 | 조리도구 세척은 어떻게 하시나요?',
            '배송이 느린 게 흠이네요',
            '16 | 영상 편집 깔끔하고 좋습니다',
            '가격이 생각보다 비싸네요',
            '소음은 어느 정도인가요?',
            '재입고 언제 되나요?',
            '7 | 잘 봤습니다 구독했어요',
          ].join('\n');
          updatePasteDetect();
        }
        break;
      }
      case 'feed-more': state.limit += PAGE; renderFeed(); break;
      case 'reset-feed': resetFeed(); break;
      case 'clear-keyword': state.keyword = ''; renderKeywords(); renderFeed(); break;
      case 'clear-search': {
        const input = $('#feedSearch');
        if (input) { input.value = ''; state.query = ''; state.limit = PAGE; renderFeed(); }
        actionEl.hidden = true;
        break;
      }
      case 'copy-pinned': copyPinned(); break;
      case 'copy-prompt': copyPrompt(); break;
      case 'studio-copy-prompt': studioCopyPrompt(); break;
      case 'set-bridge-mode': setBridgeMode(actionEl.dataset.mode); break;
      case 'bridge-open': ev.preventDefault(); bridgeOpen(actionEl.dataset.provider); break;
      case 'save-gemini': saveGeminiSettings(true); break;
      case 'gemini-generate': geminiGenerate(); break;
      case 'result-clear': resetStudioResult(); renderResult(); break;
      case 'copy-result': copyResultCard(Number(actionEl.dataset.index)); break;
      case 'apply-result': applyResultCard(Number(actionEl.dataset.index)); break;
      case 'set-fw': {
        state.studio.fw = actionEl.dataset.fw;
        renderFw();
        break;
      }
      case 'fw-autofill': fwAutofill(); break;
      case 'copy-fw-pinned': copyFwPinned(); break;
      case 'copy-fw-body': copyFwBody(); break;
      case 'apply-fw-pinned': applyFwPinned(); break;
      case 'export-csv': exportCSV(); break;
      case 'export-json': exportJSON(); break;
      default: break;
    }
  }

  function updatePasteDetect() {
    const ta = $('#pasteInput');
    const out = $('#pasteDetect');
    if (!ta || !out) return;
    const text = ta.value;
    if (!text.trim()) { out.textContent = ''; out.className = 'hint'; return; }
    const parsed = C.parsePasted(text, Date.now());
    out.textContent = (parsed.format === 'csv' ? 'CSV로 인식' : '줄 단위 댓글로 인식') + ' · ' + parsed.count + '개';
    out.className = 'hint' + (parsed.count < 3 ? ' warn' : '');
  }

  function init() {
    initTheme();
    state.apiKey = getKey();
    loadSettings();
    renderKeyState();
    renderDemoGrid();

    const modelEl = $('#geminiModel');
    if (modelEl) modelEl.value = state.settings.geminiModel;
    const keyEl = $('#geminiKey');
    if (keyEl) keyEl.placeholder = state.settings.geminiKey ? '저장됨 · ' + (B ? B.maskKey(state.settings.geminiKey) : '••••') : 'AIza…';
    const list = $('#geminiModels');
    if (list && B) list.innerHTML = B.GEMINI_MODELS.map(m => '<option value="' + esc(m) + '"></option>').join('');
    const sizeEl = $('#bundleSize');
    if (sizeEl) sizeEl.value = String(state.studio.size);

    // first paint: last session, else demo #1
    if (!loadLast()) {
      const built = D.buildDemo('kitchen', Date.now());
      applyDataset({ video: built.video, comments: built.comments, demo: built.demo }, { skipSave: true });
    } else {
      renderAll();
      rebuildStudio();
    }
    setView('dashboard');
    setMode('live');

    document.addEventListener('click', onClick);

    const search = $('#feedSearch');
    if (search) {
      let timer = null;
      search.addEventListener('input', function () {
        clearTimeout(timer);
        const val = search.value;
        const clear = $('.search-clear');
        if (clear) clear.hidden = !val;
        timer = setTimeout(() => {
          state.query = val;
          state.limit = PAGE;
          renderFeed();
        }, 140);
      });
    }

    const sort = $('#sortSelect');
    if (sort) sort.addEventListener('change', function () {
      state.sort = sort.value;
      state.limit = PAGE;
      renderFeed();
    });

    const paste = $('#pasteInput');
    if (paste) paste.addEventListener('input', updatePasteDetect);

    const videoInput = $('#videoInput');
    if (videoInput) videoInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); collectLive(); }
    });

    const sizeSelect = $('#bundleSize');
    if (sizeSelect) sizeSelect.addEventListener('change', function () {
      state.studio.size = Number(sizeSelect.value) || 6;
      writeLS(LS.bundleSize, String(state.studio.size));
      rebuildStudio();
      renderStudio();
    });

    const resultEl = $('#studioResult');
    if (resultEl) {
      let timer = null;
      resultEl.addEventListener('input', function () {
        clearTimeout(timer);
        timer = setTimeout(renderResult, 160);
      });
    }

    ['#fwProblem', '#fwSolution', '#fwProof'].forEach(function (sel) {
      const el = $(sel);
      if (!el) return;
      el.addEventListener('input', function () {
        renderFw();
      });
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeModal();
    });

    window.addEventListener('storage', function (e) {
      if (e.key === LS.key) {
        state.apiKey = getKey();
        renderKeyState();
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // exposed for the browser test harness (read-only state inspection)
  window.__radar = { state, C, RC, B };
})();
