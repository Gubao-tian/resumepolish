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

import { buildMessages, PLACEHOLDER_TOKEN } from '../shared/prompt.js';
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
 * 数字段区间（含小数点），用于避免把小数点当成句子分隔符。
 * 例：「预算 3.2 万元」→ "3.2" 占 [3, 6)，其间的 "." 不得作为切分点。
 * @param {string} text
 * @returns {Array<[number, number]>} 半开区间 [start, end)
 */
function numberSpans(text) {
  /** @type {Array<[number, number]>} */
  const spans = [];
  const re = /\d+(?:\.\d+)?/g;
  let m;
  while ((m = re.exec(text)) !== null) spans.push([m.index, m.index + m[0].length]);
  return spans;
}

/** @param {Array<[number, number]>} spans @param {number} i */
function inSpans(spans, i) {
  return spans.some(([s, e]) => i >= s && i < e);
}

/** 句子分隔符候选（英文句点亦在内，但会由 inSpans 排除数字内部的小数点） */
const SEGMENT_PUNCT = /[，。、；：！？,.;:!?]/;

/**
 * JD 中的**章节标题**——不是能力关键词，必须剔除（Issue #29）。
 * 真实招聘启事几乎都是「岗位职责：1. …；2. …」的句子型结构，
 * 这类标题被当成关键词后，前端会渲染成「待补充（JD 中出现）：岗位职责」，用户会直接懵。
 */
const JD_SECTION_HEADINGS = new Set([
  '岗位职责', '任职要求', '岗位要求', '任职资格', '职位要求', '岗位描述', '职位描述',
  '工作内容', '工作职责', '我们提供', '你将获得', '薪资福利', '福利待遇', '职位诱惑',
  '公司介绍', '团队介绍', '关于我们', '加分项', '优先条件', '能力要求', '基本要求',
]);

/**
 * 片段首尾的虚词单字——「对投放」「负责信息流投放与」这类被标点切碎的残片
 * 需剥掉首尾虚词，否则会产出带拖尾的半残短语（Issue #29）。
 */
const JD_FUNCTION_CHAR = /^[的了对和与及等其将已在为以从到并把被让使给或因所很再又还就也很]$/;

/** 剥掉片段首尾的虚词单字，直到两端都不再是虚词 */
function stripFunctionChars(p) {
  let s = p;
  let changed = true;
  while (changed && s.length > 0) {
    changed = false;
    if (JD_FUNCTION_CHAR.test(s[0])) {
      s = s.slice(1);
      changed = true;
    }
    if (s.length > 0 && JD_FUNCTION_CHAR.test(s[s.length - 1])) {
      s = s.slice(0, -1);
      changed = true;
    }
  }
  return s.trim();
}

/**
 * 按标点切成子句，各子句记录其在原文中的 [start, end) 位置。
 * 位于数字内部的标点（如 3.2 的 "."）不作为切分点。
 * @param {string} text
 * @returns {Array<{ text: string, start: number, end: number }>}
 */
function splitClauses(text) {
  const spans = numberSpans(text);
  /** @type {Array<{ text: string, start: number, end: number }>} */
  const out = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (!SEGMENT_PUNCT.test(text[i])) continue;
    if (inSpans(spans, i)) continue;
    if (i > start) out.push({ text: text.slice(start, i), start, end: i });
    start = i + 1;
  }
  if (start < text.length) out.push({ text: text.slice(start), start, end: text.length });
  return out.filter((c) => c.text.trim().length > 0);
}

/** 子句作为改写片段时的最短长度：短于此会丢掉核心信息（如「课程项目」只有 4 字） */
const MIN_SEGMENT_LEN = 6;

/**
 * 选取用于改写的原文片段（Issue #20）。三条硬约束：
 *   1. **语义完整**——按标点断句，避免切出半截词（如「渠道的日」「运营与维」）；
 *   2. **绝不切断数字**——从数字中间切断会让改写文数字与原文对不上，触发数字溯源一票否决
 *      （「预算 3.2 万元」曾被切成「预算 3」→ 3 ≠ 3.2 → 500）；
 *   3. **不丢弃量化成果**——原句的阿拉伯数字若落在后续子句，应优先保留该子句，
 *      否则用户明明写了 ROI 1.8，改写结果里却一个数都没有（正是 User B「有数据不知怎么用」的痛点）。
 *   拼接相邻子句时一律取**原文连续切片**，以保证 result 仍是 experience 的逐字子串（契约 §6 第 3 道）。
 * @param {string} text
 * @returns {string}
 */
