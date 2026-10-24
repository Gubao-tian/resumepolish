/**
 * Serverless handler（tech-design T6/T8；Vercel 约定入口）。
 *
 * 编排链（ADR-4 薄 handler）：限流 → 输入校验 → Prompt 构建 →
 * LLM 调用（首调 15s；结构非法重试一次 10s + 修复指令）→ 输出七道校验 → 响应。
 *
 * 隐私红线：不落盘、不记正文日志；仅输出脱敏指标（耗时/状态码/错误码）。
 * Mock 为一等公民（ADR-3）：MOCK=1 或缺 LLM_API_KEY 时走确定性 Mock，
 * 限流/校验/降级全链路保持真实。
 */

import { buildMessages } from '../shared/prompt.js';
import { validateInput, validateOutput } from '../shared/validate.js';
import { createRateLimiter } from '../shared/ratelimit.js';

const FIRST_TIMEOUT_MS = 15000;
const RETRY_TIMEOUT_MS = 10000;
const REPAIR_INSTRUCTION = '上次输出不符合约定 Schema 或未通过校验，请严格按系统提示的字段重新输出，仅输出 JSON 对象本身。';

/** 模块级默认限流器（30 次/小时/IP）；测试可注入独立实例 */
const defaultLimiter = createRateLimiter();

/** Mock 判定在调用时求值（便于测试通过环境变量切换） */
function isMockMode() {
  return process.env.MOCK === '1' || !process.env.LLM_API_KEY;
}

/** @param {any} req */
function clientIp(req) {
  const xff = req?.headers?.['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0].trim();
  return req?.socket?.remoteAddress || 'anonymous';
}

/**
 * Mock 确定性响应（ADR-3）：模板 + 原文片段派生。
 * 同输入同输出；数字/拉丁 token 全部来自原文，保证可通过七道校验。
 * @param {{ experience: string }} ctx
 */
function mockChatCompletion({ experience }) {
  const text = experience.trim();
  const cut = text.search(/[，。、；,.;]/);
  const slice = (cut > 0 && cut <= 12 ? text.slice(0, cut) : text.slice(0, 12)) || '这段经历';
  const core = slice.replace(/^(?:负责|参与)\s*/, '');
  return {
    mock_mode: true,
    rewritten: `主导${core}，搭建选题模板，形成可复用的内容生产流程`,
    diff: [
      {
        original_segment: slice,
        revised_segment: `主导${core}，搭建选题模板`,
        rationale: '「负责」类表述改为「主导」突出 ownership，并补充可复用的方法',
      },
    ],
    keywords: [
      { keyword: '内容生产', status: 'hit', source_hint: '可从原文运营职责对应' },
      { keyword: '数据分析', status: 'missing', source_hint: '可从数据类经历挖掘后自行补充' },
    ],
    questions: [{ question: '这段经历带来的可量化结果是多少？', blocking: false, reason: '缺少数字成果，影响面试说服力' }],
  };
}

/**
 * LLM 调用（OpenAI 兼容协议，ADR-2）。
 * 默认模型 deepseek-v4-flash（T1 桌面推演主选；旧别名 deepseek-chat 已于 2026-07-24 退役）。
 * 返回 { content, usage }；usage 仅用于脱敏指标日志（token 用量），Mock 模式为 null。
 * 错误约定：AbortError → code=UPSTREAM_TIMEOUT；非 2xx/网络异常 → code=UPSTREAM_ERROR。
 * @param {Array<{role:string,content:string}>} messages
 * @param {number} timeoutMs
 * @param {{ experience: string }} ctx
 */
async function callLLM(messages, timeoutMs, ctx) {
  if (isMockMode()) return { content: JSON.stringify(mockChatCompletion(ctx)), usage: null };
  const base = process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: process.env.LLM_MODEL || 'deepseek-v4-flash',
        messages,
        temperature: 0.3,
        response_format: { type: 'json_object' }, // 提升 JSON 首 Try 合法率（选型标准 #2；DeepSeek/GLM 均支持）
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const err = new Error(`upstream status ${resp.status}`);
      err.upstreamStatus = resp.status;
      throw err;
    }
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      const err = new Error('upstream payload missing content');
      err.upstreamStatus = 502;
      throw err;
    }
    return { content, usage: data?.usage ?? null };
  } catch (e) {
    if (e?.name === 'AbortError') {
      const err = new Error('upstream timeout');
      err.code = 'UPSTREAM_TIMEOUT';
      throw err;
    }
    const err = new Error(e?.message || 'upstream unreachable');
    err.code = 'UPSTREAM_ERROR';
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** @param {number} status @param {any} body @param {Record<string,string>} [extraHeaders] */
function jsonResponse(status, body, extraHeaders = {}) {
  return {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Storage': 'none',
      ...extraHeaders,
    },
    body,
  };
}

