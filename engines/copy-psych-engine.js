/* ============================================================
   copy-psych-engine.js  ·  카피라이터 & 마케팅 심리학 엔진  v1.0.0
   ------------------------------------------------------------
   의존성 없는 순수 JS(UMD). 브라우저에서는 window.CopyPsych,
   node 에서는 require('./copy-psych-engine.js') 로 쓴다.

   제공 기능
   1) 8대 심리학 트리거 진단·점수화 (0~100)
      손실 회피 / 구체적 숫자·앵커링 / 호기심 갭 / 패턴 인터럽트
      / 사회적 증거 / 희소성·기한 / 권위·실측 근거 / 초저마찰 CTA
   2) 4대 프레임워크 자동 카피 생성 (PAS · BAB · AIDA · 4U)
   3) 전환율 감점 표현 탐지 + 소비자 이득 중심 교정안
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CopyPsych = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '1.0.0';

  /* ==========================================================
     0. 공통 유틸
     ========================================================== */

  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

  function num(n, fallback) {
    var v = Number(n);
    return isFinite(v) ? v : (fallback === undefined ? 0 : fallback);
  }

  /** 문자열 안전 변환 (null/undefined/숫자 모두 허용) */
  function str(v) {
    if (v === null || v === undefined) return '';
    return String(v);
  }

  /** 정규식 등장 횟수. 원본 정규식에 g 플래그가 없어도 안전하게 센다. */
  function countOf(text, re) {
    if (!text) return 0;
    var flags = re.flags.indexOf('g') >= 0 ? re.flags : re.flags + 'g';
    var m = text.match(new RegExp(re.source, flags));
    return m ? m.length : 0;
  }

  /** 첫 등장 위치와 문구 */
  function firstMatch(text, re) {
    if (!text) return null;
    var flags = re.flags.replace(/g/g, '');
    var m = new RegExp(re.source, flags).exec(text);
    if (!m) return null;
    return { phrase: m[0], index: m.index };
  }

  /** 결정적 해시(문구 변형 선택용). 같은 입력 → 같은 결과. */
  function hash(strIn) {
    var h = 2166136261;
    var s = str(strIn);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0);
  }

  function pick(arr, seed) {
    if (!arr || !arr.length) return '';
    return arr[hash(seed) % arr.length];
  }

  /** 문장 끝에 마침표가 없으면 붙인다. 이미 있으면 그대로. */
  function sent(s) {
    var t = str(s).trim();
    if (!t) return '';
    return /[.!?~…]$/.test(t) ? t : t + '.';
  }

  function uniq(arr) {
    var out = [], seen = {};
    for (var i = 0; i < arr.length; i++) {
      var k = arr[i];
      if (!seen[k]) { seen[k] = 1; out.push(k); }
    }
    return out;
  }

  /* ── 한국어 조사 자동 선택 ──────────────────────────────────
     "수납함는" 같은 AI 번역체를 만들지 않기 위해 받침을 계산한다.
     ---------------------------------------------------------- */
  var DIGIT_JONG = { '0': true, '1': true, '2': false, '3': true, '4': false, '5': false, '6': true, '7': true, '8': true, '9': false };

  function lastCharInfo(word) {
    var s = str(word).replace(/[\s"'”“’)\].,!?~…·]+$/, '');
    if (!s) return null;
    var ch = s.charAt(s.length - 1);
    var code = ch.charCodeAt(0);
    if (code >= 0xAC00 && code <= 0xD7A3) {
      var jong = (code - 0xAC00) % 28;
      return { ch: ch, jong: jong !== 0, jongCode: jong };
    }
    if (DIGIT_JONG[ch] !== undefined) return { ch: ch, jong: DIGIT_JONG[ch], jongCode: null };
    return null;
  }

  /** josa('수납함','은는') → '은' */
  function josa(word, type) {
    var info = lastCharInfo(word);
    var jong = info ? info.jong : false;
    switch (type) {
      case '은는': return jong ? '은' : '는';
      case '이가': return jong ? '이' : '가';
      case '을를': return jong ? '을' : '를';
      case '과와': return jong ? '과' : '와';
      case '으로로': return (info && info.jong && info.ch !== 'ㄹ') ? '으로' : '로';
      case '이라면': return jong ? '이라면' : '라면';
      case '이라는': return jong ? '이라는' : '라는';
      case '이다': return jong ? '이다' : '다';
      case '의': return '의';
      default: return '';
    }
  }

  /** 붙임 표기: 붙임('수납함','은는') → '수납함은' */
  function withJosa(word, type) {
    var w = str(word).trim();
    if (!w) return '';
    return w + josa(w, type);
  }

  function sentenceSplit(text) {
    return str(text).split(/[.!?。！？\n\r]+/).map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });
  }

  function countChars(text) {
    return Array.from ? Array.from(str(text)).length : str(text).length;
  }

  /* ==========================================================
     1. 8대 심리학 트리거
     ========================================================== */

  var TRIGGERS = [
    {
      id: 'loss', name: '손실 회피', en: 'Loss Aversion', weight: 15,
      claim: '얻는 기쁨보다 잃는 아픔이 약 2배 크다',
      question: '안 사면 무엇을 잃는지 한 문장으로 말했는가?',
      fix: '“얻으면 좋은 것”을 “지금 그대로 두면 잃는 것”으로 바꿔 쓰세요. 예: “시간이 절약됩니다” → “이번 주에도 5시간을 정리하다 날립니다”.'
    },
    {
      id: 'anchor', name: '구체적 숫자·앵커링', en: 'Concrete Anchoring', weight: 15,
      claim: '숫자는 형용사를 이기고, 기준점은 가격 판단을 바꾼다',
      question: '숫자·기간·비율이 최소 2개 있는가? 비교 기준(정가·평균)을 먼저 보여줬는가?',
      fix: '“다양한”, “빠른”을 “12가지”, “3분”으로 바꾸고, 비싼 기준(정가·타사 평균)을 먼저 제시한 뒤 실제 가격을 보여주세요.'
    },
    {
      id: 'curiosity', name: '호기심 갭', en: 'Curiosity Gap', weight: 12,
      claim: '아는 것과 모르는 것 사이의 틈이 클릭을 만든다',
      question: '첫 문장이 “그래서 뭐?”를 유발하는가? 답은 본문까지 미뤘는가?',
      fix: '결론을 제목에서 다 말하지 마세요. “정리 잘하는 법” 대신 “정리 잘하는 사람들이 절대 안 버리는 것 3가지”.'
    },
    {
      id: 'interrupt', name: '인지 반전·패턴 인터럽트', en: 'Pattern Interrupt', weight: 10,
      claim: '예상과 어긋나는 첫 문장이 스크롤을 멈춘다',
      question: '상식·통념을 한 번 뒤집는 문장이 있는가?',
      fix: '“더 사세요” 대신 “지금 사면 안 됩니다. 이 3가지에 해당한다면요”처럼 예상을 깨는 문장으로 시작하세요.'
    },
    {
      id: 'social', name: '사회적 증거', en: 'Social Proof', weight: 13,
      claim: '불확실할 때 사람은 다른 사람의 선택을 기준으로 삼는다',
      question: '숫자로 된 타인(구매 수·후기·재구매율)이 있는가?',
      fix: '“좋은 평가” 대신 “후기 1,842건 · 평점 4.8 · 재구매 68%”처럼 셀 수 있는 형태로 붙이세요.'
    },
    {
      id: 'scarcity', name: '희소성·기한', en: 'Scarcity / Urgency', weight: 12,
      claim: '없어질 수 있다는 신호가 지금 결정하게 만든다',
      question: '왜 오늘 해야 하는지(수량·기한)가 적혀 있는가?',
      fix: '“이벤트 중” 대신 “이번 주 금요일 23시 마감 · 잔여 37세트”처럼 날짜와 수량을 함께 쓰세요.'
    },
    {
      id: 'authority', name: '권위·실측 근거', en: 'Authority / Evidence', weight: 13,
      claim: '검증 가능한 출처는 의심을 끄는 가장 빠른 방법이다',
      question: '누가·어떻게 확인한 것인지 붙어 있는가?',
      fix: '“효과 좋음” 대신 “○○연구소 4주 실측, 사용자 62명 평균 −2.3℃”처럼 측정 주체·기간·표본을 붙이세요.'
    },
    {
      id: 'cta', name: '초저마찰 CTA', en: 'Zero-Friction CTA', weight: 10,
      claim: '행동까지의 단계가 하나 줄면 전환은 눈에 띄게 오른다',
      question: '다음 행동이 1개이고, 걸리는 시간·비용이 0에 가깝다고 말했는가?',
      fix: '“문의 주세요” 대신 “링크 누르면 3초 만에 끝 · 가입 없이 · 무료”처럼 행동과 마찰 제거를 한 줄에 붙이세요.'
    }
  ];

  var TRIGGER_INDEX = (function () {
    var m = {};
    TRIGGERS.forEach(function (t) { m[t.id] = t; });
    return m;
  })();

  /* ── 트리거별 탐지 신호 ──────────────────────────────────────
     w: 신호 1개가 주는 점수. 서로 다른 신호가 쌓여 100에서 멈춘다.
     같은 신호의 반복은 최대 +12까지 보너스.
     ---------------------------------------------------------- */
  var SIGNALS = {
    loss: [
      { id: 'miss', label: '놓치면·후회', w: 40, re: /놓치(면|게|지|치면)|지나치면|후회|아쉬워|아깝|miss out|don'?t miss|lose/i },
      { id: 'deadline-loss', label: '지금 아니면', w: 35, re: /지금 아니면|오늘 아니면|이번이 마지막|마지막 기회|다시는 없|only (once|today)/i },
      { id: 'inaction', label: '그대로 두면', w: 32, re: /그대로 (두면|쓰면|있으면)|계속 (이러|그러)면|이대로면|방치하면|미루면/ },
      { id: 'irreversible', label: '되돌릴 수 없음', w: 30, re: /되돌릴 수 없|취소할 수 없|영영|다시 못|돌이킬 수 없/ },
      { id: 'cost', label: '비용 발생', w: 28, re: /(못 하면|않으면|안 하면)[^.!?\n]{0,24}(손해|비용|시간|돈|기회)/ },
      { id: 'waste', label: '낭비', w: 24, re: /낭비|새어 나|허비|날리|버리게|waste/i }
    ],
    anchor: [
      { id: 'unit-number', label: '단위 붙은 숫자', w: 32, re: /\d[\d,.]*\s*(원|만원|천원|%|명|개|초|분|시간|일|주|개월|년|배|건|점|위|kg|g|ml|L|cm|℃)/ },
      { id: 'price', label: '가격 표기', w: 30, re: /\d[\d,]*\s*(원|₩)|₩\s?\d/ },
      { id: 'anchor-contrast', label: '정가→판매가 대비', w: 45, re: /(정가|원가|기존가|원래|타사|평균)[^.!?\n]{0,18}\d[\d,]*\s*원[^.!?\n]{0,28}\d[\d,]*\s*원/ },
      { id: 'ratio', label: '배수·비율', w: 34, re: /\d+(\.\d+)?\s*(배|분의|%)/ },
      { id: 'time-promise', label: '시간 약속', w: 33, re: /\d+\s*(초|분|시간)\s*(만에|안에|이내|면)/ },
      { id: 'rank', label: '순위·순번', w: 30, re: /\d+\s*(위|등|번째)/ },
      { id: 'decimal', label: '소수점 정밀 수치', w: 18, re: /\d+\.\d+/ }
    ],
    curiosity: [
      { id: 'question', label: '질문형', w: 26, re: /\?|？/ },
      { id: 'why', label: '왜·이유', w: 32, re: /왜 |이유(는|가|를)|까닭|왜냐하면/ },
      { id: 'nobody', label: '아무도 모르는', w: 42, re: /아무도 (모르|말하|알려주)|모르는|숨겨진|비밀|감춰진|nobody (tells|knows)|secret/i },
      { id: 'reversal', label: '알고 보니', w: 36, re: /알고 보니|알고보니|사실은|정작|뜯어보면|들여다보면/ },
      { id: 'ellipsis', label: '말줄임', w: 20, re: /\.{2,}|…/ },
      { id: 'conditional', label: '~한다면?', w: 22, re: /(한다면|라면|다면)\s*[?.!]?/ },
      { id: 'pointer', label: '이 한 가지', w: 22, re: /이 한 가지|딱 하나|단 하나|이것 하나|이 세 가지|these \d+ things/i }
    ],
    interrupt: [
      { id: 'dont', label: '~하지 마세요', w: 42, re: /하지 마(세요|라|십시오|시고)|사지 마|사면 안|쓰지 마|stop (doing|buying)/i },
      { id: 'opposite', label: '반대로·오히려', w: 36, re: /반대로|거꾸로|오히려|정반대|actually|the opposite/i },
      { id: 'myth', label: '상식·통념 깨기', w: 32, re: /상식|통념|당연하다고|늘 그렇다고|다들 (그렇|말하)|myth|everyone (thinks|says)/i },
      { id: 'contrast', label: '대조 구조', w: 22, re: /지만|반면|는데 반해|ㄴ데도|however|but /i },
      { id: 'short-sentence', label: '아주 짧은 문장', w: 26, re: /(^|[.!?\n])\s*[^.!?\n]{1,12}[.!?]/ }
    ],
    social: [
      { id: 'reviews', label: '후기·리뷰', w: 36, re: /후기|리뷰|review|실사용|사용 후/ },
      { id: 'count-people', label: '명이 선택', w: 42, re: /\d[\d,]*\s*(명|분|가구|팀)(이|께서|의)?\s*(선택|사용|구매|재구매|이용|가입)|누적\s*\d/ },
      { id: 'repurchase', label: '재구매', w: 36, re: /재구매|재주문|다시 (샀|구매)|repurchase/i },
      { id: 'rating', label: '평점·만족도', w: 36, re: /만족도|평점|별점|★|\d\.\d\s*\/\s*5|rated/i },
      { id: 'quote', label: '인용', w: 22, re: /["“”][^"“”]{6,}["“”]/ },
      { id: 'bestseller', label: '베스트·판매 1위', w: 32, re: /베스트|판매 1위|best.?sell|인기 (1위|상품)/i }
    ],
    scarcity: [
      { id: 'limited', label: '한정', w: 40, re: /한정|한정판|limited|한정 수량/ },
      { id: 'first-come', label: '선착순', w: 40, re: /선착순|먼저 (신청|구매)|first come/i },
      { id: 'deadline', label: '마감·오늘까지', w: 40, re: /오늘까지|내일까지|마감|마감일|종료|ends (today|soon)|today only/i },
      { id: 'dday', label: 'D-day·남은 시간', w: 36, re: /D-\d|디데이|남은 시간|남은 기간|시간 남|hours? left/i },
      { id: 'soldout', label: '품절·재입고', w: 32, re: /품절|재입고|완판|sold out/i },
      { id: 'stock', label: '잔여 수량', w: 34, re: /잔여|남은 수량|재고 \d|\d+\s*(세트|개|장|자리|좌석)\s*(남|한정)/ }
    ],
    authority: [
      { id: 'measured', label: '실측·측정', w: 42, re: /실측|측정|계측|테스트 결과|시험 결과|tested/i },
      { id: 'data', label: '데이터·통계', w: 36, re: /데이터|통계|리서치|조사 결과|연구|data|study/i },
      { id: 'certified', label: '인증·특허·임상', w: 42, re: /인증|특허|임상|허가|certified|patent/i },
      { id: 'source', label: '출처·근거', w: 30, re: /출처|근거|기준으로|according to/i },
      { id: 'expert', label: '전문가·연구자', w: 30, re: /전문가|박사|교수|연구원|기자|전문의/ },
      { id: 'official', label: '공식', w: 24, re: /공식|공인|정부|협회/ },
      { id: 'hands-on', label: '직접 써봄', w: 36, re: /직접 (해봤|써봤|사용해)|써보니|1년 (써|사용)|직접 확인/ }
    ],
    cta: [
      { id: 'click', label: '클릭·버튼', w: 30, re: /클릭|버튼|눌러|아래에서|click|tap/i },
      { id: 'now', label: '지금·바로', w: 24, re: /지금|바로|즉시|right now/i },
      { id: 'free', label: '무료', w: 36, re: /무료|공짜|0원|free/i },
      { id: 'fast', label: '한 번에·3초', w: 36, re: /한 번에|한번에|3초|1분|10초|단 1(분|초)|in \d+ (seconds|minutes)/i },
      { id: 'no-friction', label: '가입·설치 없이', w: 42, re: /가입 없이|설치 없이|결제 없이|로그인 없이|no sign-?up|without installing/i },
      { id: 'action-verb', label: '확인·받아보기', w: 30, re: /확인하(세요|기|러)|받아보(세요|기)|시작하(세요|기)|신청하(세요|기)|열어보(세요|기)|다운로드/ },
      { id: 'imperative', label: '명령형', w: 18, re: /(하세요|해보세요|보세요|잡으세요|누르세요)/ },
      { id: 'buy', label: '구매·주문 버튼', w: 14, re: /구매하기|주문하기|장바구니|바로 구매/ }
    ]
  };

  /** 한 트리거의 점수 계산: 서로 다른 신호 합 + 반복 보너스(최대 12). */
  function scoreTrigger(text, id) {
    var signals = SIGNALS[id] || [];
    var sum = 0, distinct = 0, totalHits = 0;
    var hits = [];
    for (var i = 0; i < signals.length; i++) {
      var s = signals[i];
      var c = countOf(text, s.re);
      if (c > 0) {
        sum += s.w;
        distinct++;
        totalHits += c;
        var f = firstMatch(text, s.re);
        hits.push({ id: s.id, label: s.label, count: c, phrase: f ? f.phrase : '', index: f ? f.index : -1 });
      }
    }
    if (distinct > 0) sum += Math.min(12, (totalHits - distinct) * 3);
    return { score: clamp(Math.round(sum), 0, 100), hits: hits, distinct: distinct, totalHits: totalHits };
  }

  function gradeOf(score) {
    var s = num(score);
    if (s >= 85) return { id: 'S', label: 'S', title: '전환 설계 완성', tone: 's', desc: '8개 트리거가 서로를 보강하고 있습니다. 그대로 테스트해도 됩니다.' };
    if (s >= 70) return { id: 'A', label: 'A', title: '강한 카피', tone: 'a', desc: '핵심 축은 살아 있습니다. 비어 있는 트리거 1~2개만 채우면 S입니다.' };
    if (s >= 55) return { id: 'B', label: 'B', title: '보통', tone: 'b', desc: '설득은 되지만 결정을 미루게 하는 구멍이 있습니다.' };
    if (s >= 40) return { id: 'C', label: 'C', title: '약함', tone: 'c', desc: '정보 전달에 가깝습니다. 감정 축(손실·호기심)이 비어 있습니다.' };
    return { id: 'D', label: 'D', title: '재작성 권장', tone: 'd', desc: '아직 카피가 아니라 설명문입니다. 프레임워크로 다시 세우세요.' };
  }

  /**
   * 카피 진단.
   * @param {string} text
   * @param {object} [opts] { strict:boolean, extraTriggers:boolean }
   * @returns {{version,total,grade,triggers,gaps,strengths,stats,recommendations}}
   */
  function diagnose(text, opts) {
    opts = opts || {};
    var t = str(text);
    var chars = countChars(t);
    var sentences = sentenceSplit(t);

    var results = TRIGGERS.map(function (tr) {
      var r = scoreTrigger(t, tr.id);
      return {
        id: tr.id, name: tr.name, en: tr.en, weight: tr.weight,
        claim: tr.claim, question: tr.question, fix: tr.fix,
        score: r.score, hits: r.hits,
        level: r.score >= 70 ? 'strong' : (r.score >= 40 ? 'ok' : 'weak')
      };
    });

    var total = 0;
    results.forEach(function (r) { total += r.score * r.weight; });
    total = Math.round(total / 100);

    var gaps = results.slice().sort(function (a, b) {
      return (b.weight * (100 - b.score)) - (a.weight * (100 - a.score));
    }).filter(function (r) { return r.score < 70; })
      .map(function (r) {
        return {
          id: r.id, name: r.name, score: r.score, weight: r.weight,
          impact: Math.round(r.weight * (100 - r.score) / 100),
          action: r.fix
        };
      });

    var strengths = results.filter(function (r) { return r.score >= 70; })
      .sort(function (a, b) { return b.score - a.score; })
      .map(function (r) { return { id: r.id, name: r.name, score: r.score }; });

    var weak = results.filter(function (r) { return r.score < 40; });
    var stats = {
      chars: chars,
      sentences: sentences.length,
      avgSentenceLength: sentences.length ? Math.round(chars / sentences.length) : 0,
      coverage: results.filter(function (r) { return r.score >= 50; }).length,
      dominant: results.slice().sort(function (a, b) { return b.score - a.score; })[0].id
    };

    var recommendations = gaps.slice(0, 3).map(function (g, i) {
      return {
        rank: i + 1, trigger: g.id, name: g.name, current: g.score,
        impact: g.impact, target: Math.min(100, g.score + 30), action: g.action
      };
    });

    if (!t.trim()) {
      recommendations = TRIGGERS.slice(0, 3).map(function (tr, i) {
        return { rank: i + 1, trigger: tr.id, name: tr.name, current: 0, impact: 15, target: 40, action: tr.fix };
      });
    }

    return {
      version: VERSION,
      total: clamp(total, 0, 100),
      grade: gradeOf(total),
      triggers: results,
      strengths: strengths,
      gaps: gaps,
      weakCount: weak.length,
      recommendations: recommendations,
      stats: stats,
      flags: {
        empty: !t.trim(),
        tooShort: chars > 0 && chars < 40,
        tooLong: chars > 1200,
        needsEvidence: results.filter(function (r) { return (r.id === 'authority' || r.id === 'anchor') && r.score < 40; }).length === 2
      }
    };
  }

  /** 트리거 1개만 빠르게 점수화 */
  function scoreOne(text, triggerId) {
    if (!SIGNALS[triggerId]) throw new Error('unknown trigger: ' + triggerId);
    return scoreTrigger(str(text), triggerId);
  }

  /** 트리거 목록(복사본) */
  function listTriggers() {
    return TRIGGERS.map(function (t) {
      return { id: t.id, name: t.name, en: t.en, weight: t.weight, claim: t.claim, question: t.question, fix: t.fix };
    });
  }

  /* ==========================================================
     2. 4대 카피 프레임워크 생성기
     ========================================================== */

  var FRAMEWORKS = [
    { id: 'PAS', name: '문제-자극-해결', en: 'Problem · Agitate · Solution', sections: ['문제', '자극', '해결'],
      bestFor: ['고통이 분명한 문제 해결형', '상세페이지 상단', '리타게팅 광고'],
      triggers: ['loss', 'anchor', 'cta'] },
    { id: 'BAB', name: '이전-이후-다리', en: 'Before · After · Bridge', sections: ['이전', '이후', '다리'],
      bestFor: ['변화가 눈에 보이는 제품', '전후 비교', '체험단·후기형'],
      triggers: ['loss', 'anchor', 'social'] },
    { id: 'AIDA', name: '주의-흥미-욕구-행동', en: 'Attention · Interest · Desire · Action', sections: ['주의', '흥미', '욕구', '행동'],
      bestFor: ['처음 보는 사람', 'SNS·숏폼 첫 3초', '브랜드 인지'],
      triggers: ['curiosity', 'interrupt', 'social', 'cta'] },
    { id: '4U', name: '유용·긴급·독특·구체', en: 'Useful · Urgent · Unique · Ultra-specific', sections: ['유용', '긴급', '독특', '구체'],
      bestFor: ['헤드라인·배너', '카드뉴스 1장', '광고 소재'],
      triggers: ['anchor', 'scarcity', 'authority'] }
  ];

  var FRAMEWORK_INDEX = (function () {
    var m = {};
    FRAMEWORKS.forEach(function (f) { m[f.id] = f; });
    return m;
  })();

  var DEFAULT_INPUT = {
    product: '이 제품',
    target: '고객',
    problem: '지금 방식으로는 해결되지 않는 불편',
    solution: '한 번에 끝내는 방법',
    proof: '',
    cta: '지금 확인하기',
    urgency: '',
    priceBefore: '',
    priceAfter: '',
    guarantee: '',
    brand: '',
    tone: 'casual'
  };

  function normalizeInput(input) {
    var src = input || {};
    var out = {};
    Object.keys(DEFAULT_INPUT).forEach(function (k) {
      var v = src[k];
      out[k] = (v === null || v === undefined || String(v).trim() === '') ? DEFAULT_INPUT[k] : String(v).trim();
    });
    // 숫자형 가격은 문자열로 정규화
    ['priceBefore', 'priceAfter'].forEach(function (k) {
      if (src[k] !== undefined && src[k] !== null && src[k] !== '') out[k] = String(src[k]).trim();
      else out[k] = '';
    });
    out.tone = ['casual', 'expert', 'bold', 'review'].indexOf(src.tone) >= 0 ? src.tone : 'casual';
    out._seed = [out.product, out.target, out.problem, out.solution, out.proof, out.cta].join('|');
    return out;
  }

  /** 가격 표기: 정가/판매가가 있으면 앵커 문장 생성 */
  function priceLine(I) {
    if (I.priceBefore && I.priceAfter) {
      return '정가 ' + I.priceBefore + ' → 지금 ' + I.priceAfter;
    }
    if (I.priceAfter) return '지금 ' + I.priceAfter;
    return '';
  }

  function proofLine(I) {
    if (!I.proof) return '';
    return /[.!?]$/.test(I.proof) ? I.proof : I.proof + '.';
  }

  function ctaLine(I, suffix) {
    var c = I.cta || '지금 확인하기';
    return suffix ? c + ' — ' + suffix : c;
  }

  function buildPAS(I, variant) {
    var v = variant || 0;
    var pl = priceLine(I);
    var title = [
      I.problem + ', 아직도 그대로인가요?',
      withJosa(I.product, '으로로') + ' ' + I.solution
    ][v % 2];

    var problem = withJosa(I.target, '은는') + ' 이 장면을 아실 겁니다. ' + sent(I.problem) +
      ' 익숙해서 그냥 넘기고 있진 않나요?';

    var agitate = sent('문제는 여기서 끝나지 않습니다. ' + I.problem + ' — 그대로 두면 매번 같은 자리에서 다시 막힙니다') +
      ' 그때마다 시간과 돈이 조용히 새어 나갑니다.' +
      (I.urgency ? ' ' + sent(I.urgency) : '');

    var solution = withJosa(I.product, '은는') + ' ' + sent(I.solution) +
      (pl ? ' ' + sent(pl) : '') +
      (I.proof ? ' ' + proofLine(I) : '') +
      ' ' + sent(ctaLine(I, I.guarantee || '가입 없이 직접 확인'));

    return {
      id: 'PAS',
      name: FRAMEWORK_INDEX.PAS.name,
      title: title,
      sections: [
        { key: 'problem', label: '문제', text: problem },
        { key: 'agitate', label: '자극', text: agitate },
        { key: 'solution', label: '해결', text: solution }
      ]
    };
  }

  function buildBAB(I, variant) {
    var v = variant || 0;
    var pl = priceLine(I);
    var title = [
      '“' + I.problem + '” → “' + I.solution + '”',
      I.product + ' 하나로 바뀌는 ' + withJosa(I.target, '의') + ' 하루'
    ][v % 2];

    var before = '지금 ' + withJosa(I.target, '의') + ' 하루는 이 문장으로 요약됩니다. “' + I.problem + '.”' +
      ' 그대로 두면 내일도 같은 장면이 반복됩니다.';

    var after = withJosa(I.product, '을를') + ' 쓰면 ' + sent(I.solution) +
      (I.proof ? ' ' + proofLine(I) : '') +
      (pl ? ' ' + sent(pl) : '');

    var bridge = sent('바꾸는 데 필요한 건 하나입니다. ' + ctaLine(I, '가입 없이 3분, 직접 확인')) +
      (I.urgency ? ' ' + sent(I.urgency) : '');

    return {
      id: 'BAB',
      name: FRAMEWORK_INDEX.BAB.name,
      title: title,
      sections: [
        { key: 'before', label: '이전', text: before },
        { key: 'after', label: '이후', text: after },
        { key: 'bridge', label: '다리', text: bridge }
      ]
    };
  }

  function buildAIDA(I, variant) {
    var v = variant || 0;
    var pl = priceLine(I);
    var attention = [
      '“' + I.problem + '” — ' + withJosa(I.target, '이라면') + ' 멈칫하는 문장입니다. 지친 적 있으신가요?',
      '아직도 ' + I.problem + '? 원인은 다른 데 있습니다.'
    ][v % 2];

    var interest = withJosa(I.product, '은는') + ' 기능을 늘리는 대신 딱 하나에 집중했습니다. ' + sent(I.solution);
    var desire = (I.proof ? proofLine(I) + ' ' : '') +
      '이제 그 장면으로 돌아갈 이유가 없습니다.' +
      (pl ? ' ' + sent(pl) : '');
    var action = sent(ctaLine(I, '가입 없이 지금 바로')) +
      (I.urgency ? ' ' + sent(I.urgency) : '') +
      (I.guarantee ? ' ' + sent(I.guarantee) : '');

    return {
      id: 'AIDA',
      name: FRAMEWORK_INDEX.AIDA.name,
      title: I.product + ' — ' + I.solution,
      sections: [
        { key: 'attention', label: '주의', text: attention },
        { key: 'interest', label: '흥미', text: interest },
        { key: 'desire', label: '욕구', text: desire },
        { key: 'action', label: '행동', text: action }
      ]
    };
  }

  function build4U(I, variant) {
    var v = variant || 0;
    var pl = priceLine(I);
    var hasNumber = /\d/.test(I.proof + ' ' + I.solution + ' ' + I.problem);
    var title = [
      I.product + ', ' + I.solution,
      (hasNumber ? '' : '딱 하나만 바꿨습니다. ') + I.problem + ' 없이 ' + I.solution
    ][v % 2];

    var useful = withJosa(I.target, '을를') + ' 위한 설계입니다. ' + I.problem + ' — 이 문장이 사라집니다.' +
      ' 쓸모없는 기능은 덜어냈습니다.';
    var urgent = I.urgency
      ? sent(I.urgency)
      : sent((/^(오늘|지금|바로)/.test(I.cta) ? '' : '오늘 ') + I.cta + ' — 내일은 조건이 달라질 수 있습니다');
    var unique = '다른 해결책이 아니라 ' + I.product + '인 이유는 하나입니다. ' + sent(I.solution) +
      (pl ? ' ' + sent(pl) : '');
    var specific = I.proof
      ? proofLine(I) + ' 숫자로 직접 확인하세요.'
      : '숫자로 확인하세요. (증거 수치를 넣으면 4U가 완성됩니다: 사용자 수·기간·측정값)';

    return {
      id: '4U',
      name: FRAMEWORK_INDEX['4U'].name,
      title: title,
      sections: [
        { key: 'useful', label: '유용', text: useful },
        { key: 'urgent', label: '긴급', text: urgent },
        { key: 'unique', label: '독특', text: unique },
        { key: 'specific', label: '구체', text: specific }
      ]
    };
  }

  var BUILDERS = { PAS: buildPAS, BAB: buildBAB, AIDA: buildAIDA, '4U': build4U };

  /**
   * 프레임워크 1종 생성.
   * @param {'PAS'|'BAB'|'AIDA'|'4U'} id
   * @param {object} input
   * @param {object} [opts] { variant:0|1 }
   */
  function build(id, input, opts) {
    opts = opts || {};
    var key = String(id || '').toUpperCase();
    if (!BUILDERS[key]) throw new Error('unknown framework: ' + id);
    var I = normalizeInput(input);
    var raw = BUILDERS[key](I, opts.variant || 0);

    var body = raw.sections.map(function (s) { return s.text; }).join('\n\n');
    var diag = diagnose(body);

    return {
      id: raw.id,
      name: raw.name,
      en: FRAMEWORK_INDEX[raw.id].en,
      title: raw.title,
      sections: raw.sections,
      body: body,
      chars: countChars(body + ' ' + raw.title),
      psych: {
        total: diag.total,
        grade: diag.grade,
        strong: diag.strengths.map(function (s) { return s.id; }),
        gaps: diag.gaps.slice(0, 2).map(function (g) { return g.id; })
      },
      input: I
    };
  }

  /**
   * 4종 동시 생성 + 비교.
   * @returns {{items:Array, best:object, comparison:Array}}
   */
  function generateAll(input, opts) {
    opts = opts || {};
    var items = FRAMEWORKS.map(function (f) {
      return build(f.id, input, { variant: opts.variant || 0 });
    });
    var comparison = items.map(function (it) {
      return {
        id: it.id, name: it.name, title: it.title,
        chars: it.chars, psychScore: it.psych.total,
        grade: it.psych.grade.id,
        strong: it.psych.strong
      };
    }).sort(function (a, b) { return b.psychScore - a.psychScore; });

    var bestId = comparison[0].id;
    var best = items.filter(function (it) { return it.id === bestId; })[0];

    return {
      items: items,
      best: best,
      comparison: comparison,
      recommendation: recommendFramework(input, best)
    };
  }

  /** 입력 성격에 따른 프레임워크 추천 */
  function recommendFramework(input, best) {
    var I = normalizeInput(input);
    var reasons = [];
    var id = 'PAS';

    if (I.proof && /\d/.test(I.proof)) { id = 'BAB'; reasons.push('증거 수치가 있어 전후 대비가 가장 강합니다.'); }
    else if (I.urgency) { id = '4U'; reasons.push('기한·수량이 있어 4U의 긴급 축이 바로 삽니다.'); }
    else if (!I.problem || I.problem === DEFAULT_INPUT.problem) { id = 'AIDA'; reasons.push('문제 정의가 비어 있어 주의를 끄는 AIDA가 안전합니다.'); }

    if (best && reasons.length === 0) {
      id = best.id;
      reasons.push('생성 결과 자체 점검이 ' + best.psych.total + '점으로 가장 높았습니다.');
    }
    if (I.target === DEFAULT_INPUT.target) reasons.push('타겟을 한 줄로 좁히면 점수가 더 오릅니다.');
    if (!I.proof) reasons.push('증거 수치(사용자 수·기간·측정값)를 넣으면 권위 점수가 함께 올라갑니다.');

    return {
      id: id,
      name: FRAMEWORK_INDEX[id].name,
      reasons: reasons,
      alternative: id === 'PAS' ? 'BAB' : 'PAS'
    };
  }

  /* ==========================================================
     3. 전환율 감점 표현 탐지 · 교정
     ========================================================== */

  var RULE_TYPES = {
    abstract: { label: '추상어', severity: 8, color: 'amber', desc: '형용사는 신뢰를 만들지 못합니다. 수치·인증·조건으로 바꾸세요.' },
    supplier: { label: '공급자 중심', severity: 12, color: 'red', desc: '말하는 사람이 아니라 듣는 사람이 주어가 되어야 합니다.' },
    passive: { label: '피동·번역체', severity: 7, color: 'violet', desc: '번역투는 신뢰를 깎고 리듬을 죽입니다.' },
    vague: { label: '모호한 약속', severity: 6, color: 'slate', desc: '측정할 수 없는 약속은 광고 문구로 읽힙니다.' },
    weak: { label: '군더더기', severity: 4, color: 'slate', desc: '강조 부사는 빼도 의미가 그대로입니다.' },
    risk: { label: '표시광고 위험', severity: 15, color: 'red', desc: '최상급·1위 표현은 근거가 없으면 법적 리스크입니다.' }
  };

  var RULES = [
    /* ── 추상어 ── */
    { id: 'abs-best', type: 'abstract', re: /최고의|최상의|최고급|최상급|가장 좋은/g, terms: ['최고의', '최상의', '최고급', '최상급', '가장 좋은'],
      reason: '비교 기준이 없는 최상급은 소비자가 검증할 수 없습니다.',
      alternative: '“[인증명] 인증” 또는 “누적 판매 [수치]건”', example: '최고의 품질 → HACCP 인증 시설에서 만든' },
    { id: 'abs-various', type: 'abstract', re: /다양한|여러 가지|각종/g, terms: ['다양한', '여러 가지', '각종'],
      reason: '개수가 없으면 선택의 폭이 아니라 정리의 부재로 읽힙니다.',
      alternative: '“12가지”, “3종”처럼 실제 개수', example: '다양한 색상 → 7가지 색상' },
    { id: 'abs-innovative', type: 'abstract', re: /혁신적인|혁신적|획기적인|획기적|차별화된|차별화된|독보적인|압도적인/g,
      terms: ['혁신적인', '혁신적', '획기적인', '획기적', '차별화된', '독보적인', '압도적인'],
      reason: '무엇이 어떻게 다른지가 빠져 있습니다.',
      alternative: '“기존 [X] 대비 [수치] 개선”', example: '혁신적인 설계 → 부품 3개를 없애 조립 시간을 12분에서 4분으로' },
    { id: 'abs-efficient', type: 'abstract', re: /효율적인|효율적|합리적인|합리적/g, terms: ['효율적인', '효율적', '합리적인', '합리적'],
      reason: '효율은 시간·비용·인원 중 무엇이 줄었는지 말해야 성립합니다.',
      alternative: '“월 [금액] 절감”, “주 [시간] 단축”', example: '효율적인 관리 → 한 달 6시간 → 40분' },
    { id: 'abs-premium', type: 'abstract', re: /프리미엄|고급스러운|고급진/g, terms: ['프리미엄', '고급스러운', '고급진'],
      reason: '가격을 정당화하는 것은 형용사가 아니라 소재·공정입니다.',
      alternative: '소재명·공정·원산지', example: '프리미엄 원단 → 이탈리아 비엘라(Biella) 울 80%' },
    { id: 'abs-perfect', type: 'abstract', re: /완벽한|완벽하게|완벽한|무결점/g, terms: ['완벽한', '완벽하게', '무결점'],
      reason: '완벽은 검증 불가능하며, 실패 시 신뢰 손실이 큽니다.',
      alternative: '보증 범위·환불 조건', example: '완벽한 마감 → 30일 내 하자 시 전액 환불' },
    { id: 'abs-optimal', type: 'abstract', re: /최적의|최적화된|맞춤형|맞춤/g, terms: ['최적의', '최적화된', '맞춤형'],
      reason: '누구에게 최적인지 조건이 없습니다.',
      alternative: '“A 조건에서 B가 되는” 식의 조건 명시', example: '최적의 온도 → 실내 22℃에서 4시간 유지' },
    { id: 'abs-expert', type: 'abstract', re: /전문가(가|의)? (엄선|추천|선택)|전문적인/g, terms: ['전문가 엄선', '전문가 추천', '전문적인'],
      reason: '전문가가 누구인지 밝히지 않으면 권위가 아니라 주장입니다.',
      alternative: '자격·경력·소속', example: '전문가 엄선 → 피부과 전문의 3인이 12주 임상 후 선정' },
    { id: 'abs-new', type: 'abstract', re: /새로운|신개념|차세대/g, terms: ['새로운', '신개념', '차세대'],
      reason: '새롭다는 사실은 구매 이유가 되지 않습니다.',
      alternative: '기존 대비 달라진 점 1가지', example: '신개념 정리함 → 뚜껑을 열지 않고 앞에서 꺼내는 구조' },

    /* ── 공급자 중심 ── */
    { id: 'sup-provide', type: 'supplier', re: /저희(는|가)?\s*[^.!?\n]{0,24}(제공|판매|운영|서비스)(해 드립니다|합니다|드립니다|하고 있습니다)/g,
      reason: '“저희가 제공합니다”는 회사가 주어입니다. 소비자가 얻는 것으로 바꾸세요.',
      alternative: '“[혜택]을 받아보세요”', example: '저희는 무료 배송을 제공합니다 → 오늘 주문하면 내일 문 앞에 도착합니다',
      auto: function (m) { return '지금 바로 받아보세요'; } },
    { id: 'sup-company', type: 'supplier', re: /(당사는|당사가|본사는|저희 회사는)/g, terms: ['당사는', '당사가', '본사는', '저희 회사는'],
      reason: '회사 소개 문장은 상세페이지에서 이탈을 만듭니다.',
      alternative: '삭제하고 고객 상황부터 시작', example: '당사는 2010년 설립된… → 아침마다 30분을 잃고 있다면' },
    { id: 'sup-thanks', type: 'supplier', re: /(구매|주문|이용)해 주셔서 (감사합니다|감사드립니다)/g,
      reason: '감사 인사는 구매 이후의 언어입니다. 구매 전에는 다음 행동을 주세요.',
      alternative: '“지금 받아보세요”', example: '구매해 주셔서 감사합니다 → 지금 주문하면 3일 안에 도착합니다',
      auto: function () { return '지금 바로 받아보세요'; } },
    { id: 'sup-interest', type: 'supplier', re: /많은 (관심|성원) (부탁드립니다|바랍니다)/g,
      reason: '관심을 부탁하는 문장은 아무 행동도 만들지 않습니다.',
      alternative: '구체적 행동 + 혜택', example: '많은 관심 부탁드립니다 → 아래에서 3초 만에 견적을 확인하세요',
      auto: function () { return '지금 확인해 보세요'; } },
    { id: 'sup-inquiry', type: 'supplier', re: /(문의|상담)\s*(주시면|신청해 주시면|주세요)[^.!?\n]{0,20}(안내|알려|드리)/g,
      reason: '“문의 주세요”는 마찰이 큰 CTA입니다. 한 단계를 없애세요.',
      alternative: '“바로 확인하기 · 가입 없이”', example: '문의 주시면 안내해 드립니다 → 아래 링크에서 바로 확인하세요' },
    { id: 'sup-intro', type: 'supplier', re: /(제품|상품|서비스)을 소개(합니다|드립니다|해 드립니다)/g,
      reason: '소개부터 시작하면 독자는 “내 얘기인가?”를 판단할 수 없습니다.',
      alternative: '고객의 문제 문장으로 시작', example: '이 제품을 소개합니다 → 매일 아침 30분, 이걸 찾다가 날립니다' },

    /* ── 피동·번역체 ── */
    { id: 'pas-double', type: 'passive', re: /되어집니다|되어져|되어질 수 있(습니다|다)|되어진/g, terms: ['되어집니다', '되어져', '되어질 수 있습니다', '되어진'],
      reason: '이중 피동은 한국어에서 어색하고 신뢰를 떨어뜨립니다.',
      alternative: '“됩니다”', example: '선택되어집니다 → 선택됩니다',
      auto: function (m) { return /되어질/.test(m) ? '됩니다' : (/되어진/.test(m) ? '된' : (/되어져/.test(m) ? '되어' : '됩니다')); } },
    { id: 'pas-by', type: 'passive', re: /에 의해/g, terms: ['에 의해'],
      reason: '“~에 의해”는 영어 수동태의 직역입니다.',
      alternative: '“~가/이”', example: '전문가에 의해 검증 → 전문가 3인이 검증' },
    { id: 'pas-possible', type: 'passive', re: /(하는 것이|할 것이) 가능(합니다|하다)|가능합니다/g, terms: ['하는 것이 가능합니다', '할 것이 가능합니다', '가능합니다'],
      reason: '“가능합니다”는 행동을 흐립니다.',
      alternative: '“~합니다”', example: '설치하는 것이 가능합니다 → 설치 없이 바로 씁니다' },
    { id: 'passive-verb', type: 'passive', re: /(이|가|은|는) (선택|제공|결정|진행|처리)됩니다/g,
      reason: '행위자가 사라진 문장은 책임도 사라집니다.',
      alternative: '행위자를 주어로', example: '배송이 처리됩니다 → 오후 2시 전 주문은 당일 출고합니다' },
    { id: 'trans-it', type: 'passive', re: /그것은|그것이|그것을/g, terms: ['그것은', '그것이', '그것을'],
      reason: '“그것”은 지시 대상이 불분명한 번역투입니다.',
      alternative: '구체 명사로', example: '그것은 시간을 절약합니다 → 정리 시간이 30분 줄어듭니다' },
    { id: 'trans-through', type: 'passive', re: /을 통해|를 통해/g, terms: ['을 통해', '를 통해'],
      reason: '“~을 통해”는 문장을 길게만 만듭니다.',
      alternative: '“~로/해서”', example: '앱을 통해 확인 → 앱에서 바로 확인' },
    { id: 'trans-regarding', type: 'passive', re: /에 대한|에 있어서|에 관하여/g, terms: ['에 대한', '에 있어서', '에 관하여'],
      reason: '“~에 대한”은 명사를 겹겹이 쌓는 번역투입니다.',
      alternative: '명사를 동사로 풀기', example: '가격에 대한 안내 → 가격은 이렇습니다' },
    { id: 'trans-claim', type: 'passive', re: /(라고|고) 할 수 있(습니다|다)|라는 점에서/g, terms: ['라고 할 수 있습니다', '라는 점에서'],
      reason: '단정을 피하는 어미는 확신을 깎습니다.',
      alternative: '“~입니다”', example: '좋은 선택이라고 할 수 있습니다 → 첫달 8,400명이 선택했습니다' },
    { id: 'trans-nominal', type: 'passive', re: /(화|[을를])\s?진행(합니다|하겠습니다|할 예정)|검토를 진행/g, terms: ['화를 진행합니다', '를 진행합니다'],
      reason: '“진행합니다”는 동작을 명사로 숨깁니다.',
      alternative: '동사 하나로', example: '점검을 진행합니다 → 점검합니다' },
    { id: 'trans-many', type: 'vague', re: /여러분의 (소중한|즐거운|편리한)/g, terms: ['여러분의 소중한', '여러분의 즐거운', '여러분의 편리한'],
      reason: '호칭형 수식은 누구에게나 해당해 누구에게도 해당하지 않습니다.',
      alternative: '타겟을 명시', example: '여러분의 소중한 시간 → 퇴근 후 2시간' },

    /* ── 모호한 약속 ── */
    { id: 'vague-quality', type: 'vague', re: /품질 (보장|좋은)|믿을 수 있는|안심하고 (사용|이용)/g, terms: ['품질 보장', '품질이 좋은', '믿을 수 있는', '안심하고 사용'],
      reason: '“믿을 수 있는”은 근거가 아니라 부탁입니다.',
      alternative: '인증·보증·환불 조건', example: '믿을 수 있는 제품 → 30일 내 불만족 시 전액 환불' },
    { id: 'vague-fast', type: 'vague', re: /빠른 (배송|처리|응답)|신속하게/g, terms: ['빠른 배송', '빠른 처리', '빠른 응답', '신속하게'],
      reason: '“빠른”은 기준이 없습니다.',
      alternative: '기준 시각·소요 시간', example: '빠른 배송 → 오후 2시 전 주문 시 당일 출고, 평균 1.2일 도착' },
    { id: 'vague-cheap', type: 'vague', re: /저렴한 가격|합리적인 가격|가성비 (최고|갑)/g, terms: ['저렴한 가격', '합리적인 가격', '가성비 최고', '가성비 갑'],
      reason: '가격은 비교 기준이 있어야 싸게 보입니다.',
      alternative: '비교 앵커 + 실제 금액', example: '합리적인 가격 → 같은 용량 타사 39,000원, 여기는 24,900원' },

    /* ── 군더더기 ── */
    { id: 'weak-very', type: 'weak', re: /(매우|정말로|굉장히|아주|너무나)\s/g, terms: ['매우', '정말로', '굉장히', '아주', '너무나'],
      reason: '강조 부사는 형용사를 더 약하게 만듭니다.',
      alternative: '삭제하고 수치로', example: '매우 빠른 → 3초',
      auto: function () { return ''; } },
    { id: 'weak-really', type: 'weak', re: /정말 (좋은|편한|쉬운)/g, terms: ['정말 좋은', '정말 편한', '정말 쉬운'],
      reason: '감탄은 독자의 것이어야 합니다.',
      alternative: '경험 장면', example: '정말 편한 → 한 손으로 3초 만에' },

    /* ── 표시광고 위험 ── */
    { id: 'risk-no1', type: 'risk', re: /(국내|업계|판매)\s*1위|1등/g, terms: ['국내 1위', '업계 1위', '판매 1위', '1등'],
      reason: '1위 표현은 조사 시점·범위·출처가 없으면 표시광고법 위반 소지가 있습니다.',
      alternative: '“2025년 ○○협회 조사 기준”처럼 근거 명시', example: '판매 1위 → 2025 상반기 ○○ 조사 카테고리 매출 1위' },
    { id: 'risk-only', type: 'risk', re: /유일(한|무이)|유일하게|오직 (우리|여기)만/g, terms: ['유일한', '유일무이', '유일하게', '오직 우리만'],
      reason: '유일성 주장은 반증 한 건으로 무너집니다.',
      alternative: '객관적 차이 1가지', example: '유일한 특허 → 특허 10-1234567 (2023 등록)' },
    { id: 'risk-guarantee', type: 'risk', re: /100% (보장|효과)|부작용 (없|전혀)/g, terms: ['100% 보장', '100% 효과', '부작용 없'],
      reason: '절대 보장 표현은 의약·건강 분야에서 특히 위험합니다.',
      alternative: '조건부 보증', example: '100% 효과 → 4주 사용 후 개선 체감 62% (자체 설문 214명)' }
  ];

  /** 규칙별 매치 수집 */
  function detect(text) {
    var t = str(text);
    var issues = [];
    for (var i = 0; i < RULES.length; i++) {
      var r = RULES[i];
      var re = new RegExp(r.re.source, 'g');
      var m;
      while ((m = re.exec(t)) !== null) {
        if (m[0] === '') { re.lastIndex++; continue; }
        var type = RULE_TYPES[r.type];
        issues.push({
          ruleId: r.id,
          type: r.type,
          typeLabel: type.label,
          severity: type.severity,
          color: type.color,
          phrase: m[0],
          index: m.index,
          length: m[0].length,
          reason: r.reason,
          alternative: r.alternative,
          example: r.example || '',
          canAutoFix: typeof r.auto === 'function'
        });
        if (re.lastIndex === m.index) re.lastIndex++;
      }
    }
    issues.sort(function (a, b) { return a.index - b.index || b.severity - a.severity; });

    var penalty = 0;
    issues.forEach(function (is) { penalty += is.severity; });
    var score = clamp(Math.round(penalty), 0, 100);

    var byType = {};
    issues.forEach(function (is) {
      byType[is.type] = byType[is.type] || { type: is.type, label: is.typeLabel, count: 0, severity: 0 };
      byType[is.type].count++;
      byType[is.type].severity += is.severity;
    });

    var groups = Object.keys(byType).map(function (k) { return byType[k]; })
      .sort(function (a, b) { return b.severity - a.severity; });

    return {
      version: VERSION,
      text: t,
      chars: countChars(t),
      friction: score,
      grade: frictionGrade(score),
      count: issues.length,
      issues: issues,
      groups: groups,
      byType: byType
    };
  }

  function frictionGrade(score) {
    var s = num(score);
    if (s <= 0) return { id: 'clean', label: '감점 없음', tone: 'ok', desc: '전환을 막는 표현이 발견되지 않았습니다.' };
    if (s < 10) return { id: 'minor', label: '경미', tone: 'ok', desc: '한두 군데만 다듬으면 됩니다.' };
    if (s < 30) return { id: 'notice', label: '주의', tone: 'warn', desc: '설득력이 새는 구간이 있습니다.' };
    if (s < 55) return { id: 'serious', label: '심각', tone: 'danger', desc: '소비자 언어가 아니라 회사 언어로 쓰여 있습니다.' };
    return { id: 'critical', label: '치명적', tone: 'danger', desc: '카피가 아니라 공지문입니다. 전면 재작성이 빠릅니다.' };
  }

  /** 안전 자동 교정(문법·군더더기 수준). 사실을 새로 만들지 않는다. */
  function correct(text) {
    var t = str(text);
    var applied = [];
    RULES.forEach(function (r) {
      if (typeof r.auto !== 'function') return;
      var re = new RegExp(r.re.source, 'g');
      if (!re.test(t)) return;
      re.lastIndex = 0;
      t = t.replace(new RegExp(r.re.source, 'g'), function (m) {
        var rep = r.auto(m);
        applied.push({ ruleId: r.id, type: r.type, from: m, to: rep });
        return rep;
      });
    });
    t = t.replace(/[ \t]{2,}/g, ' ').replace(/ ([,.!?])/g, '$1').trim();

    var after = detect(t);
    return {
      text: t,
      applied: applied,
      after: after,
      before: detect(str(text)).friction,
      improved: Math.max(0, detect(str(text)).friction - after.friction)
    };
  }

  /** 남은 이슈를 종류별로 묶어 교정 액션 리스트로 */
  function actionList(text) {
    var d = detect(text);
    var acts = [];
    d.groups.forEach(function (g) {
      var samples = d.issues.filter(function (is) { return is.type === g.type; }).slice(0, 3);
      acts.push({
        type: g.type,
        label: g.label,
        count: g.count,
        severity: g.severity,
        samples: samples.map(function (s) { return { phrase: s.phrase, example: s.example }; }),
        action: RULE_TYPES[g.type].desc
      });
    });
    return acts;
  }

  /* ==========================================================
     4. 보조 라이브러리 (앱 UI용 레퍼런스)
     ========================================================== */

  var CTA_LIBRARY = {
    zero: [
      '3초 만에 확인 — 가입 없이',
      '링크 누르면 바로 시작 (설치 없음)',
      '무료로 먼저 받아보기',
      '오늘의 견적, 2분이면 끝',
      '지금 열어보기 — 결제 정보 필요 없음'
    ],
    low: [
      '내 조건으로 계산해보기',
      '샘플 3개 무료로 받기',
      '1분 진단 시작하기',
      '내 상품명 점수 확인하기'
    ],
    high: [
      '문의 주시면 안내해 드립니다',
      '상담 신청 후 담당자가 연락드립니다',
      '구매해 주셔서 감사합니다'
    ]
  };

  var HEADLINE_PATTERNS = [
    { id: 'number', pattern: '[숫자] + [기간] + [결과]', example: '3주 만에 재구매율 41% → 68%', triggers: ['anchor', 'authority'] },
    { id: 'mistake', pattern: '[하지 마세요] + [이유]', example: '지금 상세페이지를 고치지 마세요. 순서가 틀렸습니다', triggers: ['interrupt', 'curiosity'] },
    { id: 'who', pattern: '[타겟] + [상황] + [해결]', example: '퇴근 후 2시간, 정리 대신 이걸 하세요', triggers: ['loss', 'cta'] },
    { id: 'contrast', pattern: '[정가] → [판매가] + [이유]', example: '39,000원 → 24,900원, 유통 단계 3개를 뺐습니다', triggers: ['anchor', 'authority'] },
    { id: 'proof', pattern: '[사람 수] + [행동] + [결과]', example: '8,412명이 4주 만에 바꾼 것', triggers: ['social', 'curiosity'] },
    { id: 'deadline', pattern: '[기한] + [수량] + [혜택]', example: '금요일 23시 마감 · 잔여 37세트', triggers: ['scarcity', 'loss'] }
  ];

  /** 카피 종합 리포트: 진단 + 감점 + 교정 + 다음 액션 */
  function report(text) {
    var diag = diagnose(text);
    var det = detect(text);
    var fix = correct(text);
    return {
      version: VERSION,
      chars: diag.stats.chars,
      psych: { total: diag.total, grade: diag.grade, triggers: diag.triggers, gaps: diag.gaps },
      friction: { score: det.friction, grade: det.grade, count: det.count, groups: det.groups },
      corrected: fix,
      nextActions: diag.recommendations.concat(actionList(text)).slice(0, 5),
      headlineSuggestions: HEADLINE_PATTERNS.map(function (p) {
        return { pattern: p.pattern, example: p.example, triggers: p.triggers };
      })
    };
  }

  /* ==========================================================
     5. 내보내기
     ========================================================== */

  return {
    VERSION: VERSION,
    TRIGGERS: listTriggers(),
    FRAMEWORKS: FRAMEWORKS.map(function (f) { return { id: f.id, name: f.name, en: f.en, bestFor: f.bestFor, triggers: f.triggers }; }),
    RULE_TYPES: RULE_TYPES,
    RULES: RULES.map(function (r) { return { id: r.id, type: r.type, reason: r.reason, alternative: r.alternative, example: r.example, auto: typeof r.auto === 'function' }; }),
    CTA_LIBRARY: CTA_LIBRARY,
    HEADLINE_PATTERNS: HEADLINE_PATTERNS,

    diagnose: diagnose,
    gradeOf: gradeOf,
    scoreOne: scoreOne,
    listTriggers: listTriggers,

    build: build,
    generateAll: generateAll,
    recommendFramework: recommendFramework,
    normalizeInput: normalizeInput,

    detect: detect,
    correct: correct,
    actionList: actionList,
    frictionGrade: frictionGrade,
    report: report,

    /* 테스트·앱에서 쓰는 내부 유틸 */
    josa: josa,
    withJosa: withJosa,

    _util: { countOf: countOf, firstMatch: firstMatch, hash: hash, clamp: clamp, sent: sent, sentenceSplit: sentenceSplit, lastCharInfo: lastCharInfo }
  };
});
