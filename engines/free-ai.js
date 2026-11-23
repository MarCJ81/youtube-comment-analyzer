/* ============================================================================
   free-ai.js · 무료 AI 맛보기 클라이언트 + 화면 조각 (의존성 없는 UMD)
   ----------------------------------------------------------------------------
   앱에 <script src="engines/free-ai.js"></script> 한 줄, 시작 시 한 번
       FreeAI.configure({ app: 'ai-writer-studio' });
   로 끝난다. 무료 체험 서버(Cloudflare Worker)는 https://free-ai-taste.onetap-ai.workers.dev
   하나를 쓰고, 앱별로 주소를 따로 넣지 않는다.

   결과 모양은 Pro 커넥터와 같다(그래서 화면 코드가 하나다).
     { ok:true, mode:'free', text, remaining, limit, provider, model }
     { ok:false, mode:'free', reason, message, cta, alternatives }

   굳이 이 파일이 하는 일
   1) 503 all_providers_busy → 0.7초 뒤 **한 번 자동 재시도**
   2) 429(오늘 몫 소진·회선 상한·전체 상한·1분 폭주) → 한국어 안내 + 전환 카드
   3) 응답의 remaining/limit → 배지("무료 맛보기 3/5회 남음")
   4) 프롬프트 2,000자 제한을 넘으면 조용히 자르지 않고 알려 준다
   ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.FreeAI = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var VERSION = '1.1.0';
  var ENDPOINT = 'https://free-ai-taste.onetap-ai.workers.dev';
  var VISITOR_KEY = 'freeai.visitor.v1';
  var MAX_PROMPT = 2000;
  var MAX_TOKENS_CAP = 900;
  var TIMEOUT_MS = 40000;
  var RETRY_DELAY_MS = 700;

  var config = { endpoint: ENDPOINT, app: '', timeoutMs: TIMEOUT_MS };
  var last = { remaining: null, limit: null, resetAt: '', provider: '', at: 0 };
  var listeners = [];
  var seq = 0;

  function trim(v) { return String(v === null || v === undefined ? '' : v).replace(/^\s+|\s+$/g, ''); }

  function isHttpUrl(u) { return !!trim(u) && /^https?:\/\/[^\s]+$/i.test(trim(u)); }

  function configure(opts) {
    var o = opts || {};
    if (o.endpoint !== undefined) {
      var ep = trim(o.endpoint).replace(/\/+$/, '');
      if (isHttpUrl(ep)) config.endpoint = ep;
    }
    if (o.app !== undefined) config.app = trim(o.app).replace(/[^A-Za-z0-9-]/g, '').slice(0, 32);
    if (o.timeoutMs !== undefined) {
      var n = Number(o.timeoutMs);
      if (isFinite(n) && n >= 1000) config.timeoutMs = n;
    }
    return status();
  }

  function status() {
    return {
      version: VERSION,
      endpoint: config.endpoint,
      app: config.app,
      ready: isHttpUrl(config.endpoint),
      remaining: last.remaining,
      limit: last.limit,
      resetAt: last.resetAt,
      provider: last.provider,
      checkedAt: last.at
    };
  }

  function visitorId() {
    try {
      if (!root.localStorage) return '';
      var saved = root.localStorage.getItem(VISITOR_KEY);
      if (saved && /^[A-Za-z0-9_-]{8,64}$/.test(saved)) return saved;
      var made = '';
      if (root.crypto && typeof root.crypto.randomUUID === 'function') made = root.crypto.randomUUID().replace(/-/g, '');
      else made = 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
      root.localStorage.setItem(VISITOR_KEY, made);
      return made;
    } catch (e) { return ''; }
  }

  function emit() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](status()); } catch (e) { /* noop */ }
    }
  }

  function onChange(fn) {
    if (typeof fn === 'function') listeners.push(fn);
    return function () {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  /* ── 프롬프트 정리 ───────────────────────────────────────
     Worker 는 2,000자를 넘으면 413 으로 거절한다. 넘치는 분량을
     말없이 잘라 보내면 결과가 이상해지므로, 부르는 쪽이 예산을
     넘겼는지 먼저 알 수 있게 길이와 함께 돌려준다. */
  function fitPrompt(text, limit) {
    var cap = limit || MAX_PROMPT;
    var s = String(text === null || text === undefined ? '' : text);
    if (s.length <= cap) return { text: s, clipped: false, chars: s.length };
    var tail = '\n\n(무료 체험 분량에 맞춰 뒤를 줄였습니다.)';
    return { text: s.slice(0, cap - tail.length) + tail, clipped: true, chars: cap };
  }

  /* ── 오류 문구 ───────────────────────────────────────────
     서버가 한국어 message 를 주면 그대로 쓴다. 우리말이 아닌 값
     (영문 스택·빈 문자열)이면 아래 표로 대신한다. */
  var REASON_TEXT = {
    free_quota_exceeded: '오늘 무료 맛보기 횟수를 모두 썼어요. 내 무료 Gemini 키를 연결하면 이어서 쓸 수 있어요.',
    shared_network_limit: '같은 회선에서 오늘 쓸 수 있는 무료 맛보기가 다 찼어요. 내 키를 연결하면 바로 이어집니다.',
    global_daily_cap: '오늘 전체 무료 맛보기가 모두 소진됐어요. 잠시 뒤나 내일 다시 시도해 주세요.',
    too_many_requests: '너무 빠르게 눌렀어요. 1분 뒤에 다시 시도해 주세요.',
    all_providers_busy: '지금 무료 AI가 붐비고 있어요. 잠시 뒤 다시 시도해 주세요.',
    free_taste_disabled: '무료 체험이 잠시 쉬는 중이에요. 내 키를 연결하면 계속 쓸 수 있어요.',
    prompt_too_long: '입력이 무료 체험 한도(2,000자)를 넘었어요. 조금 줄이거나 내 키를 연결해 주세요.',
    body_too_large: '보낼 내용이 너무 커요. 입력을 줄여 주세요.',
    empty_prompt: '내용을 먼저 입력해 주세요.',
    not_configured: '무료 체험 주소가 설정되지 않았어요.',
    network_error: '무료 체험 서버에 연결하지 못했어요. 인터넷을 확인해 주세요.',
    timeout: '무료 체험 응답이 늦어요. 잠시 뒤 다시 시도해 주세요.',
    unsupported_task: '무료 체험은 글쓰기만 됩니다. 그림·음성은 내 키를 연결해 주세요.'
  };

  function korean(has, reason) { return REASON_TEXT[reason] || '무료 체험 중 문제가 생겼어요.'; }

  /* ── 전송 ───────────────────────────────────────────────── */
  function post(path, payload, opts) {
    var o = opts || {};
    var url = (o.endpoint || config.endpoint).replace(/\/+$/, '') + path;
    if (!isHttpUrl(url)) {
      return Promise.resolve({
        ok: false, mode: 'free', reason: 'not_configured',
        message: REASON_TEXT.not_configured
      });
    }
    if (typeof root.fetch !== 'function') {
      return Promise.resolve({ ok: false, mode: 'free', reason: 'no_fetch', message: '이 브라우저에서는 무료 체험을 쓸 수 없어요.' });
    }

    var controller = typeof root.AbortController === 'function' ? new root.AbortController() : null;
    var timer = null;
    var settled = false;
    var init = {
      method: payload === null ? 'GET' : 'POST',
      headers: { accept: 'application/json' },
      credentials: 'omit',
      mode: 'cors',
      cache: 'no-store'
    };
    if (payload !== null) init.headers['content-type'] = 'application/json';
    var vid = visitorId();
    if (vid) init.headers['x-free-ai-visitor'] = vid;
    if (payload !== null) init.body = JSON.stringify(payload);
    if (controller) init.signal = controller.signal;

    return new Promise(function (resolve) {
      function finish(result) {
        if (settled) return;
        settled = true;
        if (timer) { clearTimeout(timer); timer = null; }
        if (result) {
          if (result.remaining !== undefined && result.remaining !== null) last.remaining = result.remaining;
          if (result.limit !== undefined && result.limit !== null) last.limit = result.limit;
          if (result.resetAt) last.resetAt = result.resetAt;
          if (result.ok && result.provider) last.provider = result.provider;
          if (result.ok) last.at = Date.now();
          emit();
        }
        resolve(result);
      }
      if (config.timeoutMs > 0) {
        timer = setTimeout(function () {
          if (controller) { try { controller.abort(); } catch (e) { /* noop */ } }
          finish({ ok: false, mode: 'free', reason: 'timeout', message: REASON_TEXT.timeout });
        }, o.timeoutMs || config.timeoutMs);
      }
      root.fetch(url, init).then(function (res) {
        var remaining = null, limit = null;
        try {
          var r = res.headers.get('x-free-ai-remaining');
          var l = res.headers.get('x-free-ai-limit');
          if (r !== null) remaining = Number(r);
          if (l !== null) limit = Number(l);
        } catch (e) { /* noop */ }
        return res.text().then(function (text) {
          var body = null;
          try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
          if (res.ok && body && body.ok !== false) {
            finish({
              ok: true, mode: 'free', text: trim(body.text),
              provider: body.provider || '', model: body.model || '',
              usage: body.usage || null,
              remaining: body.remaining !== undefined ? body.remaining : remaining,
              limit: body.limit !== undefined ? body.limit : limit,
              resetAt: body.resetAt || '', requestId: body.requestId || '',
              latencyMs: 0
            });
            return;
          }
          var reason = (body && body.reason) || (res.status === 429 ? 'free_quota_exceeded' : 'http_' + res.status);
          var msg = body && body.message ? trim(body.message) : '';
          if (!msg || /[\u0000-\u001f]/.test(msg) || !/[\uac00-\ud7a3]/.test(msg)) msg = korean(true, reason);
          finish({
            ok: false, mode: 'free', reason: reason,
            message: msg,
            status: res.status,
            remaining: body && body.remaining !== undefined ? body.remaining : (remaining === null ? 0 : remaining),
            limit: body && body.limit !== undefined ? body.limit : limit,
            resetAt: (body && body.resetAt) || '',
            cta: (body && body.cta) || null,
            alternatives: (body && body.alternatives) || [],
            retryAfter: (body && body.retryAfter) || 0,
            clipped: o.clipped || false
          });
        });
      }).catch(function (err) {
        var aborted = controller && controller.signal && controller.signal.aborted;
        finish({
          ok: false, mode: 'free',
          reason: aborted ? 'timeout' : 'network_error',
          message: korean(true, aborted ? 'timeout' : 'network_error')
        });
      });
    });
  }

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /**
   * 무료 체험 1회. 503(제공자 전원 실패)이면 0.7초 뒤 **한 번만** 다시 보낸다.
   * 두 번째도 503이면 그대로 실패를 돌려준다(무한 재시도 금지).
   */
  function generate(request, opts) {
    var req = request || {};
    var o = opts || {};
    var fit = fitPrompt(req.prompt, o.maxPromptChars);
    if (!trim(fit.text)) {
      return Promise.resolve({ ok: false, mode: 'free', reason: 'empty_prompt', message: REASON_TEXT.empty_prompt });
    }
    var options = {};
    if (req.options && typeof req.options === 'object') {
      if (req.options.temperature !== undefined) options.temperature = req.options.temperature;
      if (req.options.maxTokens !== undefined) options.maxTokens = Math.min(MAX_TOKENS_CAP, Math.max(64, Number(req.options.maxTokens) || MAX_TOKENS_CAP));
      if (req.options.json !== undefined) options.json = !!req.options.json;
    }
    if (!options.maxTokens) options.maxTokens = MAX_TOKENS_CAP;
    var payload = {
      task: trim(req.task) || 'text',
      prompt: fit.text,
      system: trim(req.system).slice(0, 1200),
      options: options
    };
    if (config.app) payload.app = config.app;

    var started = Date.now();
    function once() {
      return post('/v1/generate', payload, { timeoutMs: o.timeoutMs, clipped: fit.clipped })
        .then(function (res) {
          res.latencyMs = Date.now() - started;
          res.clipped = !!fit.clipped;
          return res;
        });
    }
    return once().then(function (res) {
      if (res.ok || res.reason !== 'all_providers_busy') return res;
      return wait(o.retryDelayMs === undefined ? RETRY_DELAY_MS : o.retryDelayMs).then(once).then(function (second) {
        second.retried = true;
        return second;
      });
    });
  }

  /** Pro 가 연결돼 있으면 Pro 로, 아니면 무료 맛보기로. 결과 모양은 같다. */
  function routeWith(pro, request, opts) {
    if (pro && typeof pro.isConnected === 'function' && pro.isConnected() && typeof pro.generate === 'function') {
      return Promise.resolve(pro.generate(request, opts)).then(function (res) {
        if (res && res.ok) return res;
        if (res && res.reason === 'not_connected') return generate(request, opts);
        return res;
      });
    }
    return generate(request, opts);
  }

  /* ── 화면 조각 ──────────────────────────────────────────── */

  /** "무료 맛보기 3/5회 남음" — 값이 없으면 안내 문구. */
  function badgeText(res) {
    var s = res && res.ok ? res : last;
    var rem = s && s.remaining !== undefined && s.remaining !== null ? s.remaining : null;
    var lim = s && s.limit !== undefined && s.limit !== null ? s.limit : null;
    if (rem === null) return '무료 맛보기 · 첫 1회는 바로';
    if (lim === null) return '무료 맛보기 ' + Math.max(0, rem) + '회 남음';
    return '무료 맛보기 ' + Math.max(0, rem) + '/' + lim + '회 남음';
  }

  /** 한도 소진 응답 → 화면에 그대로 그릴 수 있는 문구 묶음 */
  function limitCard(res) {
    var r = res || {};
    var quota = r.reason === 'free_quota_exceeded' || r.reason === 'global_daily_cap' || r.reason === 'shared_network_limit';
    var cta = r.cta || {};
    var rem = r.remaining === undefined || r.remaining === null ? 0 : Number(r.remaining);
    var lim = r.limit === undefined || r.limit === null ? null : Number(r.limit);
    return {
      quota: quota,
      title: quota ? '오늘 무료 맛보기를 다 썼어요' : '무료 맛보기를 잠시 쓸 수 없어요',
      body: r.message || korean(true, r.reason),
      remaining: rem,
      limit: lim,
      counts: lim === null ? '' : ('오늘 ' + Math.max(0, rem) + '/' + lim + '회 남음'),
      primary: {
        label: cta.label || '내 무료 Gemini 키 연결',
        href: cta.keyUrl || 'https://aistudio.google.com/apikey',
        kind: cta.kind || 'connect_key'
      },
      secondary: (r.alternatives && r.alternatives.length ? r.alternatives : [
        { kind: 'subscription_bridge', label: '구독 AI 브리지로 넘기기' }
      ]).map(function (a) { return { label: a.label, kind: a.kind }; })
    };
  }

  var CSS_ID = 'freeai-css';
  function ensureCss(doc) {
    if (!doc || doc.getElementById(CSS_ID)) return;
    var st = doc.createElement('style');
    st.id = CSS_ID;
    st.textContent = [
      '.freeai-card{--fa-ink:var(--ink,#1b1b1b);--fa-line:var(--line,rgba(0,0,0,.12));--fa-surface:var(--surface,#fff);--fa-accent:var(--accent,#2b6cb0);',
      'font:inherit;color:var(--fa-ink);background:var(--fa-surface);border:1px solid var(--fa-line);border-left:3px solid var(--fa-accent);',
      'border-radius:12px;padding:14px 16px;margin:12px 0;max-width:560px;line-height:1.6}',
      '.freeai-card[hidden]{display:none}',
      '.freeai-card h4{margin:0 0 6px;font-size:15px;letter-spacing:-.01em}',
      '.freeai-card p{margin:0 0 10px;font-size:13px;opacity:.85}',
      '.freeai-card .freeai-counts{font-variant-numeric:tabular-nums;font-size:12px;opacity:.7;margin:-4px 0 10px}',
      '.freeai-card .freeai-actions{display:flex;flex-wrap:wrap;gap:8px}',
      '.freeai-card a,.freeai-card button{font:inherit;font-size:13px;border-radius:8px;padding:8px 12px;cursor:pointer;text-decoration:none;',
      'border:1px solid var(--fa-line);background:transparent;color:inherit}',
      '.freeai-card a.freeai-primary,.freeai-card button.freeai-primary{background:var(--fa-accent);border-color:var(--fa-accent);color:#fff}',
      '.freeai-badge{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-variant-numeric:tabular-nums;',
      'padding:3px 9px;border-radius:999px;border:1px solid var(--line,rgba(0,0,0,.14));opacity:.85}',
      '.freeai-badge b{font-weight:600}',
      '.freeai-badge[data-state=empty]{border-color:#d97706;color:#b45309}',
      '.freeai-note{font-size:12px;opacity:.62;margin-top:6px}'
    ].join('');
    (doc.head || doc.documentElement).appendChild(st);
  }

  /**
   * 전환 카드를 host 안에 그린다.
   * opts: { onConnectKey, onBridge, doc }
   *   onConnectKey — 앱의 Pro 연결 모달을 여는 함수(없으면 키 발급 페이지 새 창)
   *   onBridge     — 구독 AI 브리지 화면으로 보내는 함수
   */
  function mountUpgrade(host, res, opts) {
    var o = opts || {};
    var doc = o.doc || (host && host.ownerDocument) || root.document;
    if (!host || !doc) return null;
    ensureCss(doc);
    var card = limitCard(res);
    var old = host.querySelector('.freeai-card');
    if (old) old.remove();
    var box = doc.createElement('div');
    box.className = 'freeai-card';
    box.setAttribute('role', 'status');
    var h = doc.createElement('h4');
    h.textContent = card.title;
    var p = doc.createElement('p');
    p.textContent = card.body;
    box.appendChild(h);
    box.appendChild(p);
    if (card.counts) {
      var c = doc.createElement('div');
      c.className = 'freeai-counts';
      c.textContent = card.counts;
      box.appendChild(c);
    }
    var acts = doc.createElement('div');
    acts.className = 'freeai-actions';
    var a1 = doc.createElement(card.primary.href && !o.onConnectKey ? 'a' : 'button');
    a1.className = 'freeai-primary';
    a1.textContent = card.primary.label;
    if (a1.tagName === 'A') {
      a1.href = card.primary.href;
      a1.target = '_blank';
      a1.rel = 'noopener noreferrer';
    }
    a1.addEventListener('click', function (e) {
      if (o.onConnectKey) { e.preventDefault(); o.onConnectKey(); }
    });
    acts.appendChild(a1);
    if (o.onBridge) {
      var a2 = doc.createElement('button');
      a2.textContent = (card.secondary[0] && card.secondary[0].label) || '구독 AI 브리지로 넘기기';
      a2.addEventListener('click', function () { o.onBridge(); });
      acts.appendChild(a2);
    }
    box.appendChild(acts);
    var note = doc.createElement('div');
    note.className = 'freeai-note';
    note.textContent = '무료 맛보기는 외부 AI 제공자로 전송됩니다. 민감한 내용(주민번호·계좌번호 등)은 넣지 마세요.';
    box.appendChild(note);
    host.appendChild(box);
    return box;
  }

  /** 배지를 el 안에 그린다. 무료 호출이 끝나면 자동으로 숫자가 바뀐다. */
  function mountBadge(el, opts) {
    var o = opts || {};
    var doc = o.doc || (el && el.ownerDocument) || root.document;
    if (!el) return null;
    ensureCss(doc);
    el.classList.add('freeai-badge');
    function paint(s) {
      var rem = s && s.remaining !== null && s.remaining !== undefined ? s.remaining : null;
      el.setAttribute('data-state', rem !== null && rem <= 0 ? 'empty' : 'ok');
      el.innerHTML = '';
      var t = doc.createElement('span');
      t.textContent = badgeText(s && (s.remaining !== undefined) ? s : null);
      el.appendChild(t);
      if (rem !== null && rem > 0) {
        var b = doc.createElement('b');
        b.textContent = '무료';
        el.insertBefore(b, t);
      }
    }
    paint(status());
    onChange(function (s) { paint(s); });
    return el;
  }

  return {
    VERSION: VERSION,
    ENDPOINT: ENDPOINT,
    MAX_PROMPT: MAX_PROMPT,
    MAX_TOKENS_CAP: MAX_TOKENS_CAP,
    configure: configure,
    status: status,
    onChange: onChange,
    generate: generate,
    routeWith: routeWith,
    fitPrompt: fitPrompt,
    badgeText: badgeText,
    limitCard: limitCard,
    mountBadge: mountBadge,
    mountUpgrade: mountUpgrade,
    reasonText: function (reason) { return korean(true, reason); },
    reset: function () { last = { remaining: null, limit: null, resetAt: '', provider: '', at: 0 }; emit(); return status(); },
    __seq: function () { return ++seq; }
  };
});