/** @param {number} status @param {string} code @param {string} message @param {any} [detail] @param {Record<string,string>} [extraHeaders] */
function errorResponse(status, code, message, detail, extraHeaders) {
  const error = { code, message };
  if (detail) error.detail = detail;
  return jsonResponse(status, { error }, extraHeaders);
}

/**
 * 核心请求处理（纯编排，无 IO 副作用；Vercel handler 与 dev-server 共用）。
 * @param {{ method?: string, body?: any, ip?: string, limiter?: any, callLLM?: Function, now?: () => number }} opts
 * @returns {Promise<{ status: number, headers: Record<string,string>, body: any }>}
 */
export async function handleRewriteRequest({
  method = 'POST',
  body,
  ip = 'anonymous',
  limiter = defaultLimiter,
  callLLM: llmCall = callLLM,
  now = () => Date.now(),
} = {}) {
  const started = now();
  /** @type {{ prompt_tokens?: number, completion_tokens?: number } | null} 最近一次调用的 token 用量（脱敏指标） */
  let lastUsage = null;
  const finish = (result) => {
    // 脱敏指标：仅耗时/状态码/错误码/token 用量；严禁打印用户输入（tech-design §13）
    console.log(JSON.stringify({
      event: 'rewrite_returned',
      duration_ms: now() - started,
      status: result.status,
      code: result.body?.error?.code ?? 'OK',
      mock: result.body?.mock_mode === true,
      ...(lastUsage ? { usage: lastUsage } : {}),
    }));
    return result;
  };

  if (method !== 'POST') {
    return finish(errorResponse(405, 'METHOD_NOT_ALLOWED', '只支持 POST 请求'));
  }
  const rl = limiter.check(ip);
  if (!rl.allowed) {
    return finish(errorResponse(429, 'RATE_LIMITED', `请求过于频繁，请 ${rl.retryAfterSec} 秒后再试`, undefined, { 'Retry-After': String(rl.retryAfterSec) }));
  }
  const v = validateInput(body);
  if (!v.ok) {
    return finish(errorResponse(400, 'INVALID_INPUT', v.error.message, v.error.detail));
  }
  const { experience, jd, followups } = v.data;
  const followupText = followups.map((f) => `问：${f.question}\n答：${f.answer}`).join('\n\n');
  const sources = { experience, followupText };

  const built = buildMessages({ experience, jd, followups });
  const baseMessages = [
    { role: 'system', content: built.system },
    { role: 'user', content: built.user },
  ];
  const attempts = [
    { messages: baseMessages, timeoutMs: FIRST_TIMEOUT_MS },
    { messages: [...baseMessages, { role: 'user', content: REPAIR_INSTRUCTION }], timeoutMs: RETRY_TIMEOUT_MS },
  ];

  for (const attempt of attempts) {
    let raw;
    try {
      const llmResult = await llmCall(attempt.messages, attempt.timeoutMs, { experience });
      lastUsage = llmResult?.usage ?? null;
      raw = llmResult?.content;
    } catch (e) {
      if (e?.code === 'UPSTREAM_TIMEOUT') {
        return finish(errorResponse(504, 'UPSTREAM_TIMEOUT', '模型响应超时，请重试'));
      }
      return finish(errorResponse(502, 'UPSTREAM_ERROR', '模型服务暂时不可用，请稍后重试'));
    }
    let parsed = null;
    try {
      // 容忍模型包裹的 Markdown 代码块标记
      const text = String(raw).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      parsed = JSON.parse(text);
    } catch {
      parsed = null; // 结构损坏 → 走重试判定
    }
    if (parsed) {
      const out = validateOutput(parsed, sources);
      if (out.ok) {
        return finish(jsonResponse(200, { ...out.value, mock_mode: isMockMode() }));
      }
    }
  }
  return finish(errorResponse(500, 'INVALID_OUTPUT', '生成结果未通过质量校验，请重试'));
}

/** Vercel Serverless Function 入口（Node 运行时原生 req/res） */
export default async function vercelHandler(req, res) {
  const result = await handleRewriteRequest({ method: req.method, body: req.body, ip: clientIp(req) });
  res.statusCode = result.status;
  for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
  res.end(JSON.stringify(result.body));
}
