# engines/ — 댓글 레이더에 장착된 엔진 3종

의존성 없는 순수 JS(UMD). 브라우저에서는 `window.*`, node에서는 `require()`로 씁니다.
빌드·번들러·npm 설치가 필요 없고, `index.html`이 아래 순서로 그대로 불러옵니다.

```html
<script src="engines/copy-psych-engine.js"></script>
<script src="engines/radar-copy.js"></script>
<script src="engines/ai-bridge.js"></script>
```

| 파일 | 전역 | 역할 |
| --- | --- | --- |
| `copy-psych-engine.js` | `CopyPsych` | 8대 트리거 진단·점수화, PAS/BAB/AIDA/4U 생성, 감점 표현 탐지·교정 (공용 엔진, `packages/`와 같은 파일) |
| `radar-copy.js` | `RadarCopy` | 댓글 브리핑 → 카피 입력 변환, 고정 댓글·소재 채점, 프레임워크 초안·고정 댓글 변환 |
| `ai-bridge.js` | `AiBridge` | ChatGPT·Claude·Gemini 링크, 무료 Gemini API 요청/응답 처리 |

---

## 1. copy-psych-engine.js

공용 카피 심리학 엔진입니다. API는 `packages/README.md`와 같습니다.

```js
const C = require('./copy-psych-engine.js');
C.diagnose(text);   // { total, grade, triggers[8], gaps, strengths, stats }
C.detect(text);     // { friction, issues, groups }
C.correct(text);    // { text, applied, after, improved }
C.build('PAS', input);          // { title, sections, body, psych }
C.generateAll(input);           // { items[4], best, comparison, recommendation }
```

이 앱은 엔진을 고치지 않고 그대로 씁니다. 점수 판정 기준·가중치도 엔진 것을 따릅니다.

## 2. radar-copy.js

```js
const R = require('./radar-copy.js');

R.scorePinned(pinnedText);
// { score: {total, grade, triggers, gaps, friction, stats, flags},
//   correction: {text, applied, improved, warnings}, lines, note }

R.scoreIdea({ title, why });      // 제목+이유 채점, tooShort면 note
R.correctText(text);              // 자동 치환이 문장을 반복시키면 warnings
R.inputFromBrief(brief);          // 댓글 집계 → {product,target,problem,solution,proof,cta,…}
R.frameworks(brief);              // 4종 + 각 프레임워크의 고정 댓글 초안/점수
R.toPinnedDraft(item);            // 긴 문단을 6~8줄 고정 댓글로 압축
R.hookVariants(brief);            // 프레임워크 제목에서 중복 없는 후킹 대안
```

원칙:

- **없는 사실을 만들지 않는다.** `problem`은 실제 불만 댓글, `proof`는 댓글 집계값만 씁니다.
  가격·기한·재고는 비워 둡니다(엔진이 기본값으로 채우지 않게 빈 문자열 유지).
- 한국어 조사는 엔진의 `josa()`로 받침을 보고 붙입니다(`「배터리」가`, `「발열」이`).
- 자동 교정은 참고용입니다. 문장이 반복되거나 크게 짧아지면 `warnings`로 알립니다.
- 점수는 광고 카피 기준이라 안내문(고정 댓글)은 낮게 나옵니다. 그래서 `summarize()`는
  점수·등급과 함께 **강한 축 3개 + 빈틈 2개**를 같이 돌려줍니다.

## 3. ai-bridge.js

```js
const B = require('./ai-bridge.js');

B.listProviders();               // [{id:'chatgpt',…},{id:'claude',…},{id:'gemini',…}]
B.linkFor('chatgpt', prompt);    // {url, prefilled, fit, length, note}
B.buildGeminiRequest({ apiKey, prompt, model });
// { url: '…/models/gemini-3.5-flash-lite:generateContent',
//   init: { headers: {'x-goog-api-key': key, ...}, body } }
B.parseGeminiResponse(json);      // { ok, text, warnings, usage } | { ok:false, error }
B.explainStatus(429, detail);     // 사람이 읽는 안내
```

- ChatGPT `https://chatgpt.com/?q=`, Claude `https://claude.ai/new?q=` 로 입력창을 채웁니다.
  이 파라미터는 각사가 공식 보장하지 않아, 길이가 넘거나 비어 있으면 `prefilled:false`로 돌려주고
  클립보드 복사를 함께 씁니다.
- Gemini는 주소 자동 입력이 되지 않아 `https://gemini.google.com/app`만 엽니다.
- **키는 URL에 넣지 않습니다.** `x-goog-api-key` 헤더로만 나가고, 400/401/403/404/429/5xx를
  각각 다른 안내 문구로 바꿉니다.
- 기본 모델은 무료 등급이 있는 `gemini-3.5-flash-lite`이고, 목록은 2026-11 무료 티어 기준입니다.
  모델명은 화면에서 직접 바꿀 수 있습니다.

---

## 테스트

```bash
/workspace/scratch/node/node-v20.18.0-linux-x64/bin/node test.js   # 407 assertions
```

`test.js`가 `core.js`의 브리지 묶음·프롬프트와 함께 위 세 모듈을 직접 검증합니다.
