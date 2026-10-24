/**
 * /api/rewrite 客户端（契约 v1.2 冻结版；docs/api-contract.md 为唯一权威）
 *
 * 设计决策：
 * - 字符计数与后端一致用 String.length（UTF-16 码元），避免前后端口径差导致 300/2000 边界误判；
 * - 不做前端自动重试：服务端已有「首调 15s + 非法结构重试一次 10s」预算（契约 §5），
 *   前端再重试等于第三次调用且可能击穿 30 秒感知，统一走「友好错误 + 重试按钮」；
 * - 成功响应做结构校验（纵深防御）：服务端七道校验之外的前端兜底，失败按 INVALID_OUTPUT 呈现。
 */

const API_URL = '/api/rewrite';

export const DEFAULT_TIMEOUT_MS = 30000;

/** 输入上限（契约 §2；与后端 shared/prompt.js 常量一致） */
export const LIMITS = Object.freeze({ experience: 300, jd: 2000 });

/** 与后端一致的字符计数口径 */
export const countChars = (text) => text.length;

/** 前端自有错误码（无对应服务端 code） */
const CLIENT_CODES = new Set(['ABORTED', 'NETWORK']);

/** 各错误码的本地兜底文案（服务端 message 优先原样展示，契约 §4） */
const FALLBACK_MESSAGES = Object.freeze({
  INVALID_INPUT: '输入不合法，请检查后重试',
  RATE_LIMITED: '请求过于频繁，请稍后再试',
  UPSTREAM_TIMEOUT: '模型响应超时，请重试',
  UPSTREAM_ERROR: '模型服务暂时不可用，请稍后重试',
  INVALID_OUTPUT: '改写结果异常，请重试',
  INTERNAL_ERROR: '服务开小差了，请稍后重试',
  ABORTED: '等待超过 30 秒，已停止本次请求，请重试',
  NETWORK: '网络异常，请检查连接后重试',
});

/** HTTP 状态 → 错误码兜底映射（响应体缺 code 时使用；契约 §4） */
const HTTP_STATUS_CODES = Object.freeze({
  400: 'INVALID_INPUT',
  429: 'RATE_LIMITED',
  502: 'UPSTREAM_ERROR',
  504: 'UPSTREAM_TIMEOUT',
});

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * 成功响应结构校验（契约 §3）。
 * @returns {{ ok: true, data: object } | { ok: false }}
 */
function validateSuccess(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false };
  const { mock_mode: mockMode, rewritten, diff, keywords, questions } = payload;
  if (mockMode !== undefined && typeof mockMode !== 'boolean') return { ok: false };
  if (!isNonEmptyString(rewritten) || rewritten.length > 300) return { ok: false };
  if (!Array.isArray(diff)) return { ok: false };
  for (const item of diff) {
    if (!item || typeof item !== 'object') return { ok: false };
    if (!isNonEmptyString(item.original_segment)) return { ok: false };
    if (!isNonEmptyString(item.revised_segment)) return { ok: false };
    if (!isNonEmptyString(item.rationale)) return { ok: false };
  }
  if (!Array.isArray(keywords)) return { ok: false };
  for (const item of keywords) {
    if (!item || typeof item !== 'object') return { ok: false };
    if (!isNonEmptyString(item.keyword)) return { ok: false };
    if (item.status !== 'hit' && item.status !== 'missing') return { ok: false };
    if (typeof item.source_hint !== 'string') return { ok: false };
  }
  if (!Array.isArray(questions)) return { ok: false };
  for (const item of questions) {
    if (!item || typeof item !== 'object') return { ok: false };
    if (!isNonEmptyString(item.question)) return { ok: false };
    if (item.blocking !== false) return { ok: false };
    if (typeof item.reason !== 'string') return { ok: false };
  }
  return {
    ok: true,
    data: {
      mock_mode: mockMode === true,
      rewritten,
      diff,
      keywords,
      questions,
    },
  };
}

/**
 * 调用单条经历改写接口。
 * @param {{ experience: string, jd: string, followups?: Array<{question: string, answer: string}> }} input
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{ ok: true, data: object } | { ok: false, error: { code: string, message: string, retryAfter?: number, detail?: object } }>}
 */
export async function rewrite(input, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = options;
  const { experience, jd, followups } = input;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        experience,
        jd,
        ...(Array.isArray(followups) && followups.length > 0 ? { followups } : {}),
      }),
      signal: controller.signal,
    });

    let payload = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }

    if (!res.ok) {
      const err = payload && typeof payload.error === 'object' ? payload.error : {};
      const code =
        typeof err.code === 'string' && (err.code in FALLBACK_MESSAGES || CLIENT_CODES.has(err.code))
          ? err.code
          : HTTP_STATUS_CODES[res.status] ?? 'INTERNAL_ERROR';
      const retryAfterHeader = res.headers?.get?.('Retry-After');
      const retryAfter = Number.parseInt(retryAfterHeader ?? '', 10);
      return {
        ok: false,
        error: {
          code,
          message: isNonEmptyString(err.message) ? err.message : FALLBACK_MESSAGES[code],
          ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfter } : {}),
          ...(err.detail && typeof err.detail === 'object' ? { detail: err.detail } : {}),
        },
      };
    }

    const shape = validateSuccess(payload);
    if (!shape.ok) {
      return {
        ok: false,
        error: { code: 'INVALID_OUTPUT', message: FALLBACK_MESSAGES.INVALID_OUTPUT },
      };
    }
    return { ok: true, data: shape.data };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return { ok: false, error: { code: 'ABORTED', message: FALLBACK_MESSAGES.ABORTED } };
    }
    return { ok: false, error: { code: 'NETWORK', message: FALLBACK_MESSAGES.NETWORK } };
  } finally {
    clearTimeout(timer);
  }
}