function pickExperienceSegment(text) {
  const clauses = splitClauses(text);
  // 1) 优先保留带阿拉伯数字的子句，并尽量拼上紧邻的前一子句以保留「动作 + 结果」
  const idx = clauses.findIndex((c) => c.text.length >= MIN_SEGMENT_LEN && /\d/.test(c.text));
  if (idx >= 0) {
    if (idx > 0) {
      const merged = text.slice(clauses[idx - 1].start, clauses[idx].end); // 原文连续片段
      if (merged.trim().length > 0 && merged.length <= 24) return merged;
    }
    return clauses[idx].text;
  }
  // 2) 第一个长度适中的子句，避免「课程项目」这类过短片段
  const suitable = clauses.find((c) => c.text.length >= MIN_SEGMENT_LEN && c.text.length <= 20);
  if (suitable) return suitable.text;
  if (clauses[0]) return clauses[0].text;
  // 3) 无标点的长句：≤24 字用全文，否则硬切并回避开数字内部
  if (text.length <= 24) return text;
  const spans = numberSpans(text);
  let cut = 12;
  while (cut > 1 && inSpans(spans, cut)) cut -= 1;
  return text.slice(0, cut);
}

/** JD 切分后的通用词：这些不是「岗位能力关键词」，不应进入 keywords */
const JD_STOPWORDS = new Set([
  '实习', '实习生', '岗位', '职位', '职责', '要求', '负责', '协助', '参与', '具备', '优先',
  '经验', '能力', '相关', '以上', '以下', '学历', '本科', '硕士', '专业', '我们', '公司',
  '团队', '工作', '进行', '能够', '可以', '以及', '其他', '熟悉', '熟练', '良好', '优秀',
  '较强', '热爱', '开朗', '积极', '主动', '沟通', '协作', '精神', '意识', '加分', '待遇',
  '薪资', '福利', 'base', '地点', '城市', '投递', '简历', '邮件', '标题', '注明',
  // 职位名与头衔：这些不是「岗位能力关键词」，JD 首句常以「产品经理实习生：」开头，
  // 若不剔除会把职位名当成关键词返回（对岗位对照无意义）
  '产品经理实习生', '产品经理', '运营实习生', '产品实习生', '数据分析师', '运营专员',
  '产品助理', '运营助理', '算法工程师', '前端工程师', '后端工程师', '测试工程师',
  '实习生', '专员', '助理', '经理', '主管', '总监', '校招', '社招', '全职', '兼职',
  // 句子型 JD 里描述「掌握程度」的动词：单独出现时不是能力词
  '会用', '使用', '掌握', '了解', '精通', '擅长', '输出', '完成', '推动', '维护', '跟进',
  // 出勤/时间类套话：真实启事的任职要求里常见「每周到岗 4 天以上」，
  // 切分后会漏出「每周」「到岗」这类与时间有关、与能力无关的词（Issue #29 残余项）
  '每周', '每天', '到岗', '出勤', '实习时长', '实习期', '长期', '至少', '以上', '以内',
]);

/**
 * 从 JD 提取候选关键词（Issue #19：此前硬编码「内容生产/数据分析」，与传入的 JD 完全无关）。
 * status 按改写文是否实际包含来判定——服务端另有 hit→missing 自动降级，
 * 此处判定只是让演示数据自洽，不作为最终值（最终值由 validateOutput 重算）。
 * @param {string} jd
 * @param {string} rewritten
 */
