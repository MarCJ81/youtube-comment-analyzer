/* ============================================================
   ai-bridge.js  ·  내 구독 AI 원클릭 브리지  v2.0.0
   ------------------------------------------------------------
   의존성 없는 순수 JS(UMD). 브라우저에서는 window.AiBridge,
   node 에서는 require('./ai-bridge.js') 로 쓴다.

   이 모듈이 하는 일
   1) 프롬프트를 ChatGPT · Claude · Gemini 새 창으로 넘기는 링크 생성
      (주소로 자동 입력할 수 있는 곳은 자동 입력, 안 되는 곳은 클립보드)
   2) 선택형 무료 Gemini API 키로 브라우저에서 바로 요청/응답 처리
      — 키는 주소가 아니라 x-goog-api-key 헤더로만 나간다.
        (URL은 브라우저 기록·프록시 로그에 남기 쉬워서 헤더를 쓴다.)

   이 파일에는 키를 넣지 않는다. 키는 사용자가 화면에서 넣고
   브라우저 저장소(localStorage)에만 남는다.
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AiBridge = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '2.0.0';

  function str(v) {
    if (v === null || v === undefined) return '';
    return String(v);
  }

  function codePoints(s) {
    return Array.from ? Array.from(str(s)).length : str(s).length;
  }

  /* ── 1. AI 링크 ────────────────────────────────────────── */

  /**
   * prefilled: 주소의 q 파라미터로 입력창을 채울 수 있는가.
   * 이 방식은 각 서비스가 공식 문서로 보장하지 않는 기능이라,
   * 자동 입력이 비어 있으면 붙여넣기로 끝낼 수 있게 클립보드를 항상 함께 쓴다.
   */
  var PROVIDERS = [
    {
      id: 'chatgpt', label: 'ChatGPT', host: 'chatgpt.com',
      base: 'https://chatgpt.com/', param: 'q', prefilled: true, maxPrompt: 6000, maxUrl: 16000,
      note: '입력창에 프롬프트가 채워집니다. 비어 있으면 Ctrl+V로 붙여넣으세요.'
    },
    {
      id: 'claude', label: 'Claude', host: 'claude.ai',
      base: 'https://claude.ai/new', param: 'q', prefilled: true, maxPrompt: 10000, maxUrl: 14000,
      note: '입력창에 프롬프트가 채워집니다. 비어 있으면 Ctrl+V로 붙여넣으세요.'
    },
    {
      id: 'gemini', label: 'Gemini', host: 'gemini.google.com',
      base: 'https://gemini.google.com/app', param: '', prefilled: false, maxPrompt: 0, maxUrl: 0,
      note: 'Gemini는 주소 자동 입력이 안 됩니다. 프롬프트를 복사했으니 열린 창에 붙여넣으세요.'
    }
  ];

  var PROVIDER_INDEX = (function () {
    var m = {};
    PROVIDERS.forEach(function (p) { m[p.id] = p; });
    return m;
  })();

  function provider(id) {
    return PROVIDER_INDEX[str(id || '').toLowerCase()] || null;
  }

  function listProviders() {
    return PROVIDERS.map(function (p) {
      return { id: p.id, label: p.label, host: p.host, prefilled: p.prefilled, note: p.note };
    });
  }

  /**
   * 프롬프트를 넘길 링크.
   * @returns {{id,label,url,prefilled,fit,length,note}}
   */
  function linkFor(id, prompt) {
    var p = provider(id);
    if (!p) {
      return { id: str(id || ''), label: '', url: '', prefilled: false, fit: false, length: 0, note: '알 수 없는 AI예요.' };
    }
    var text = str(prompt);
    var len = codePoints(text);

    if (!p.prefilled) {
      return { id: p.id, label: p.label, url: p.base, prefilled: false, fit: false, length: len, note: p.note };
    }
    if (!text.trim()) {
      return { id: p.id, label: p.label, url: p.base, prefilled: false, fit: false, length: 0, note: '보낼 프롬프트가 비어 있어요.' };
    }
    if (len > p.maxPrompt) {
      return {
        id: p.id, label: p.label, url: p.base, prefilled: false, fit: false, length: len,
        note: '프롬프트가 ' + len.toLocaleString('ko-KR') + '자로 길어 주소에 담지 못했어요. 클립보드에 복사했으니 열린 창에 붙여넣으세요.'
      };
    }
    var encoded = encodeURIComponent(text).length;
    if (p.maxUrl && encoded > p.maxUrl) {
      return {
        id: p.id, label: p.label, url: p.base, prefilled: false, fit: false, length: len,
        note: '프롬프트가 길어(주소 ' + encoded.toLocaleString('ko-KR') + '자) 자동 입력 대신 붙여넣기로 안내해요.'
      };
    }
    var sep = p.base.indexOf('?') >= 0 ? '&' : '?';
    return {
      id: p.id, label: p.label,
      url: p.base + sep + p.param + '=' + encodeURIComponent(text),
      prefilled: true, fit: true, length: len, note: p.note
    };
  }

  function linksFor(prompt) {
    return PROVIDERS.map(function (p) { return linkFor(p.id, prompt); });
  }

  /* ── 2. Gemini API (선택) ──────────────────────────────── */

  var GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
  /* 2026-11 무료 티어 기준. 무료 등급이 없는 모델(4번대)은 넣지 않는다. */
  var GEMINI_DEFAULT_MODEL = 'gemini-3.5-flash-lite';
  var GEMINI_MODELS = [
    'gemini-3.5-flash-lite',
    'gemini-3.8-flash',
    'gemini-3.6-flash',
    'gemini-3.1-flash-lite'
  ];

  function geminiModel(model) {
    var m = str(model).trim();
    return m || GEMINI_DEFAULT_MODEL;
  }

  /**
   * 브라우저에서 바로 부를 요청. 키는 x-goog-api-key 헤더로만 나간다.
   * @returns {{url,model,init}}
   */
  function buildGeminiRequest(opts) {
    var o = opts || {};
    var key = str(o.apiKey).trim();
    if (!key) throw new Error('Gemini API 키가 비어 있어요.');
    var prompt = str(o.prompt);
    if (!prompt.trim()) throw new Error('보낼 프롬프트가 비어 있어요.');
    var model = geminiModel(o.model);
    var url = GEMINI_BASE + encodeURIComponent(model) + ':generateContent';
    var body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: typeof o.temperature === 'number' ? o.temperature : 0.8,
        maxOutputTokens: typeof o.maxOutputTokens === 'number' ? o.maxOutputTokens : 4096
      }
    };
    return {
      url: url,
      model: model,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': key
        },
        body: JSON.stringify(body)
      }
    };
  }

  function textFromParts(parts) {
    if (!Array.isArray(parts)) return '';
    return parts.map(function (p) {
      if (!p || typeof p !== 'object') return '';
      if (p.thought === true) return '';
      return str(p.text);
    }).filter(Boolean).join('');
  }

  /**
   * Gemini 응답 → 텍스트.
   * generateContent(candidates)와 output_text 모양을 모두 받는다.
   * @returns {{ok,text,error,code,finishReason,warnings,usage}}
   */
  function parseGeminiResponse(json) {
    var warnings = [];
    if (!json || typeof json !== 'object') {
      return { ok: false, text: '', error: '응답을 읽지 못했어요.', code: 'bad-json', warnings: warnings };
    }
    if (json.error) {
      return {
        ok: false, text: '', code: json.error.code || 'error',
        error: str(json.error.message) || 'Gemini가 오류를 돌려줬어요.',
        warnings: warnings
      };
    }

    var usage = json.usageMetadata ? {
      prompt: json.usageMetadata.promptTokenCount || 0,
      output: json.usageMetadata.candidatesTokenCount || 0,
      total: json.usageMetadata.totalTokenCount || 0
    } : null;

    var text = '';
    var finish = null;

    if (Array.isArray(json.candidates) && json.candidates.length) {
      var cand = json.candidates[0] || {};
      text = textFromParts(cand.content && cand.content.parts);
      finish = cand.finishReason || null;
      if (finish && finish !== 'STOP') {
        warnings.push('응답이 ' + finish + '로 끝났어요. 결과가 잘렸으면 이어서 요청하거나 모델을 바꿔 보세요.');
      }
    } else if (typeof json.output_text === 'string') {
      text = json.output_text;
    } else if (Array.isArray(json.outputs)) {
      text = json.outputs.map(function (o) {
        if (typeof o === 'string') return o;
        if (o && typeof o.text === 'string') return o.text;
        if (o && o.content && Array.isArray(o.content.parts)) return textFromParts(o.content.parts);
        return '';
      }).filter(Boolean).join('\n');
    } else if (json.promptFeedback && json.promptFeedback.blockReason) {
      return {
        ok: false, text: '', code: 'blocked',
        error: '안전 필터에 걸려 답변이 오지 않았어요(' + json.promptFeedback.blockReason + '). 표현을 바꿔 다시 시도하세요.',
        warnings: warnings
      };
    }

    text = str(text).trim();
    if (!text) {
      return {
        ok: false, text: '', code: 'empty',
        error: '응답은 왔지만 내용이 비어 있어요. 모델명을 확인하거나 다시 시도하세요.',
        warnings: warnings
      };
    }
    return { ok: true, text: text, error: null, code: 200, finishReason: finish, warnings: warnings, usage: usage };
  }

  /** HTTP 상태 → 사람이 읽는 안내 */
  function explainStatus(status, bodyText) {
    var detail = str(bodyText).slice(0, 180);
    if (/API key not valid|API_KEY_INVALID|API key expired/i.test(detail)) {
      return 'API 키가 거부됐어요. Google AI Studio에서 만든 키를 다시 복사해 넣어 주세요. ' + detail;
    }
    if (status === 400) return '요청이 거부됐어요. 모델명을 확인하세요. ' + detail;
    if (status === 401 || status === 403) return '키 권한이 막혔어요. 키 제한(API·리퍼러)과 Generative Language API 사용 설정을 확인하세요. ' + detail;
    if (status === 404) return '모델을 찾지 못했어요. 모델명을 다른 것으로 바꿔 보세요. ' + detail;
    if (status === 429) return '무료 한도를 넘었어요. 1분 뒤 다시 시도하거나 모델을 바꿔 보세요. ' + detail;
    if (status >= 500) return 'Gemini 서버가 잠시 응답하지 못했어요. 잠시 뒤 다시 시도하세요. ' + detail;
    return 'Gemini 요청이 실패했어요(HTTP ' + status + '). ' + detail;
  }

  /** 화면에 보여줄 키 마스킹 */
  function maskKey(key) {
    var k = str(key);
    if (!k) return '';
    return '•••• •••• ' + k.slice(-4);
  }

  return {
    VERSION: VERSION,
    PROVIDERS: listProviders(),
    GEMINI_DEFAULT_MODEL: GEMINI_DEFAULT_MODEL,
    GEMINI_MODELS: GEMINI_MODELS.slice(),
    provider: provider,
    listProviders: listProviders,
    linkFor: linkFor,
    linksFor: linksFor,
    geminiModel: geminiModel,
    buildGeminiRequest: buildGeminiRequest,
    parseGeminiResponse: parseGeminiResponse,
    explainStatus: explainStatus,
    maskKey: maskKey
  };
});
