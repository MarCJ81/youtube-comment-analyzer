/* ============================================================
   댓글 레이더 · core.js
   Pure logic: URL/ID parsing, Korean+English comment classification,
   keyword extraction, stats, FAQ / pinned-comment / content-idea
   generation, AI prompt builder, CSV·JSON export, paste parsers and
   the YouTube Data API v3 response mappers.

   No DOM, no network at load time. Works in the browser
   (window.CommentCore) and in Node (module.exports) for test.js.
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CommentCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ── categories ─────────────────────────────────────────── */
  const CATEGORIES = {
    purchase: { key: 'purchase', label: '구매의향·링크요청', short: '구매의향', tone: 'purchase' },
    question: { key: 'question', label: '질문·궁금증', short: '질문', tone: 'question' },
    positive: { key: 'positive', label: '긍정·칭찬', short: '긍정', tone: 'positive' },
    negative: { key: 'negative', label: '불만·아쉬움', short: '불만', tone: 'negative' },
    other: { key: 'other', label: '기타·분류 밖', short: '기타', tone: 'other' },
  };
  const TYPE_ORDER = ['purchase', 'question', 'positive', 'negative', 'other'];

  /* ── number / date formatting ───────────────────────────── */
  function trim1(v) {
    const r = Math.round(v * 10) / 10;
    return (r % 1 === 0 ? String(Math.round(r)) : r.toFixed(1));
  }

  function formatCount(n) {
    if (n === null || n === undefined || n === '' || isNaN(Number(n))) return '—';
    const v = Number(n);
    if (v < 0) return '—';
    if (v < 10000) return v.toLocaleString('en-US');
    if (v < 100000000) {
      const man = v / 10000;
      return (man >= 100 ? Math.round(man).toLocaleString('en-US') : trim1(man)) + '만';
    }
    const eok = v / 100000000;
    return (eok >= 100 ? Math.round(eok).toLocaleString('en-US') : trim1(eok)) + '억';
  }

  function formatPercent(v, digits) {
    if (v === null || v === undefined || isNaN(Number(v))) return '—';
    const d = digits === undefined ? 1 : digits;
    return Number(v).toFixed(d) + '%';
  }

  function formatRelative(number) {
    if (number === null || number === undefined || isNaN(Number(number))) return '—';
    const v = Math.abs(Number(number));
    if (v < 1000) return String(Math.round(v));
    if (v < 1000000) return trim1(v / 1000) + 'K';
    return trim1(v / 1000000) + 'M';
  }

  function relativeTime(input, now) {
    const t = typeof input === 'number' ? input : Date.parse(input);
    if (!t || isNaN(t)) return '—';
    const base = now === undefined ? Date.now() : (typeof now === 'number' ? now : Date.parse(now));
    const diff = base - t;
    if (diff < 0) {
      const ahead = Math.abs(diff);
      if (ahead < 60000) return '방금';
      if (ahead < 3600000) return Math.round(ahead / 60000) + '분 후';
      if (ahead < 86400000) return Math.round(ahead / 3600000) + '시간 후';
      return Math.round(ahead / 86400000) + '일 후';
    }
    if (diff < 60000) return '방금';
    const min = Math.floor(diff / 60000);
    if (min < 60) return min + '분 전';
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + '시간 전';
    const day = Math.floor(hr / 24);
    if (day < 7) return day + '일 전';
    if (day < 30) return Math.floor(day / 7) + '주 전';
    if (day < 365) return Math.floor(day / 30) + '개월 전';
    return Math.floor(day / 365) + '년 전';
  }

  /* ── YouTube URL / ID parsing ───────────────────────────── */
  const ID_RE = /^[A-Za-z0-9_-]{11}$/;

  function parseVideoId(input) {
    if (!input) return null;
    let s = String(input).trim();
    if (!s) return null;
    // strip surrounding angle brackets / quotes / trailing punctuation
    s = s.replace(/^[<"'\s]+|[>"'\s]+$/g, '');

    // bare id
    if (ID_RE.test(s)) return s;

    const patterns = [
      /(?:youtube\.com|youtube-nocookie\.com)\/watch\?(?:[^#]*&)?v=([A-Za-z0-9_-]{11})/i,
      /(?:youtube\.com|youtube-nocookie\.com)\/(?:shorts|live|embed|v)\/([A-Za-z0-9_-]{11})/i,
      /youtu\.be\/([A-Za-z0-9_-]{11})/i,
    ];
    for (const re of patterns) {
      const m = s.match(re);
      if (m) return m[1];
    }
    // last resort: an id-shaped token inside the string
    const loose = s.match(/(?:^|[^A-Za-z0-9_-])([A-Za-z0-9_-]{11})(?:[^A-Za-z0-9_-]|$)/);
    if (loose && /youtu/i.test(s)) return loose[1];
    return null;
  }

  function isShortsUrl(input) {
    return /\/shorts\//i.test(String(input || ''));
  }

  /* ── comment classification ─────────────────────────────── */
  // [phrase, weight] — longer/more specific phrases weigh more.
  const RULES = {
    purchase: [
      ['어디서 사', 6], ['어디서 구', 6], ['어디서 파', 6], ['어디서 팔', 6],
      ['링크 있으면', 5], ['링크 있나', 5], ['어디서 결제', 6], ['어디서 살', 6],
      ['어디서 살', 4], ['어디에 파', 3], ['구매 링크', 4], ['구매링크', 4],
      ['제품 링크', 4], ['링크 주', 5], ['링크주', 5], ['링크 좀', 5], ['링크좀', 5],
      ['링크 있', 3], ['링크 부탁', 4], ['링크 알려', 4], ['링크 남', 3],
      ['구매처', 4], ['판매처', 4], ['판매 링크', 4], ['판매처 알', 4],
      ['재입고', 6], ['품절', 4], ['입고', 4], ['주문하', 3], ['주문 했', 3],
      ['주문했', 3], ['구매했', 3], ['구매 함', 3], ['구매함', 3], ['구매 완료', 3],
      ['결제했', 3], ['샀어', 3], ['샀습니다', 3], ['샀어요', 3], ['구매하고 싶', 4],
      ['사고싶', 4], ['사고 싶', 4], ['살래', 3], ['살게요', 3], ['사야겠', 3],
      ['사야지', 3], ['장바구니', 3], ['스마트스토어', 3], ['쿠팡', 2], ['네이버 쇼핑', 3],
      ['모델명', 3], ['제품명', 3], ['어디 제품', 3], ['무슨 제품', 3],
      ['가격 알려', 3], ['가격 좀', 3], ['가격 문의', 3], ['얼마에 팔', 3],
      ['할인', 2], ['쿠폰', 2], ['배송', 2], ['구성품', 2],
      ['where to buy', 4], ['where can i buy', 4], ['where did you buy', 4],
      ['link please', 4], ['link pls', 4], ['send link', 4], ['link?', 3],
      ['purchase', 3], ['buy', 2], ['order', 2], ['sold out', 3], ['restock', 3],
      ['in stock', 3], ['price', 2], ['how much', 3], ['discount', 2], ['coupon', 2],
      ['shipping', 2], ['link', 2],
    ],
    question: [
      ['어떻게', 3], ['어떤 게', 3], ['어떤게', 3], ['어디서', 2], ['어디에', 2],
      ['무엇', 3], ['뭐가', 3], ['뭐예요', 3], ['뭔가요', 3], ['뭔지', 2],
      ['무슨', 2], ['언제', 3], ['몇 개', 3], ['몇개', 3], ['몇 시간', 3],
      ['얼마', 2], ['가능한가', 3], ['가능해', 2], ['가능한가요', 3],
      ['되나요', 3], ['되나', 2], ['되나요?', 3], ['인가요', 2], ['인지', 2],
      ['알려주', 3], ['설명해', 3], ['설명 좀', 3], ['차이', 3], ['비교', 2],
      ['추천해', 3], ['추천 좀', 3], ['궁금', 3], ['문의', 3], ['질문', 2],
      ['방법', 2], ['사용법', 3], ['후기', 2],
      ['나요', 2], ['까요', 2], ['을까', 2], ['는지', 2], ['그런가', 2], ['맞죠', 3],
      ['어때', 2], ['얼마나', 3], ['가능', 2],
      ['how do', 3], ['how to', 3], ['what is', 3], ['whats', 2], ["what's", 3],
      ['when', 2], ['where', 2], ['why', 2], ['which', 2], ['can you', 3],
      ['do you', 3], ['does it', 3], ['is it', 3], ['anyone', 2], ['any tips', 3],
      ['difference', 3], ['recommend', 3], ['tutorial', 2], ['help', 2],
    ],
    positive: [
      ['좋아요', 3], ['좋아', 2], ['좋네', 3], ['좋다', 3], ['좋음', 3],
      ['최고', 3], ['완벽', 3], ['대박', 3], ['감사', 3], ['고맙', 3], ['고마', 2],
      ['유익', 3], ['도움', 2], ['도움됐', 3], ['꿀팁', 3], ['퀄리티', 3],
      ['깔끔', 3], ['예쁘', 3], ['이쁘', 3], ['멋지', 3], ['신기', 3],
      ['재밌', 3], ['재미있', 3], ['웃기', 3], ['공감', 3], ['명강', 3],
      ['레전드', 3], ['찐', 2], ['인정', 2], ['사랑', 3], ['최애', 3],
      ['짱', 3], ['굿', 2], ['잘 봤', 3], ['잘봤', 3], ['잘 보고', 3], ['잘보고', 3],
      ['미쳤', 3], ['괜찮', 2], ['멀쩡', 3], ['낫네', 3], ['낫다', 3], ['좋았', 3],
      ['만족', 3], ['올려주세', 2], ['잘 쓰', 3], ['잘쓰', 3], ['저장', 2],
      ['기대', 3], ['대단', 3], ['희망', 2], ['공감', 3], ['웃겼', 2], ['쉬웠', 2],
      ['기다립', 2], ['뿌듯', 3],
      ['기다렸', 3], ['기다렸어', 3], ['또 봐', 2], ['계속 올려', 3], ['자주 올려', 3],
      ['love it', 3], ['love', 2], ['great', 3], ['awesome', 3], ['amazing', 3],
      ['thanks', 3], ['thank you', 3], ['helpful', 3], ['perfect', 3], ['nice', 2],
      ['cool', 2], ['fire', 2], ['goat', 3], ['subscribed', 3], ['best', 2],
      ['wow', 2], ['beautiful', 3],
    ],
    negative: [
      ['별로', 3], ['별루', 3], ['아쉽', 3], ['아쉬', 3], ['실망', 3], ['최악', 3],
      ['짜증', 3], ['불편', 3], ['안 좋', 3], ['좋지 않', 3], ['못 미', 2],
      ['부족', 3], ['아깝', 3], ['비싸', 3], ['비쌈', 3], ['가성비 별로', 4],
      ['과장', 3], ['낚시', 3], ['어그로', 3], ['광고', 3], ['협찬', 3],
      ['뻔하', 3], ['지루', 3], ['노잼', 3], ['구리', 3], ['구림', 3],
      ['쓰레기', 4], ['실패', 3], ['환불', 3], ['하자', 3], ['불량', 3],
      ['느리', 3], ['오류', 3], ['버그', 3], ['안 됨', 3], ['안됨', 3],
      ['안되', 2], ['못 쓰', 3], ['못쓰', 3], ['왜 이래', 3], ['이건 좀', 3],
      ['심해', 2], ['흠이', 2], ['스크래치', 2], ['눌림', 2],
      ['아쉬운', 3], ['개선', 2], ['보완', 2], ['다시 만들', 3], ['수정', 2],
      ['틀렸', 3], ['틀린', 3], ['틀리', 3], ['말이 안', 3], ['말도 안', 3], ['현실성 없', 4],
      ['불가능', 3], ['강의 홍보', 4], ['홍보 영상', 4], ['자극적', 2],
      ['후회', 3], ['느립', 3], ['장난 아니', 3], ['못 합', 3],
      ['못 꾸', 3], ['어렵', 2], ['문제', 2], ['위험', 1], ['무리', 2],
      ['벗겨', 2], ['알맹이 없', 3], ['의미 없', 3], ['올랐', 2],
      ['소음', 2], ['시끄', 3], ['냄새', 3], ['무거', 2], ['무겁', 3], ['느려', 3], ['느린', 3],
      ['disappoint', 4], ['bad', 3], ['worst', 4], ['boring', 3], ['waste', 4],
      ['clickbait', 4], ['too expensive', 4], ['not worth', 4], ['broken', 3],
      ['scam', 4], ['useless', 4], ['hate', 3], ['annoying', 3], ['refund', 3],
    ],
  };

  const EMOJI = [
    [/(❤️|♥️|💕|😍|🥰|👍|🔥|👏|💯|✨|🙏)/g, 'positive', 2],
    [/(😡|🤬|👎|😤|🙄|😑|💩)/g, 'negative', 2],
  ];

  const PRIORITY = { negative: 3, purchase: 2, question: 1, positive: 0, other: -1 };

  function classifyComment(text) {
    const raw = String(text === null || text === undefined ? '' : text);
    if (!raw.trim()) return 'other';
    const t = raw.toLowerCase().replace(/\s+/g, ' ');
    const scores = { purchase: 0, question: 0, positive: 0, negative: 0 };

    for (const type of Object.keys(RULES)) {
      for (const pair of RULES[type]) {
        const phrase = pair[0];
        const weight = pair[1];
        if (t.indexOf(phrase) !== -1) scores[type] += weight;
      }
    }

    // negated praise ("안 좋아요", "좋지 않네요", "별로 좋진 않아요")
    if (/안\s*(좋|예쁘|이쁘|멋지|괜찮)|좋지\s*(않|못)|좋진\s*않|별로\s*(좋|예쁘|멋지)/.test(t)) {
      scores.negative += 4;
      scores.positive = Math.max(0, scores.positive - 4);
    }

    for (const e of EMOJI) {
      const hits = (raw.match(e[0]) || []).length;
      if (hits) scores[e[1]] += Math.min(4, hits * e[2]);
    }

    // '?' pushes it toward a question only when nothing else is strong
    const qmarks = (raw.match(/[?？]/g) || []).length;
    if (qmarks) scores.question += Math.min(3, qmarks);

    let best = 'other';
    let bestScore = 0;
    for (const type of ['purchase', 'question', 'positive', 'negative']) {
      if (scores[type] > bestScore ||
          (scores[type] === bestScore && scores[type] > 0 && PRIORITY[type] > PRIORITY[best])) {
        best = type;
        bestScore = scores[type];
      }
    }
    if (bestScore < 2) return 'other';
    return best;
  }

  function classifyScores(text) {
    const raw = String(text === null || text === undefined ? '' : text);
    const t = raw.toLowerCase().replace(/\s+/g, ' ');
    const scores = { purchase: 0, question: 0, positive: 0, negative: 0 };
    const hits = { purchase: [], question: [], positive: [], negative: [] };
    for (const type of Object.keys(RULES)) {
      for (const pair of RULES[type]) {
        if (t.indexOf(pair[0]) !== -1) { scores[type] += pair[1]; hits[type].push(pair[0]); }
      }
    }
    return { scores, hits, type: classifyComment(text) };
  }

  function classifyAll(comments) {
    return comments.map(c => {
      const type = classifyComment(c.text);
      return Object.assign({}, c, { type });
    });
  }

  /* ── keyword extraction ─────────────────────────────────── */
  const PARTICLES = [
    '에서는', '에게서', '으로는', '이라고', '라는', '이라는', '에서', '에게', '한테',
    '으로', '로는', '부터', '까지', '보다', '처럼', '만큼', '이나', '거나', '인데',
    '지만', '는데', '다고', '라고', '하고', '하면', '해서', '했다', '한다', '합니다',
    '입니다', '습니다', '이에요', '예요', '인가요', '가나요', '할게요', '할래요',
    '이랑', '랑', '은', '는', '이', '가', '을', '를', '의', '에', '도', '만',
    '와', '과', '로', '야', '요', '죠', '임', '함', '들',
  ];
  const PARTICLES_SORTED = PARTICLES.slice().sort((a, b) => b.length - a.length);

  const STOPWORDS = new Set([
    '그리고', '그래서', '하지만', '그런데', '근데', '그냥', '진짜', '정말', '너무', '완전',
    '매우', '아주', '조금', '좀', '더', '제일', '가장', '이거', '그거', '저거', '이런',
    '그런', '저런', '이게', '그게', '저게', '여기', '거기', '저기', '이번',
    '다음', '지금', '오늘', '어제', '내일', '영상', '유튜브', '채널', '댓글', '구독',
    '알림', '좋아요', '감사', '고맙', '최고', '대박', '완벽', '사람', '생각', '경우',
    '좋아', '좋네', '좋다', '굿', '짱', '고마', '멋지', '깔끔', '유익',
    '때문', '부분', '정도', '느낌', '시간', '때', '거', '것', '수', '등', '및', '잘',
    '못', '안', '네', '예', '아', '어', '음', '와', '와우', '입니다', '합니다', '있습니다',
    '없습니다', '같아요', '같습니다', '했어요', '되는', '하는', '있는', '없는', '하게',
    '해서', '하면', '라고', '라고요', '이라는', '라는', '거예요', '거에요', '같아',
    '정도로', '부터', '이제', '아직', '다시', '한번', '한 번', '계속', '항상', '진심',
    '저도', '먼저', '결국', '방법', '하나', '되나', '있나', '없나', '인가',
    '보이', '싶어', '그런가', '알려주세', '부탁드립니다', '가능한가', '만원대면', '샀는데',
    '만원대', '어디', '어떻게', '우리', '바로', '저는', '제가', '시리즈', '좋네', '해주세',
    '혹시', '처음', '이면', '보고', '사도', '뭐예', '손잡', '다들', '거의', '아무', '어느', '각각',
    '있으면', '없으면', '해주면', '사요', '해요', '가요', '와요', '봐요', '그럼', '이렇게', '저렇게',
    '사고', '설명', '이해', '정말로', '완전히',
    'the', 'and', 'for', 'you', 'your', 'this', 'that', 'with', 'have', 'has', 'are',
    'was', 'were', 'but', 'not', 'all', 'can', 'just', 'from', 'they', 'them', 'what',
    'when', 'where', 'which', 'how', 'why', 'very', 'too', 'so', 'my', 'me', 'it', 'is',
    'in', 'on', 'of', 'to', 'a', 'an', 'do', 'does', 'did', 'be', 'been', 'will',
    'would', 'should', 'could', 'about', 'there', 'here', 'out', 'up', 'no', 'yes',
    'ok', 'okay', 'if', 'then', 'than', 'also', 'more', 'most', 'much', 'many', 'some',
    'any', 'one', 'two', 'get', 'got', 'like', 'really', 'good', 'great', 'nice',
    'thanks', 'thank', 'love', 'best', 'lol', 'wow', 'video', 'channel', 'comment',
    'subscribe', 'this', 'its',
  ]);

  // tokens still ending in a verb/adjective ending are grammar, not keywords
  const VERB_ENDINGS = [
    '습니다', '합니다', '됩니다', '입니다', '했습니다', '하세요', '해주세', '주세요',
    '었는데', '았는데', '는데', '지만', '니까', '면서', '려고', '더라', '나요', '까요',
    '어요', '아요', '네요', '구요', '고요', '세요', '해요', '하지', '하기', '하면',
    '해서', '해야', '겠습', '겠어', '한가', '할까', '될까', '일까', '같아', '보이',
    '싶어', '싶다', '하는', '되는', '있는', '없는', '했다', '한다', '된다', '않아',
    '않고', '같은', '라고', '다고', '드려', '드립', '만요', '쯤', '듯',
  ];

  // single-syllable endings that practically never close a Korean noun here
  const VERB_TAIL = ['야', '게', '나', '데', '니', '까', '며', '든', '려', '줘', '봐'];
  // nouns that end in one of those syllables and must survive
  const NOUN_KEEP = new Set(['무게', '가게', '이야기', '다이소']);

  function looksGrammatical(word) {
    if (word.length < 2) return false;
    if (NOUN_KEEP.has(word)) return false;
    if (word.length >= 3) {
      for (const e of VERB_ENDINGS) {
        if (word.length - e.length >= 1 && word.endsWith(e)) return true;
      }
    }
    for (const t of VERB_TAIL) {
      if (word.endsWith(t)) return true;
    }
    return false;
  }

  function stripParticle(word) {
    if (word.length < 3) return word;
    for (const p of PARTICLES_SORTED) {
      if (word.length - p.length >= 2 && word.endsWith(p)) {
        let stem = word.slice(0, word.length - p.length);
        if (stem.length >= 3 && stem.endsWith('들')) stem = stem.slice(0, -1);
        return stem;
      }
    }
    return word;
  }

  function tokenize(text) {
    const raw = String(text === null || text === undefined ? '' : text);
    const cleaned = raw
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/www\.\S+/g, ' ')
      .replace(/[@#][\wㄱ-ㅎㅏ-ㅣ가-힣._-]+/g, ' ')
      .replace(/[0-9]+/g, ' ')
      .replace(/[^\wㄱ-ㅎㅏ-ㅣ가-힣\s]/g, ' ');
    const out = [];
    for (const piece of cleaned.split(/\s+/)) {
      let w = piece.trim();
      if (!w) continue;
      w = stripParticle(w);
      if (w.length < 2) continue;
      if (/^[ㄱ-ㅎㅏ-ㅣ]+$/.test(w)) continue;
      if (STOPWORDS.has(w)) continue;
      if (looksGrammatical(w)) continue;
      if (/^[a-z]{1,2}$/.test(w) && !['ai', 'it', 'tv', 'pc', 'usb', 'ssd', 'led', 'bt'].includes(w)) continue;
      out.push(w);
    }
    return out;
  }

  function topKeywords(comments, limit) {
    const max = limit || 15;
    const map = new Map();
    for (const c of comments) {
      const seen = new Set(tokenize(c && c.text));
      for (const w of seen) {
        const row = map.get(w) || { word: w, count: 0, likes: 0, ids: [] };
        row.count += 1;
        row.likes += Number(c.likeCount) || 0;
        if (row.ids.length < 60) row.ids.push(c.id);
        map.set(w, row);
      }
    }
    const rows = Array.from(map.values());
    rows.sort((a, b) => (b.count - a.count) || (b.likes - a.likes) || a.word.localeCompare(b.word, 'ko'));
    // 한 번만 나온 단어는 칩을 어지럽힌다. 두 번 이상 나온 단어가 충분하면 그것만 쓴다.
    const multi = rows.filter(r => r.count >= 2);
    const pool = multi.length >= Math.min(max, 8) ? multi : rows;
    return pool.slice(0, max);
  }

  function keywordFilter(comments, word) {
    if (!word) return comments.slice();
    return comments.filter(c => tokenize(c.text).indexOf(word) !== -1);
  }

  /* ── stats ──────────────────────────────────────────────── */
  function ratio(part, total) {
    if (!total) return 0;
    return Math.round((part / total) * 1000) / 10;
  }

  function computeStats(comments) {
    const list = Array.isArray(comments) ? comments : [];
    const total = list.length;
    const counts = { purchase: 0, question: 0, positive: 0, negative: 0, other: 0 };
    let likes = 0;
    let replies = 0;
    let topLike = 0;
    for (const c of list) {
      const type = c.type && counts[c.type] !== undefined ? c.type : classifyComment(c.text);
      counts[type] += 1;
      const lk = Number(c.likeCount) || 0;
      likes += lk;
      if (lk > topLike) topLike = lk;
      replies += Number(c.replyCount) || 0;
    }
    return {
      total,
      avgLikes: total ? Math.round((likes / total) * 10) / 10 : 0,
      totalLikes: likes,
      totalReplies: replies,
      topLike,
      counts,
      purchaseRatio: ratio(counts.purchase, total),
      questionRatio: ratio(counts.question, total),
      positiveRatio: ratio(counts.positive, total),
      negativeRatio: ratio(counts.negative, total),
      otherRatio: ratio(counts.other, total),
    };
  }

  /* ── insight generation ─────────────────────────────────── */
  const GENERIC_FAQ_WORDS = new Set([
    '진짜', '제품', '영상', '댓글', '사람', '생각', '이거', '그거', '저거', '때문',
    '부분', '정도', '느낌', '경우', '시간', '좋아', '좋아요', '같아', '있어', '없어',
  ]);

  const HINT_RULES = [
    [/가격|얼마|비용|할인|쿠폰/, '가격·구성·할인 조건을 영상 설명란 1줄 + 고정 댓글에 명시'],
    [/링크|구매|판매|어디|스마트|쿠팡|주문|재입고|품절|입고/, '구매 링크·재입고 알림 위치를 고정 댓글 최상단에 안내'],
    [/배송|택배|도착/, '평균 배송 기간과 발송 요일을 고정 댓글에 적기'],
    [/세척|설거지|청소|닦|관리/, '세척·관리 방법(식기세척기 가능 여부)을 설명란에 정리'],
    [/소재|실리콘|내열|코팅|냄새|재질/, '소재·내열 온도·냄새 여부를 표로 정리'],
    [/내구|고장|수명|as|보증|불량|하자/, '보증 기간과 AS 접수 방법을 고정 댓글에 적기'],
    [/사이즈|크기|무게|용량|치수|호환/, '사이즈·무게 표를 설명란 링크로 붙이기'],
    [/차이|비교|추천|어떤|어느/, '비교표(대상·가격·차이) 한 장을 설명란에 링크'],
    [/배터리|충전|전원|성능|속도|램|ssd|저장공간/, '배터리·성능 실측 수치(시간·속도)를 표로 정리'],
    [/중고|신품|리퍼|정품/, '신품·중고 구분과 보증 여부를 설명란에 명시'],
    [/사용|방법|어떻게|설정|연결/, '사용법은 영상 타임스탬프(00:00)와 설명란에 함께 안내'],
    [/소음|소리|발열|전기|요금/, '소음·발열·전기요금 실측 수치를 다음 영상에서 제시'],
    [/초보|처음|입문|학생|사회초년|월급|적금|ETF|주식|저축/, '초보용 3단계 요약(오늘 할 일 1개)을 설명란에 정리'],
  ];

  function answerHintFor(keyword, question) {
    const w = (String(keyword || '') + ' ' + String(question || '')).toLowerCase();
    for (const pair of HINT_RULES) if (pair[0].test(w)) return pair[1];
    return '해당 질문에 대한 답을 영상 설명란·고정 댓글에 한 줄로 정리';
  }

  function shortDate(input) {
    const t = Date.parse(input);
    if (!t) return input ? String(input) : '(미입력)';
    const d = new Date(t);
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function cleanText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function shorten(text, max) {
    const t = cleanText(text);
    const limit = max || 90;
    if (t.length <= limit) return t;
    return t.slice(0, limit - 1).trim() + '…';
  }

  function buildFaq(comments, limit) {
    const max = limit || 3;
    const list = Array.isArray(comments) ? comments : [];
    const asks = list.filter(c => c.type === 'question' || c.type === 'purchase');
    const pool = asks.length >= 3 ? asks : list;
    const kws = topKeywords(pool, 24).filter(k => !GENERIC_FAQ_WORDS.has(k.word));
    const items = [];
    const used = new Set();
    const usedQ = new Set();
    for (const k of kws) {
      if (items.length >= max) break;
      if (used.has(k.word)) continue;
      const samples = pool.filter(c => tokenize(c.text).indexOf(k.word) !== -1)
        .sort((a, b) => (Number(b.likeCount) || 0) - (Number(a.likeCount) || 0));
      if (!samples.length) continue;
      const qKey = cleanText(samples[0].text).slice(0, 60);
      if (usedQ.has(qKey)) continue;
      used.add(k.word);
      usedQ.add(qKey);
      items.push({
        rank: items.length + 1,
        keyword: k.word,
        count: samples.length,
        likes: samples.reduce((s, c) => s + (Number(c.likeCount) || 0), 0),
        question: shorten(samples[0].text, 96),
        hint: answerHintFor(k.word, samples[0].text),
        samples: samples.slice(0, 3).map(c => ({
          id: c.id, author: c.author, text: c.text, likeCount: Number(c.likeCount) || 0,
        })),
      });
    }
    // always fill up to `max` when there is anything at all
    let idx = 0;
    const fallback = topKeywords(pool, 30);
    while (items.length < max && idx < fallback.length && pool.length) {
      const word = fallback[idx++].word;
      if (used.has(word) || GENERIC_FAQ_WORDS.has(word)) continue;
      const samples = pool.filter(c => tokenize(c.text).indexOf(word) !== -1);
      if (!samples.length) continue;
      const qKey = cleanText(samples[0].text).slice(0, 60);
      if (usedQ.has(qKey)) continue;
      used.add(word);
      usedQ.add(qKey);
      items.push({
        rank: items.length + 1, keyword: word, count: samples.length,
        likes: samples.reduce((s, c) => s + (Number(c.likeCount) || 0), 0),
        question: shorten(samples[0].text, 96),
        hint: answerHintFor(word, samples[0].text),
        samples: samples.slice(0, 3).map(c => ({
          id: c.id, author: c.author, text: c.text, likeCount: Number(c.likeCount) || 0,
        })),
      });
    }
    return items;
  }

  function buildPinnedComment(video, stats, faq) {
    const title = (video && video.title) ? video.title : '이 영상';
    const items = Array.isArray(faq) ? faq.slice(0, 3) : [];
    const lines = [];
    lines.push('📌 ' + shorten(title, 60) + ' — 자주 묻는 질문 정리');
    lines.push('');
    if (items.length) {
      items.forEach((f, i) => {
        lines.push('Q' + (i + 1) + '. ' + shorten(f.question, 80));
        lines.push('→ ' + f.hint);
        lines.push('');
      });
    }
    if (stats && stats.purchaseRatio > 0) {
      lines.push('🛒 구매 링크: (여기에 링크 붙여넣기)');
    }
    lines.push('⏱ 타임스탬프: 00:00 인트로 · 00:30 핵심 1 · 01:30 핵심 2 · 03:00 마무리');
    lines.push('💬 추가 질문은 댓글로 남겨주세요. 다음 영상에서 다룹니다.');
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  const IDEA_SKIP = new Set([
    '광고', '협찬', '홍보', '강의', '현실성', '자극적', '불가능', '후회', '어렵', '무리',
    '위험', '문제', '심해', '느립', '아깝', '아쉬', '별로', '실망', '과장', '낚시',
    '구리', '짜증', '불편', '부족', '비싸', '만원', '원', '때', '정도', '생각', '사람',
    '부분', '영상', '댓글', '구독', '좋아', '좋아요', '최고', '감사', '진짜',
  ]);

  function ideaKeywords(comments, limit) {
    return topKeywords(comments, Math.max(limit * 3, 18))
      .filter(k => !IDEA_SKIP.has(k.word) && k.word.length >= 2)
      .slice(0, limit);
  }

  function buildContentIdeas(comments, stats) {
    const list = Array.isArray(comments) ? comments : [];
    const ideas = [];
    const push = (title, why, evidence) => {
      if (!title || ideas.some(i => i.title === title)) return;
      ideas.push({ title, why, evidence });
    };

    const negKws = ideaKeywords(list.filter(c => c.type === 'negative'), 6);
    for (const k of negKws.slice(0, 2)) {
      push('「' + k.word + '」 불만 해소 영상 — 개선 전/후 비교',
        '불만 댓글 ' + k.count + '개가 같은 지점을 찍었습니다. 반박보다 실측으로 답하는 편이 댓글 창이 조용해집니다.',
        '불만 ' + k.count + '건');
    }

    const qKws = ideaKeywords(list.filter(c => c.type === 'question'), 6);
    for (const k of qKws.slice(0, 2)) {
      push('초보자를 위한 「' + k.word + '」 3분 정리',
        '질문 댓글 ' + k.count + '개가 반복해서 나온 주제입니다. 고정 댓글보다 영상 한 편이 조회수를 더 먹습니다.',
        '질문 ' + k.count + '건');
    }

    const buyKws = ideaKeywords(list.filter(c => c.type === 'purchase'), 4);
    if (buyKws.length) {
      const k = buyKws[0];
      push('구매 전 체크리스트 — 「' + k.word + '」 살까 말까',
        '구매의향 댓글 ' + k.count + '개. 망설이는 지점을 먼저 풀면 링크 클릭이 붙습니다.',
        '구매의향 ' + k.count + '건');
    }

    const all = ideaKeywords(list, 10);
    for (const k of all) {
      if (ideas.length >= 5) break;
      if (k.count < 3) continue;
      push('「' + k.word + '」 총정리 — 시청자가 100번 물어본 것',
        '댓글 ' + k.count + '개에서 언급된 키워드입니다. 검색 유입까지 같이 노립니다.',
        '언급 ' + k.count + '건');
    }

    const s = stats || computeStats(list);
    const fallbacks = [
      ['다음 영상 예고 — 이번 댓글 반응 정면으로 받기',
        '구매의향 ' + (s.purchaseRatio || 0) + '%, 질문 ' + (s.questionRatio || 0) +
        '% 구간을 보면 어떤 이야기가 당겨지는지 보입니다.', '댓글 ' + (s.total || 0) + '건'],
      ['고정 댓글 리뉴얼 — 같은 질문 3개를 한 번에',
        '상위 질문을 고정 댓글에 올리면 같은 질문이 반복되지 않습니다.', '질문 ' + (s.counts ? s.counts.question : 0) + '건'],
      ['30초 답변 템플릿 — 댓글 답장 속도 올리기',
        '답변 문장을 미리 만들어 두면 놓치는 질문이 줄어듭니다.', '질문 ' + (s.counts ? s.counts.question : 0) + '건'],
      ['구매 링크 동선 점검 — 설명란·고정 댓글·더보기',
        '구매의향 댓글이 있는데 링크 위치가 흩어져 있으면 클릭이 새어 나갑니다.', '구매의향 ' + (s.counts ? s.counts.purchase : 0) + '건'],
    ];
    for (const f of fallbacks) {
      if (ideas.length >= 5) break;
      push(f[0], f[1], f[2]);
    }
    return ideas.slice(0, 5);
  }

  function buildPrompt(video, comments, stats, faq, options) {
    const opts = options || {};
    const max = opts.maxComments || 50;
    const v = video || {};
    const s = stats || computeStats(comments);
    const f = faq || buildFaq(comments, 3);
    const ranked = comments.slice().sort((a, b) => (Number(b.likeCount) || 0) - (Number(a.likeCount) || 0)).slice(0, max);
    const kws = topKeywords(comments, 12);

    const lines = [];
    lines.push('[역할]');
    lines.push('너는 유튜브 채널의 시청자 반응 분석가다. 아래에 한 영상의 실제 댓글을 정리해 붙였다. 댓글에 있는 말만 근거로 써라.');
    lines.push('');
    lines.push('[영상]');
    lines.push('제목: ' + (v.title || '(미입력)'));
    lines.push('채널: ' + (v.channelTitle || '(미입력)'));
    lines.push('공개: ' + shortDate(v.publishedAt) + ' / 좋아요 ' + formatCount(v.likeCount) +
      ' / 댓글 ' + formatCount(v.commentCount));
    lines.push('');
    lines.push('[수집 요약]');
    lines.push('총 ' + s.total + '개 · 평균 좋아요 ' + s.avgLikes + ' · 구매의향 ' + s.purchaseRatio +
      '% · 질문 ' + s.questionRatio + '% · 긍정 ' + s.positiveRatio + '% · 불만 ' + s.negativeRatio + '%');
    lines.push('자주 나온 키워드: ' + kws.map(k => k.word + '(' + k.count + ')').join(', '));
    if (f.length) {
      lines.push('자동 FAQ 후보: ' + f.map(x => x.keyword + ' — ' + shorten(x.question, 40)).join(' / '));
    }
    lines.push('');
    lines.push('[댓글 ' + ranked.length + '개 · 좋아요순]');
    ranked.forEach((c, i) => {
      const label = (CATEGORIES[c.type] || CATEGORIES.other).short;
      lines.push((i + 1) + '. [' + label + ' · 좋아요 ' + (Number(c.likeCount) || 0) + '] ' + cleanText(c.text));
    });
    lines.push('');
    lines.push('[요청]');
    lines.push('1) 시청자 니즈를 3줄로 요약 (근거 댓글 번호 표시)');
    lines.push('2) 구매를 막는 요인 3가지와 각각의 답변 문장');
    lines.push('3) 다음 영상 소재 5개 — 제목 + 첫 3초 후킹 문장');
    lines.push('4) 고정 댓글 문구 (5줄 이내)');
    lines.push('5) 30초 안에 답할 수 있는 댓글 답변 템플릿 3개');
    lines.push('');
    lines.push('[규칙]');
    lines.push('- 댓글에 없는 내용은 지어내지 말고 "댓글에 없음"이라고 표시한다.');
    lines.push('- 숫자는 댓글에 나온 값만 쓴다.');
    lines.push('- 한국어로, 크리에이터가 바로 복사해 쓸 수 있게 쓴다.');
    return lines.join('\n');
  }

  /* ── 내 구독 AI 브리지 ──────────────────────────────────── */

  /** 브리지 3모드 — 화면과 프롬프트가 같은 정의를 쓴다. */
  const BRIDGE_MODES = [
    {
      id: 'script', label: '다음 영상 대본', short: '대본',
      desc: '후킹 3안 + 5단 대본 + 답할 질문 3개 + 마지막 CTA',
      request: [
        '[요청 — 다음 영상 대본]',
        '1) 첫 3초 후킹 3안 — 서로 다른 심리 트리거를 쓴 서로 다른 문장',
        '2) 5단 대본: 도입 / 문제 / 실측·근거 / 해결 / CTA — 각 단계마다 자막 1줄과 화면 지시',
        '3) 위 핵심 질문 중 3개를 대본 안에서 자연스럽게 답하기 (질문 번호 표시)',
        '4) 마지막 10초 CTA + 이 영상에 달 고정 댓글 문구 1개',
      ],
    },
    {
      id: 'rebuttal', label: '반박 카드', short: '반박',
      desc: '불만 Top에서 5장 — 오해 / 사실 / 근거 / 30자 반박 / 촬영 지시',
      request: [
        '[요청 — 반박 카드 5장]',
        '아래 불만 Top에서 5장을 골라 카드로 만든다. 각 카드 형식:',
        '- 오해: 시청자가 믿고 있는 것 한 줄',
        '- 사실: 실제로 확인된 것 한 줄',
        '- 근거: 실측값·조건·댓글 번호 (없으면 "[확인 필요]")',
        '- 반박: 30자 이내 한 문장 (비꼬지 않고 사실만)',
        '- 화면: 이 카드에 붙일 자막·샷 지시 1줄',
        '마지막에 "반박하지 말아야 할 불만 1개"와 그 이유를 적는다.',
      ],
    },
    {
      id: 'pinned', label: '고정 댓글', short: '고정 댓글',
      desc: 'A 정보형 / B 질문 유도형 / C 반박 예방형 — 각 6줄 이내',
      request: [
        '[요청 — 고정 댓글 3안]',
        'A안 정보형 / B안 질문 유도형 / C안 반박 예방형으로 3개를 쓴다.',
        '형식: "A안" 줄로 시작하고, 각 안은 6줄 이내 · 이모지 1개 · 링크·타임스탬프 자리는 ( )로 남긴다.',
        '각 안 아래에 "쓰인 트리거: ○○, ○○" 한 줄과 "넣으면 좋은 실측 수치: ○○" 한 줄을 덧붙인다.',
      ],
    },
  ];

  function bridgeModeInfo(mode) {
    for (const m of BRIDGE_MODES) if (m.id === mode) return m;
    return BRIDGE_MODES[0];
  }

  function dedupeKey(text) {
    return String(text || '').toLowerCase().replace(/[^0-9a-zㄱ-ㅎㅏ-ㅣ가-힣]/g, '').slice(0, 40);
  }

  function pickBridgeRows(comments, limit) {
    const rows = (Array.isArray(comments) ? comments : []).slice().sort((a, b) =>
      (Number(b.likeCount) || 0) - (Number(a.likeCount) || 0) ||
      (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0));
    const out = [];
    const seen = new Set();
    for (const c of rows) {
      const text = cleanText(c.text);
      const key = dedupeKey(text);
      if (!text || !key || seen.has(key)) continue;
      seen.add(key);
      out.push({ text, likes: Number(c.likeCount) || 0, replies: Number(c.replyCount) || 0 });
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * 100~300개 댓글에서 '묶어 보낼' 핵심만 추린다.
   * - 카테고리별 좋아요순 · 거의 같은 문장은 1개만 · 글자 예산 안에서 라운드로빈
   * - 작성자 이름은 담지 않는다(제3자 개인정보 최소화).
   */
  function buildBridgeBundle(comments, stats, faq, options) {
    const o = options || {};
    const perCategory = Math.max(3, Math.min(12, Number(o.perCategory) || 6));
    const maxChars = Math.max(900, Number(o.maxChars) || 2400);
    const list = Array.isArray(comments) ? comments : [];
    const s = stats || computeStats(list);
    const order = ['question', 'purchase', 'negative'];
    const pools = {
      question: pickBridgeRows(list.filter(c => c.type === 'question'), perCategory + 6),
      purchase: pickBridgeRows(list.filter(c => c.type === 'purchase'), perCategory + 6),
      negative: pickBridgeRows(list.filter(c => c.type === 'negative'), perCategory + 6),
    };

    const chosen = { question: [], purchase: [], negative: [] };
    let chars = 0;
    // 각 카테고리 최소 3개(있으면)를 먼저 넣어 균형을 지킨다.
    for (const key of order) {
      for (const row of pools[key].slice(0, Math.min(3, perCategory))) {
        chosen[key].push(row);
        chars += row.text.length;
      }
    }
    // 그다음 라운드로빈으로 채우다가 예산에서 멈춘다.
    let added = true;
    while (added) {
      added = false;
      for (const key of order) {
        if (chosen[key].length >= perCategory) continue;
        const row = pools[key][chosen[key].length];
        if (!row) continue;
        if (chars + row.text.length > maxChars) continue;
        chosen[key].push(row);
        chars += row.text.length;
        added = true;
      }
    }

    const kw = (o.keywords && o.keywords.length ? o.keywords : topKeywords(list, 10))
      .slice(0, 10).map(k => ({ word: k.word, count: k.count, likes: k.likes || 0 }));

    return {
      total: list.length,
      counts: {
        question: s.counts ? s.counts.question : 0,
        purchase: s.counts ? s.counts.purchase : 0,
        negative: s.counts ? s.counts.negative : 0,
        positive: s.counts ? s.counts.positive : 0,
        other: s.counts ? s.counts.other : 0,
      },
      ratios: {
        purchase: s.purchaseRatio || 0,
        question: s.questionRatio || 0,
        negative: s.negativeRatio || 0,
        positive: s.positiveRatio || 0,
      },
      avgLikes: s.avgLikes || 0,
      questions: chosen.question,
      purchases: chosen.purchase,
      negatives: chosen.negative,
      keywords: kw,
      faq: (Array.isArray(faq) ? faq : []).slice(0, 3).map(f => ({
        keyword: f.keyword, question: shorten(f.question, 70), hint: f.hint,
      })),
      sampled: chosen.question.length + chosen.purchase.length + chosen.negative.length,
      chars,
      perCategory,
      maxChars,
    };
  }

  function trimBundle(bundle, keep) {
    const out = Object.assign({}, bundle);
    ['questions', 'purchases', 'negatives'].forEach(k => { out[k] = bundle[k].slice(0, keep); });
    out.sampled = out.questions.length + out.purchases.length + out.negatives.length;
    out.chars = out.questions.concat(out.purchases, out.negatives).reduce((n, r) => n + r.text.length, 0);
    return out;
  }

  function bridgeLines(bundle, key, label) {
    const rows = bundle[key] || [];
    if (!rows.length) return [];
    const lines = ['[' + label + ' Top ' + rows.length + ']'];
    rows.forEach((r, i) => {
      lines.push((i + 1) + '. (좋아요 ' + r.likes + ') ' + shorten(r.text, 110));
    });
    lines.push('');
    return lines;
  }

  function composeBridgePrompt(video, bundle, mode, note) {
    const v = video || {};
    const m = bridgeModeInfo(mode);
    const b = bundle || buildBridgeBundle([], null, null, {});
    const lines = [];

    lines.push('[역할]');
    lines.push('너는 유튜브 채널의 카피라이터다. 아래는 한 영상의 실제 댓글 중 핵심만 추린 것이다. 댓글과 영상에 있는 말만 근거로 쓰고, 없는 사실은 만들지 않는다.');
    lines.push('');
    lines.push('[영상]');
    lines.push('제목: ' + (v.title || '(제목 없음)'));
    if (v.channelTitle) lines.push('채널: ' + v.channelTitle);
    if (v.publishedAt) lines.push('공개: ' + shortDate(v.publishedAt));
    if (v.likeCount || v.commentCount) {
      lines.push('영상 좋아요 ' + formatCount(v.likeCount) + ' / 댓글 ' + formatCount(v.commentCount));
    }
    lines.push('');
    lines.push('[반응 요약]');
    lines.push('분석한 댓글 ' + b.total + '개 → 구매의향 ' + b.ratios.purchase + '% · 질문 ' + b.ratios.question +
      '% · 불만 ' + b.ratios.negative + '% · 긍정 ' + b.ratios.positive + '%');
    if (b.keywords && b.keywords.length) {
      lines.push('자주 나온 키워드: ' + b.keywords.map(k => k.word + '(' + k.count + ')').join(', '));
    }
    lines.push('');
    if (b.faq && b.faq.length) {
      lines.push('[자동 추출 질문 뼈대]');
      b.faq.forEach(f => lines.push('- ' + f.keyword + ' — ' + shorten(f.question, 60)));
      lines.push('');
    }
    lines.push(...bridgeLines(b, 'questions', '핵심 질문'));
    lines.push(...bridgeLines(b, 'purchases', '구매의향·링크요청'));
    lines.push(...bridgeLines(b, 'negatives', '불만·아쉬움'));

    lines.push('[심리 트리거 — 의도적으로 쓸 것]');
    lines.push('손실회피 / 구체적 숫자·앵커 / 호기심 갭 / 패턴 인터럽트 / 사회적 증거 / 희소성·기한 / 권위·실측 / 저마찰 CTA');
    lines.push('숫자는 위 댓글 집계와 영상에 있는 값만 쓴다. 기한·수량·가격은 확인된 값이 없으면 쓰지 않는다.');
    lines.push('');
    lines.push(...m.request);
    lines.push('');
    lines.push('[규칙]');
    lines.push('- 댓글·영상에 없는 사실, 수치, 가격, 재고, 날짜를 만들지 않는다. 필요한 값은 [확인 필요]로 남긴다.');
    lines.push('- 시청자 닉네임·개인정보는 쓰지 않는다(애초에 넣지 않았다).');
    lines.push('- 한국어로, 크리에이터가 그대로 복사해 쓸 수 있게 짧게 쓴다.');
    lines.push('- 광고 문구가 아니라 "이 영상의 실제 반응에 대한 답"으로 쓴다.');
    if (note) { lines.push(''); lines.push('[참고]'); lines.push(note); }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /**
   * 내 구독 AI로 보낼 프롬프트. maxChars를 넘으면 댓글을 적게 넣어 줄인다.
   * @returns {{mode,prompt,chars,bundle,bundleNote}}
   */
  function buildBridgePrompt(video, bundle, mode, options) {
    const o = options || {};
    const maxChars = Math.max(1200, Number(o.maxChars) || 4200);
    const m = bridgeModeInfo(mode);
    let b = bundle || buildBridgeBundle([], null, null, {});
    let prompt = composeBridgePrompt(video, b, m.id, o.note);
    let keep = Math.max(b.questions.length, b.purchases.length, b.negatives.length);
    let guard = 0;
    while (prompt.length > maxChars && keep > 2 && guard < 30) {
      keep -= 1;
      b = trimBundle(b, keep);
      prompt = composeBridgePrompt(video, b, m.id, o.note);
      guard += 1;
    }
    return {
      mode: m.id,
      label: m.label,
      prompt,
      chars: prompt.length,
      bundle: b,
      trimmed: keep < Math.max(bundle ? bundle.questions.length : 0, bundle ? bundle.purchases.length : 0, bundle ? bundle.negatives.length : 0),
      maxChars,
    };
  }

  /**
   * AI 답변에서 고정 댓글 후보(A/B/C)를 나눈다. 못 나누면 통째로 1개.
   * @returns {Array<{label,title,text,chars}>}
   */
  function splitCandidates(text) {
    const src = String(text || '').replace(/\r\n?/g, '\n').trim();
    if (!src) return [];
    const blocks = [];
    let cur = null;
    for (const raw of src.split('\n')) {
      const probe = raw.replace(/\*\*/g, '').trim();
      const m = probe.match(/^#{0,4}\s*([A-C])\s*(?:안|\)|\.|:|：)\s*(.*)$/);
      if (m) {
        if (cur) blocks.push(cur);
        cur = { label: m[1] + '안', title: cleanText(m[2]), lines: [] };
      } else if (cur) {
        cur.lines.push(raw);
      }
    }
    if (cur) blocks.push(cur);
    if (blocks.length < 2) {
      return [{ label: '', title: '', text: src, chars: src.length }];
    }
    return blocks.map(b => {
      const body = b.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
      return { label: b.label, title: b.title, text: body, chars: body.length };
    }).filter(b => b.text);
  }

  /* ── paste parsers ──────────────────────────────────────── */
  function splitCSV(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    const src = String(text || '').replace(/^\uFEFF/, '');
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (quoted) {
        if (ch === '"') {
          if (src[i + 1] === '"') { cell += '"'; i++; }
          else quoted = false;
        } else cell += ch;
      } else if (ch === '"') {
        quoted = true;
      } else if (ch === ',') {
        row.push(cell); cell = '';
      } else if (ch === '\n') {
        row.push(cell); rows.push(row); row = []; cell = '';
      } else if (ch === '\r') {
        /* skip */
      } else cell += ch;
    }
    row.push(cell);
    rows.push(row);
    return rows.filter(r => r.some(c => String(c).trim() !== ''));
  }

  const HEADER_MAP = {
    text: ['text', 'comment', 'comment_text', '댓글', '내용', '댓글내용', 'message', 'body'],
    likes: ['likes', 'like', 'likecount', 'like_count', '좋아요', '좋아요수', '추천'],
    author: ['author', 'author_name', 'user', 'username', 'name', '작성자', '닉네임', '글쓴이'],
    replies: ['replies', 'reply', 'replycount', 'reply_count', '답글', '답글수'],
    date: ['date', 'publishedat', 'published_at', 'time', '작성일', '작성시각', '날짜'],
  };

  function headerIndex(cells) {
    const norm = cells.map(c => String(c).trim().toLowerCase().replace(/\s+/g, ''));
    const found = {};
    for (const key of Object.keys(HEADER_MAP)) {
      const idx = norm.findIndex(c => HEADER_MAP[key].indexOf(c) !== -1);
      if (idx !== -1) found[key] = idx;
    }
    return found;
  }

  function parsePasted(text, now) {
    const src = String(text || '').replace(/^\uFEFF/, '');
    const base = now === undefined ? Date.now() : now;
    const rows = splitCSV(src);
    let format = 'text';
    let cols = null;
    if (rows.length) {
      const h = headerIndex(rows[0]);
      if (h.text !== undefined) { format = 'csv'; cols = h; }
    }

    const comments = [];
    if (format === 'csv' && cols) {
      for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        const body = cleanText(row[cols.text]);
        if (!body) continue;
        const likes = cols.likes !== undefined ? parseInt(String(row[cols.likes] || '0').replace(/[^0-9]/g, ''), 10) || 0 : 0;
        const replies = cols.replies !== undefined ? parseInt(String(row[cols.replies] || '0').replace(/[^0-9]/g, ''), 10) || 0 : 0;
        comments.push({
          id: 'paste-' + (comments.length + 1),
          author: cols.author !== undefined ? cleanText(row[cols.author]) || '시청자' : '시청자',
          text: body,
          likeCount: likes,
          replyCount: replies,
          publishedAt: cols.date !== undefined && Date.parse(row[cols.date]) ? new Date(Date.parse(row[cols.date])).toISOString() : new Date(base).toISOString(),
          source: 'paste',
        });
      }
    } else {
      const lines = src.split(/\r?\n/);
      for (const raw of lines) {
        let line = raw.trim();
        if (!line) continue;
        if (line.length < 2) continue;
        let likes = 0;
        const m = line.match(/^(\d{1,6})\s*[|\t:]\s*(.+)$/);
        if (m && m[2].trim().length >= 2) {
          likes = parseInt(m[1], 10) || 0;
          line = m[2].trim();
        }
        comments.push({
          id: 'paste-' + (comments.length + 1),
          author: '시청자',
          text: cleanText(line),
          likeCount: likes,
          replyCount: 0,
          publishedAt: new Date(base).toISOString(),
          source: 'paste',
        });
      }
    }
    return { format, comments, count: comments.length, rows: rows.length };
  }

  /* ── export ─────────────────────────────────────────────── */
  function csvCell(v) {
    const s = v === null || v === undefined ? '' : String(v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  const CSV_HEADER = ['순번', '유형', '작성자', '댓글', '좋아요', '답글수', '작성시각', '댓글ID', '링크'];

  function toCSV(comments, video) {
    const vid = video && video.id ? video.id : '';
    const lines = [CSV_HEADER.map(csvCell).join(',')];
    comments.forEach((c, i) => {
      const type = (CATEGORIES[c.type] || CATEGORIES.other).label;
      const link = vid && c.source === 'live' && c.id
        ? 'https://www.youtube.com/watch?v=' + vid + '&lc=' + c.id : '';
      lines.push([
        i + 1, type, c.author || '', c.text || '', Number(c.likeCount) || 0,
        Number(c.replyCount) || 0, c.publishedAt || '', c.id || '', link,
      ].map(csvCell).join(','));
    });
    return lines.join('\r\n');
  }

  function toJSON(video, comments, stats, meta) {
    return JSON.stringify({
      app: 'youtube-comment-analyzer',
      schema: 1,
      exportedAt: new Date((meta && meta.now) || Date.now()).toISOString(),
      video: video || null,
      stats: stats || computeStats(comments),
      comments: comments.map(c => ({
        id: c.id, author: c.author, text: c.text, likeCount: Number(c.likeCount) || 0,
        replyCount: Number(c.replyCount) || 0, publishedAt: c.publishedAt,
        type: c.type || classifyComment(c.text),
      })),
    }, null, 2);
  }

  /* ── YouTube Data API v3 ────────────────────────────────── */
  const API_BASE = 'https://www.googleapis.com/youtube/v3/';

  function apiError(status, body) {
    const err = new Error('YouTube API ' + status);
    const e = body && body.error ? body.error : {};
    const detail = e.errors && e.errors[0] ? e.errors[0] : {};
    err.status = status;
    err.code = detail.reason || e.status || ('HTTP_' + status);
    err.detail = e.message || '';
    let hint = '';
    if (/quota/i.test(err.code) || /quota/i.test(err.detail)) {
      hint = '오늘 할당량(10,000 units)을 다 썼습니다. 태평양 시간 자정에 초기화됩니다.';
    } else if (/keyInvalid|keyExpired|API_KEY/i.test(err.code) || status === 400) {
      hint = 'API 키가 잘못됐거나 제한 설정에 막혔습니다. Google Cloud 콘솔에서 YouTube Data API v3 사용 설정과 키 제한을 확인하세요.';
    } else if (/commentsDisabled/i.test(err.code)) {
      hint = '이 영상은 댓글이 사용 중지되어 있습니다. 다른 영상을 넣어 보세요.';
    } else if (/videoNotFound|notFound/i.test(err.code) || status === 404) {
      hint = '영상을 찾지 못했습니다. 비공개·삭제된 영상이거나 ID가 틀렸습니다.';
    } else if (/forbidden|ipRefererBlocked/i.test(err.code) || status === 403) {
      hint = '이 키로는 호출이 막혔습니다. 키 제한(HTTP 리퍼러·IP)을 확인하세요.';
    } else {
      hint = '잠시 뒤 다시 시도해 주세요.';
    }
    err.hint = hint;
    return err;
  }

  function apiUrl(path, params, apiKey) {
    const qs = [];
    Object.keys(params || {}).forEach(k => {
      const v = params[k];
      if (v === undefined || v === null || v === '') return;
      qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    });
    qs.push('key=' + encodeURIComponent(apiKey || ''));
    return API_BASE + path + '?' + qs.join('&');
  }

  async function apiGet(path, params, apiKey, deps) {
    const f = (deps && deps.fetch) || (typeof fetch !== 'undefined' ? fetch : null);
    if (!f) throw new Error('fetch is not available');
    const res = await f(apiUrl(path, params, apiKey), { method: 'GET' });
    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    if (!res.ok) throw apiError(res.status, body);
    return body;
  }

  function parseVideoResponse(body) {
    const item = body && body.items && body.items[0];
    if (!item) {
      const err = new Error('video not found');
      err.status = 404;
      err.code = 'videoNotFound';
      err.hint = '영상을 찾지 못했습니다. ID를 다시 확인해 주세요.';
      throw err;
    }
    const sn = item.snippet || {};
    const st = item.statistics || {};
    const th = sn.thumbnails || {};
    return {
      id: item.id,
      title: sn.title || '',
      channelId: sn.channelId || '',
      channelTitle: sn.channelTitle || '',
      description: sn.description || '',
      publishedAt: sn.publishedAt || '',
      viewCount: Number(st.viewCount) || 0,
      likeCount: Number(st.likeCount) || 0,
      commentCount: Number(st.commentCount) || 0,
      thumbnail: (th.medium && th.medium.url) || (th.high && th.high.url) || (th.default && th.default.url) || '',
      source: 'live',
    };
  }

  function parseCommentResponse(body) {
    const items = (body && body.items) || [];
    const comments = items.map(it => {
      const sn = (it.snippet && it.snippet.topLevelComment && it.snippet.topLevelComment.snippet) || {};
      const id = (it.snippet && it.snippet.topLevelComment && it.snippet.topLevelComment.id) || it.id || '';
      const text = sn.textOriginal || sn.textDisplay || '';
      return {
        id,
        author: sn.authorDisplayName || '시청자',
        text: cleanText(text.replace(/<br\s*\/?>/gi, ' ')),
        likeCount: Number(sn.likeCount) || 0,
        replyCount: Number(it.snippet && it.snippet.totalReplyCount) || 0,
        publishedAt: sn.publishedAt || '',
        source: 'live',
      };
    }).filter(c => c.id && c.text);
    return {
      comments,
      nextPageToken: (body && body.nextPageToken) || '',
      totalResults: (body && body.pageInfo && body.pageInfo.totalResults) || 0,
    };
  }

  /**
   * Collect a video's info + top-level comments.
   * deps: { fetch, onPage(pageInfo) }
   */
  async function collectComments(opts, deps) {
    const o = opts || {};
    const videoId = parseVideoId(o.videoId);
    if (!videoId) {
      const err = new Error('invalid video id');
      err.code = 'invalidVideoId';
      err.hint = '유튜브 영상·쇼츠 링크나 11자리 영상 ID를 넣어 주세요.';
      throw err;
    }
    if (!o.apiKey) {
      const err = new Error('missing api key');
      err.code = 'missingApiKey';
      err.hint = 'YouTube Data API v3 키를 먼저 저장해 주세요.';
      throw err;
    }
    const max = Math.max(1, Math.min(300, Number(o.max) || 100));
    const order = o.order === 'time' ? 'time' : 'relevance';
    let units = 0;
    let pages = 0;

    const videoBody = await apiGet('videos', { part: 'snippet,statistics', id: videoId }, o.apiKey, deps);
    units += 1;
    const video = parseVideoResponse(videoBody);

    let token = '';
    const comments = [];
    do {
      const pageSize = Math.min(100, max - comments.length);
      const params = {
        part: 'snippet',
        videoId,
        maxResults: pageSize,
        order,
        textFormat: 'plainText',
      };
      if (token) params.pageToken = token;
      const body = await apiGet('commentThreads', params, o.apiKey, deps);
      units += 1;
      pages += 1;
      const parsed = parseCommentResponse(body);
      for (const c of parsed.comments) {
        if (comments.length >= max) break;
        comments.push(c);
      }
      token = parsed.nextPageToken;
      if (deps && typeof deps.onPage === 'function') {
        deps.onPage({ page: pages, got: comments.length, total: max, units });
      }
    } while (token && comments.length < max);

    return {
      video,
      comments: classifyAll(comments),
      units,
      pages,
      truncated: !!token && comments.length >= max,
    };
  }

  /* ── misc ───────────────────────────────────────────────── */
  function sortComments(comments, mode) {
    const list = comments.slice();
    if (mode === 'recent') {
      list.sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0));
    } else if (mode === 'replies') {
      list.sort((a, b) => (Number(b.replyCount) || 0) - (Number(a.replyCount) || 0) ||
        (Number(b.likeCount) || 0) - (Number(a.likeCount) || 0));
    } else {
      list.sort((a, b) => (Number(b.likeCount) || 0) - (Number(a.likeCount) || 0) ||
        (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0));
    }
    return list;
  }

  function searchComments(comments, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return comments.slice();
    const tokens = q.split(/\s+/);
    return comments.filter(c => {
      const hay = (String(c.text) + ' ' + String(c.author)).toLowerCase();
      return tokens.every(t => hay.indexOf(t) !== -1);
    });
  }

  function authorInitial(name) {
    const s = String(name || '?').replace(/^@/, '').trim();
    if (!s) return '?';
    return s.slice(0, 1).toUpperCase();
  }

  return {
    CATEGORIES, TYPE_ORDER,
    formatCount, formatPercent, formatRelative, trim1, relativeTime,
    parseVideoId, isShortsUrl,
    classifyComment, classifyScores, classifyAll, tokenize, topKeywords, keywordFilter,
    computeStats, ratio,
    buildFaq, buildPinnedComment, buildContentIdeas, buildPrompt,
    BRIDGE_MODES, bridgeModeInfo, buildBridgeBundle, buildBridgePrompt, splitCandidates,
    answerHintFor, shorten, cleanText, shortDate,
    splitCSV, parsePasted,
    toCSV, toJSON, csvCell, CSV_HEADER,
    apiUrl, apiError, apiGet, parseVideoResponse, parseCommentResponse, collectComments,
    sortComments, searchComments, authorInitial,
  };
});
