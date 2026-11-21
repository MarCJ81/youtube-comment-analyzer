/* ============================================================
   radar-copy.js  ·  댓글 → 카피 심리학 어댑터  v1.0.0
   ------------------------------------------------------------
   copy-psych-engine.js(8대 트리거 진단 · PAS/BAB/AIDA/4U ·
   감점 표현 교정)를 '유튜브 댓글' 맥락에 맞춰 쓰는 얇은 층.

   브라우저: window.RadarCopy (copy-psych-engine.js 다음에 로드)
   node:     require('./radar-copy.js')  → 내부에서 엔진을 require

   원칙
   - 엔진이 만든 문장에 없는 사실을 더하지 않는다. 숫자는 댓글 집계값만.
   - 자동 교정은 문법·군더더기 수준. 의미가 뭉개지면 경고를 붙인다.
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./copy-psych-engine.js'));
  else root.RadarCopy = factory(root.CopyPsych);
})(typeof self !== 'undefined' ? self : this, function (CP) {
  'use strict';

  var VERSION = '1.0.0';
  if (!CP) throw new Error('copy-psych-engine.js를 먼저 불러와야 합니다.');

  function str(v) {
    if (v === null || v === undefined) return '';
    return String(v);
  }

  function clip(s, n) {
    var t = str(s).replace(/\s+/g, ' ').trim();
    if (!t) return '';
    if (t.length <= n) return t;
    return t.slice(0, Math.max(1, n - 1)).trim() + '…';
  }

  function oneLine(s) {
    return str(s).replace(/\s+/g, ' ').trim();
  }

  /* ── 1. 채점 ───────────────────────────────────────────── */

  function triggerRow(t) {
    return {
      id: t.id, name: t.name, weight: t.weight,
      score: t.score, level: t.level,
      hits: (t.hits || []).slice(0, 3),
      fix: t.fix
    };
  }

  /**
   * 카피 한 덩어리 채점.
   * @returns {{total,grade,triggers,strengths,gaps,friction,stats,flags,chars}}
   */
  function scoreText(text) {
    var d = CP.diagnose(text);
    var det = CP.detect(text);
    return {
      total: d.total,
      grade: d.grade,
      triggers: d.triggers.map(triggerRow),
      strengths: d.strengths.map(function (s) { return { id: s.id, name: s.name, score: s.score }; }),
      gaps: d.gaps.slice(0, 3).map(function (g) {
        return { id: g.id, name: g.name, score: g.score, weight: g.weight, impact: g.impact, action: g.action };
      }),
      friction: {
        score: det.friction,
        grade: det.grade,
        count: det.count,
        groups: det.groups.map(function (g) { return { type: g.type, label: g.label, count: g.count, severity: g.severity }; }),
        issues: det.issues.slice(0, 6).map(function (i) {
          return { type: i.type, phrase: i.phrase, reason: i.reason, alternative: i.alternative };
        })
      },
      stats: d.stats,
      flags: d.flags,
      chars: d.stats.chars
    };
  }

  /** 문장이 통째로 반복됐는지 — 자동 교정이 의미를 뭉갠 경우를 잡는다. */
  function duplicatedSentences(text) {
    var parts = str(text).split(/[.!?\n]+/).map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length >= 6; });
    var seen = {}, dup = [];
    parts.forEach(function (s) {
      if (seen[s]) { if (dup.indexOf(s) < 0) dup.push(s); }
      seen[s] = true;
    });
    return dup;
  }

  /**
   * 감점 표현 교정안. 자동 치환이 문장을 망가뜨리면 warnings로 알린다.
   * (사실을 새로 만들지 않는다. '최고의' 같은 최상급은 치환하지 않고 이슈로만 남긴다.)
   */
  function correctText(text) {
    var src = str(text);
    var fixed = CP.correct(src);
    var warnings = [];
    var dup = duplicatedSentences(fixed.text);
    if (dup.length) {
      warnings.push('자동 치환이 같은 문장을 반복시켰습니다(' + dup.length + '곳). 그대로 쓰지 말고 아래 대안만 참고하세요.');
    }
    if (!fixed.applied.length) {
      warnings.push('자동으로 바꿀 문법·군더더기 표현이 없었습니다.');
    }
    if (fixed.text.replace(/\s/g, '').length < src.replace(/\s/g, '').length * 0.55) {
      warnings.push('교정 결과가 원문보다 크게 짧아졌습니다. 의미가 유지됐는지 확인하세요.');
    }
    return {
      text: fixed.text,
      applied: fixed.applied,
      improved: fixed.improved,
      beforeScore: CP.detect(src).friction,
      afterScore: fixed.after.friction,
      afterGrade: fixed.after.grade,
      warnings: warnings,
      duplicate: dup
    };
  }

  /** 추천 고정 댓글 채점 + 교정안 */
  function scorePinned(text) {
    var base = scoreText(text);
    var fix = correctText(text);
    return {
      kind: 'pinned',
      text: str(text),
      lines: str(text) ? str(text).split('\n').length : 0,
      score: base,
      correction: fix,
      note: base.flags.tooShort
        ? '고정 댓글이 40자 미만이라 트리거 점수가 낮게 나옵니다. Q&A·링크·타임스탬프를 채운 뒤 다시 채점하세요.'
        : ''
    };
  }

  /** 다음 영상 제목/후킹 아이디어 채점 (제목 + 후킹 문장을 함께 본다) */
  function scoreIdea(idea) {
    var src = idea || {};
    var title = str(src.title || src.text || '');
    var hook = str(src.hook || src.why || '');
    var combined = title + (hook ? '\n' + hook : '');
    var base = scoreText(combined);
    return {
      kind: 'idea',
      title: title,
      hook: hook,
      score: base,
      titleOnly: scoreText(title),
      note: base.flags.tooShort
        ? '제목+이유가 40자 미만이라 점수가 낮게 나옵니다. 첫 3초 후킹 문장까지 붙여 다시 채점하세요.'
        : ''
    };
  }

  /* ── 2. 댓글 브리핑 → 카피 엔진 입력 ───────────────────── */

  /**
   * buildBridgeBundle() 결과 + 영상을 카피 엔진 입력으로 바꾼다.
   * 값은 전부 댓글·영상에서 온 것만 넣는다. (가격·기한은 지어내지 않음)
   */
  function inputFromBrief(brief) {
    var b = brief || {};
    var stats = b.stats || {};
    var video = b.video || {};
    var negatives = b.negatives || [];
    var questions = b.questions || [];
    var faq = b.faq || [];
    var kws = b.keywords || [];
    var topKw = kws.length && kws[0] ? kws[0].word : '';

    var target = topKw ? '「' + topKw + '」' + CP.josa(topKw, '이가') + ' 궁금한 시청자' : '이 영상 시청자';
    var problem = negatives.length
      ? clip(negatives[0].text, 80)
      : (questions.length ? clip(questions[0].text, 80) : '');
    var solution = faq.length && faq[0].hint
      ? clip(faq[0].hint, 90)
      : (topKw ? '「' + topKw + '」' + CP.josa(topKw, '을를') + ' 영상에서 직접 확인한 값으로 답합니다' : '영상에서 직접 확인한 값으로 답합니다');
    var proof = stats.total
      ? '댓글 ' + stats.total + '개 분석 · 질문 ' + (stats.counts ? stats.counts.question : 0) +
        '건 · 구매의향 ' + (stats.counts ? stats.counts.purchase : 0) + '건'
      : '';

    return {
      product: clip(video.title || b.videoTitle || '이 영상', 60),
      target: target,
      problem: problem,
      solution: solution,
      proof: proof,
      cta: '고정 댓글의 링크·타임스탬프 확인',
      urgency: '',
      priceBefore: '',
      priceAfter: '',
      guarantee: '',
      tone: 'casual'
    };
  }

  /** 프레임워크 1종 → 고정 댓글 초안 (긴 문단을 6줄 이내로 압축) */
  function toPinnedDraft(item, opts) {
    var o = opts || {};
    var lines = [];
    lines.push('📌 ' + clip(item.title, 70));
    (item.sections || []).forEach(function (s) {
      var t = clip(s.text, o.sectionMax || 110);
      if (t) lines.push(t);
    });
    if (o.link !== false) lines.push('🛒 구매 링크·타임스탬프: (여기에 붙여넣기)');
    lines.push('💬 더 궁금한 건 댓글로 — 다음 영상에서 답합니다.');
    var text = lines.join('\n');
    return {
      framework: item.id,
      text: text,
      chars: text.length,
      lines: lines.length,
      score: scoreText(text)
    };
  }

  /**
   * 댓글 브리핑 → PAS/BAB/AIDA/4U 4종 + 고정 댓글 초안.
   * @param {object} brief  buildBridgeBundle() 결과
   * @param {object} [opts] { input 오버라이드, variant }
   */
  function frameworks(brief, opts) {
    var o = opts || {};
    var input = o.input ? CP.normalizeInput(o.input) : inputFromBrief(brief);
    var all = CP.generateAll(input, { variant: o.variant || 0 });
    var items = all.items.map(function (it) {
      return {
        id: it.id,
        name: it.name,
        en: it.en,
        title: it.title,
        sections: it.sections,
        body: it.body,
        chars: it.chars,
        psych: it.psych,
        pinned: toPinnedDraft(it, o)
      };
    });
    return {
      input: input,
      items: items,
      best: all.best.id,
      comparison: all.comparison,
      recommendation: all.recommendation
    };
  }

  /** 제목·후킹 대안: 프레임워크 제목 + 4U 제목, 중복 제거 */
  function hookVariants(brief, opts) {
    var fw = frameworks(brief, opts);
    var out = [];
    var seen = {};
    fw.items.forEach(function (it) {
      var t = oneLine(it.title);
      var key = t.replace(/\s/g, '');
      if (!t || seen[key]) return;
      seen[key] = true;
      out.push({ framework: it.id, title: t, score: it.psych.total, grade: it.psych.grade });
    });
    return { input: fw.input, variants: out, best: fw.best };
  }

  /** 화면용 요약: 강한 트리거 3 + 빈틈 2 */
  function summarize(score) {
    var s = score || {};
    var strong = (s.strengths || []).slice(0, 3);
    var gaps = (s.gaps || []).slice(0, 2);
    return {
      total: s.total || 0,
      grade: (s.grade && s.grade.id) || 'D',
      gradeTitle: (s.grade && s.grade.title) || '',
      strong: strong,
      gaps: gaps,
      friction: (s.friction && s.friction.score) || 0,
      frictionCount: (s.friction && s.friction.count) || 0
    };
  }

  return {
    VERSION: VERSION,
    TRIGGERS: CP.TRIGGERS,
    FRAMEWORKS: CP.FRAMEWORKS,
    scoreText: scoreText,
    scorePinned: scorePinned,
    scoreIdea: scoreIdea,
    correctText: correctText,
    duplicatedSentences: duplicatedSentences,
    inputFromBrief: inputFromBrief,
    toPinnedDraft: toPinnedDraft,
    frameworks: frameworks,
    hookVariants: hookVariants,
    summarize: summarize
  };
});