function extractJdKeywords(jd, rewritten) {
  const parts = jd
    .split(/[，。、；：！？,.;:!?\s/（）()【】[\]<>《》“”"'\-—+]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && s.length <= 8);
  const seen = new Set();
  const candidates = [];
  for (const p of parts) {
    // 剥离职位/方向类后缀：「内容运营实习」→「内容运营」。
    // 与其穷举职位名，不如统一剥后缀——剥离后仍是 JD 的子串，不改变溯源口径。
    // 后缀剥离：末尾的「及以上」也一并剥掉，使「本科及以上」→「本科」→ 命中学历类停用词被剔除
    // （学历门槛不是能力关键词，真实 JD 的任职要求里很常见）
    let kw = p.replace(/(?:实习生|实习|岗|方向|相关|能力|经验|及以上|以上|以下)$/, '');
    // 剥首尾虚词：句子型 JD 被标点切碎后会产生「对投放效果负责」「负责信息流投放与」这类残片
    kw = stripFunctionChars(kw);
    if (kw.length < 2) continue;
    // 章节标题不是能力关键词（「待补充（JD 中出现）：岗位职责」对用户毫无意义）
    if (JD_SECTION_HEADINGS.has(kw)) continue;
    // 纯英文片段过短（如从「AB 测试」里切出的「AB」）无意义；≥3 字母的 ROI / SQL / Excel 保留
    if (/^[A-Za-z]{1,2}$/.test(kw)) continue;
    if (JD_STOPWORDS.has(kw) || seen.has(kw) || !/[\u4e00-\u9fa5A-Za-z]/.test(kw)) continue;
    seen.add(kw);
    candidates.push(kw);
  }
  // 句子型 JD 切出的是**句子片段**（「负责信息流投放」），而真实的能力名词通常更短
  // （「数据敏感」「SQL」「Excel」）。按长度升序优先，让能力词排在长句片段之前。
  candidates.sort((a, b) => a.length - b.length);
  const picked = candidates.slice(0, 5);
  if (picked.length === 0 && jd.trim().length > 0) {
    // JD 切不出候选时至少给一项，避免 keywords 为空导致演示效果缺失
    picked.push(stripFunctionChars(jd.trim().slice(0, 6)) || jd.trim().slice(0, 6));
  }
  return picked.map((kw) => {
    const hit = rewritten.includes(kw);
    return {
      keyword: kw,
      status: hit ? 'hit' : 'missing',
      source_hint: hit ? '已在改写文中体现' : '可从你与该词相关的经历中挖掘后补充',
    };
  });
}

/** 数字追问的固定文案：保持稳定，使「已回答则不重复问」的判定不因文案变化而失效 */
const NUMBER_QUESTION = '这段经历带来的可量化结果是多少？';

/**
 * Mock 确定性响应（ADR-3）：由 experience / jd / followups 三者派生。
 *
 * 设计原则（Issue #19/#20/#23）：Mock 必须真实消费三个输入，否则演示路径上的
 * FR-5（JD 对照）与 FR-6（追问累积）形同失效，用户会认为「产品没听进去我说话」。
 * 同时**绝不新增原文与补充之外的事实**——此前硬编码尾缀「搭建选题模板」会让 Mock
 * 自己违反「挖而不编」的红线（对投放岗用户而言，他从未搭过选题模板）。
 *
 * 同输入同输出；数字只来自 experience 或 followupText（契约 §6 溯源白名单），保证通过七道校验。
 * @param {{ experience?: string, jd?: string, followups?: Array<{question?:string,answer?:string}> }} ctx
 */
export function mockChatCompletion({ experience = '', jd = '', followups = [] } = {}) {
  const text = String(experience).trim();
  const jdText = String(jd).trim();
  const answersText = followups
    .map((f) => `${f?.question ?? ''}${f?.answer ?? ''}`)
    .join('\n');

  const slice = pickExperienceSegment(text).replace(/[的了和与及等其将已并]+$/, '').trim() || '这段经历';
  const passive = /^(?:负责|参与|协助)\s*/;
  const hadPassive = passive.test(slice);
  const core = slice.replace(passive, '').trim() || '这段经历';
  // 数字或拉丁字母开头时补空格，避免「主导3 个渠道」这类粘连
  const lead = /^[\dA-Za-z]/.test(core) ? '主导 ' : '主导';

  // 数字来源判定（基于**片段**而非全文，否则判定与输出不一致：
  // 全文含数字但片段不含时，改写结果里会一个数都没有）。
  // 只认阿拉伯数字：中文数字（如「一场活动」的「一」）不算「可量化成果」，
  // 否则用户写「来了大概几百人」也会被判定为已有数字而不再追问。
  const hasNumber = /\d/.test(slice);
  // 取答案中的**全部**数字（最多 4 个，避免改写文过长）。
  // 只取首个会让用户填的其余数据被静默丢弃——User A 复验时填了「6 篇，阅读量 1200，平均 400，涨粉 80」，
  // 结果只剩「6 篇」，而最有说服力的恰恰是阅读量与涨粉，观感上仍是「没完全听进去」。
  // 这些数字均来自 followupText（契约 §6 溯源白名单），全部引用不构成虚构。
  const suppliedNums = (
    answersText.match(/\d+(?:\.\d+)?\s*(?:万元|亿元|万人|千人|万|个|人|次|篇|条|份|%|％)?/g) ?? []
  ).slice(0, 4);
  const resultPart = hasNumber
    ? ''
    : suppliedNums.length > 0
      ? `，可量化成果为 ${suppliedNums.join('、')}`
      : `，可量化成果为${PLACEHOLDER_TOKEN}`;

  const rewritten = `${lead}${core}${resultPart}`;
  const asked = new Set(followups.map((f) => String(f?.question ?? '')));
  const questions = [];
  if (!hasNumber && suppliedNums.length === 0 && !asked.has(NUMBER_QUESTION)) {
    questions.push({ question: NUMBER_QUESTION, blocking: false, reason: '缺少数字成果，影响面试说服力' });
  }

  return {
    mock_mode: true,
    rewritten,
    diff: [
      {
        original_segment: slice,
        revised_segment: rewritten,
        rationale: hadPassive
          ? '「负责」类表述改为「主导」，突出 ownership 与可验证的产出'
          : '强化动作主导性与可验证的产出维度，让成果更经得起追问',
      },
    ],
    keywords: extractJdKeywords(jdText, rewritten),
    questions,
  };
}

/** 默认模型：DeepSeek 现行主选（api-docs.deepseek.com 2026-10-24 核对） */
const DEFAULT_MODEL = 'deepseek-flash';

/**
 * DeepSeek 专有 thinking 参数；非 DeepSeek 端点返回 null（ADR-2 可替换性：不引入未知字段）。
 *
 * 依据（api-docs.deepseek.com/guides/thinking_mode，2026-10-24 核对）：
 * - DeepSeek 默认 thinking=enabled 且 effort=high；
 * - **thinking 模式下 temperature 无效**——为兼容性不报错，但完全无效果。
 * 契约 §5 冻结 temperature=0.3 作为确定性控制手段；若 thinking 保持开启，该冻结值静默失效，
 * 与 docs/llm-selection.md 原「temperature 维持 0.3」记录事实冲突。
 * V1.0 场景为单条经历改写（轻任务），质量由服务端七道校验兜底而非模型推理深度，
 * 故显式关闭 thinking：使 temperature 真正生效，同时降低延迟与 token 成本。
 * T9 实测可用 LLM_THINKING=enabled 做 A/B 对比（输出质量与 P95 延迟），见 docs/llm-selection.md 裁决 #19。
 * @param {string} base
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ type: 'enabled'|'disabled' } | null}
 */
export function thinkingParam(base, env = process.env) {
  if (!/deepseek/i.test(base)) return null;
  return { type: String(env.LLM_THINKING || 'disabled').toLowerCase() === 'enabled' ? 'enabled' : 'disabled' };
}

/**
 * 上游请求体构造（纯函数，便于单测；ADR-4 薄 handler 下从 callLLM 抽出）。
 * @param {{ base?: string, messages: Array<{role:string,content:string}>, env?: NodeJS.ProcessEnv }} opts
 */
export function buildUpstreamRequest({ base = '', messages, env = process.env } = {}) {
  const body = {
    model: env.LLM_MODEL || DEFAULT_MODEL,
    messages,
    temperature: 0.3, // 契约 §5 冻结值；DeepSeek 端仅在 thinking=disabled 时生效（见 thinkingParam 注释）
    response_format: { type: 'json_object' }, // 提升 JSON 首 Try 合法率（选型标准 #2；DeepSeek/GLM 官方均支持）
  };
  const thinking = thinkingParam(base, env);
  if (thinking) body.thinking = thinking;
  return body;
}

/**
 * LLM 调用（OpenAI 兼容协议，ADR-2）。
 * 默认模型 deepseek-flash（DeepSeek 现行 ID；旧名 deepseek-v4-flash 已被官方标注为退役 legacy name，
 * 请求仍被接受但由 DeepSeek-V4.1-Flash-1017 承接，故不再作为默认值，见 docs/llm-selection.md 裁决 #18）。
 * 返回 { content, usage }；usage 仅用于脱敏指标日志（token 用量），Mock 模式为 null。
 * 错误约定：AbortError → code=UPSTREAM_TIMEOUT；非 2xx/网络异常 → code=UPSTREAM_ERROR。
 * @param {Array<{role:string,content:string}>} messages
 * @param {number} timeoutMs
 * @param {{ experience?: string, jd?: string, followups?: Array<{question?:string,answer?:string}>,
 *           followupText?: string }} ctx 真实分支只用到 messages；Mock 分支需要三个原始输入才能派生响应
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
      body: JSON.stringify(buildUpstreamRequest({ base, messages })),
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
    // Issue #24：限流按 IP 计数，而校园网/公司网等 NAT 出口下同一 IP 由多人共用，
    // 用户可能一次都没提交过却被拦。
    // 文案要点（User A 复验反馈）：原写法「请求过于频繁，请 N 秒后再试（额度按网络出口统计…）」
    // 主句与括号自相矛盾——既然是同网用户合并计算，那就不该说成是「你」频繁。
    // 改为把真实原因放在主句，避免把责任归到用户头上。
    return finish(
      errorResponse(
        429,
        'RATE_LIMITED',
        `已达当前网络出口的用量上限（校园网/公司网下与同网用户合并计算），请 ${rl.retryAfterSec} 秒后再试或换个网络`,
        undefined,
        { 'Retry-After': String(rl.retryAfterSec) }
      )
    );
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
      // Issue #19/#23：Mock 分支此前只拿到 experience，导致 JD 与 followups 被完全忽略
      // （FR-5 关键词与 JD 脱钩、FR-6 补充后输出不变）。此处把三个原始输入一并传入。
      const llmResult = await llmCall(attempt.messages, attempt.timeoutMs, { experience, jd, followups, followupText });
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
