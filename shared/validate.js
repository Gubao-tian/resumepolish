/**
 * 输入校验与输出校验（契约 v1.2 §2/§6）。
 *
 * validateInput ：请求体校验与 sanitize（去控制字符与零宽字符，保留正常 Unicode）；
 * validateOutput：七道校验管道——
 *   1. Schema（validateShape）          2. 理由非空（并入 Schema 校验）
 *   3. original_segment 原文子串        4. 数字溯源（一票否决）
 *   5. 负面词（一票否决）               6. 关键词 hit→missing 服务端降级（不影响 ok）
 *   7. 专有名词分层：拉丁 token 脚本硬校验；中文专有名词靠 Prompt 硬规则 + 回归集人工复核
 *
 * 溯源口径（Q2 裁决）：sources = experience + followupText，不含 JD；
 * JD 关键词只允许出现在 keywords 字段（由模型从 JD 提取），不得进入改写文案。
 */

import { findNegativeWords } from './negative-words.js';
import { extractLatinTokens, extractNumbers, normalizeForMatch, textContainsNumber } from './numbers.js';
import { validateShape } from './schema.js';
import { MAX_EXPERIENCE_LEN, MAX_JD_LEN } from './prompt.js';

/** 控制字符与零宽/格式字符（保留 \t \n \r；契约 v1.2 §2 sanitize 规则） */
const CONTROL_OR_FORMAT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u00AD\u200B-\u200F\u2028\u2029\u2060\uFEFF]/g;

/**
 * sanitize：去控制字符与零宽字符，保留正常 Unicode（契约 v1.2 §2）。
 * @param {string} s
 * @returns {string}
 */
export function sanitizeText(s) {
  return s.replace(CONTROL_OR_FORMAT, '');
}

/**
 * @param {'body'|'experience'|'jd'|'followups'} field
 * @param {string} message
 */
function invalidInput(field, message) {
  return { ok: false, error: { code: 'INVALID_INPUT', message, detail: { field } } };
}

/**
 * 请求体校验（FR-1/FR-2/FR-6；契约 v1.2 §2）。
 * @param {unknown} body
 * @returns {{ ok: true, data: { experience: string, jd: string, followups: Array<{question:string,answer:string}> } }
 *          | { ok: false, error: { code: 'INVALID_INPUT', message: string, detail: { field: string } } }}
 */
export function validateInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return invalidInput('body', '请求体格式不正确');
  }
  if (typeof body.experience !== 'string') {
    return invalidInput('experience', '请粘贴一条简历经历');
  }
  const experience = sanitizeText(body.experience);
  if (experience.trim().length === 0) {
    return invalidInput('experience', '请粘贴一条简历经历');
  }
  if (experience.length > MAX_EXPERIENCE_LEN) {
    return invalidInput('experience', `经历不能超过 ${MAX_EXPERIENCE_LEN} 字，请拆分成多条`);
  }
  if (typeof body.jd !== 'string') {
    return invalidInput('jd', '请粘贴目标岗位 JD，否则无法进行岗位对照改写');
  }
  const jd = sanitizeText(body.jd);
  if (jd.trim().length === 0) {
    return invalidInput('jd', '请粘贴目标岗位 JD，否则无法进行岗位对照改写');
  }
  if (jd.length > MAX_JD_LEN) {
    return invalidInput('jd', `JD 不能超过 ${MAX_JD_LEN} 字，请精简至岗位职责与任职要求部分`);
  }
  /** @type {Array<{question:string,answer:string}>} */
  const followups = [];
  if (body.followups !== undefined) {
    if (!Array.isArray(body.followups)) {
      return invalidInput('followups', '补充回答格式不正确');
    }
    for (const f of body.followups) {
      if (!f || typeof f !== 'object' || Array.isArray(f)
        || typeof f.question !== 'string' || f.question.trim().length === 0
        || typeof f.answer !== 'string' || f.answer.trim().length === 0) {
        return invalidInput('followups', '补充回答格式不正确');
      }
      followups.push({ question: sanitizeText(f.question), answer: sanitizeText(f.answer) });
    }
  }
  return { ok: true, data: { experience, jd, followups } };
}

/**
 * 输出校验（七道管道；契约 v1.2 §6）。
 * @param {unknown} parsed 模型输出（JSON.parse 结果）
 * @param {{ experience?: string, followupText?: string }} sources 溯源白名单（experience + followupText，不含 JD）
 * @returns {{ ok: true, value: object } | { ok: false, error: { code: 'INVALID_OUTPUT', issues: string[] } }}
 */
export function validateOutput(parsed, sources) {
  const shape = validateShape(parsed);
  if (!shape.ok) {
    return { ok: false, error: { code: 'INVALID_OUTPUT', issues: shape.issues } };
  }
  const experience = typeof sources?.experience === 'string' ? sources.experience : '';
  const followupText = typeof sources?.followupText === 'string' ? sources.followupText : '';
  const haystack = `${experience}\n${followupText}`;

  /** @type {string[]} */
  const issues = [];
  const value = { ...parsed, diff: parsed.diff, keywords: parsed.keywords.map((k) => ({ ...k })) };

  // 第 3 道：original_segment 必须是 experience 子串（归一化口径，与前端黄标校验一致）
  const normExperience = normalizeForMatch(experience);
  value.diff.forEach((item, i) => {
    const seg = normalizeForMatch(item.original_segment);
    if (seg.length === 0 || !normExperience.includes(seg)) {
      issues.push(`diff[${i}].original_segment 不是经历原文的片段`);
    }
  });

  // 第 4 道：数字溯源（一票否决）。范围：rewritten + diff[].revised_segment（契约 §6）
  const numberTargets = [['rewritten', value.rewritten], ...value.diff.map((d, i) => [`diff[${i}].revised_segment`, d.revised_segment])];
  for (const [label, text] of numberTargets) {
    for (const num of extractNumbers(text)) {
      if (!textContainsNumber(haystack, num)) {
        issues.push(`${label} 中的数字「${num}」无法溯源至原文或补充回答`);
      }
    }
  }

  // 第 5 道：负面词（一票否决）。范围：rewritten + diff[].rationale（契约 §6）
  for (const word of findNegativeWords(value.rewritten)) {
    issues.push(`rewritten 命中禁用词「${word}」`);
  }
  value.diff.forEach((item, i) => {
    for (const word of findNegativeWords(item.rationale)) {
      issues.push(`diff[${i}].rationale 命中禁用词「${word}」`);
    }
  });

  // 第 7 道（拉丁部分）：rewritten + revised_segment 中的拉丁 token 必须可溯源
  const sourceTokens = new Set(extractLatinTokens(haystack));
  for (const [label, text] of numberTargets) {
    for (const token of extractLatinTokens(text)) {
      if (!sourceTokens.has(token)) {
        issues.push(`${label} 中出现无法溯源的拉丁专有名词「${token}」`);
      }
    }
  }

  // 第 6 道：关键词 hit 复核降级（不影响 ok；契约 §6）
  const normRewritten = normalizeForMatch(value.rewritten);
  value.keywords = value.keywords.map((k) => (
    k.status === 'hit' && !normRewritten.includes(normalizeForMatch(k.keyword))
      ? { ...k, status: 'missing' }
      : k
  ));

  if (issues.length > 0) {
    return { ok: false, error: { code: 'INVALID_OUTPUT', issues } };
  }
  return { ok: true, value };
}
