/**
 * 四要素响应结构（契约 v1.2 §3）。
 *
 * 注意：mock_mode 由服务端注入（Mock 演示标记），模型输出仅含四要素；
 * 此处将其列为可选字段，便于 handler 对完整响应做整体校验。
 * 未知顶层字段严格拒绝（"契约即代码"）；数组项内的多余字段忽略（降低无谓重试）。
 */

/** 契约字段结构描述（文档化用途，validateShape 为权威实现） */
export const RESPONSE_SCHEMA = Object.freeze({
  mock_mode: { type: 'boolean', optional: true, note: '服务端注入，模型不输出' },
  rewritten: { type: 'string', minLength: 1, maxLength: 300, note: '硬校验非空且 ≤300 字符；≤200 字为 Prompt 软目标' },
  diff: {
    type: 'array',
    items: {
      original_segment: { type: 'string', minLength: 1, note: '必须是 experience 的子串' },
      revised_segment: { type: 'string', minLength: 1 },
      rationale: { type: 'string', minLength: 1, note: 'FR-4：修改理由缺失率 0' },
    },
  },
  keywords: {
    type: 'array',
    items: {
      keyword: { type: 'string', minLength: 1 },
      status: { enum: ['hit', 'missing'], note: 'hit 未命中 rewritten 由服务端降级为 missing' },
      source_hint: { type: 'string', note: '仅提示，不写入改写文' },
    },
  },
  questions: {
    type: 'array',
    items: {
      question: { type: 'string', minLength: 1 },
      blocking: { const: false, note: 'V1.0 反问不阻断改写，恒为 false' },
      reason: { type: 'string' },
    },
  },
});

const KNOWN_TOP_LEVEL_KEYS = new Set(['rewritten', 'diff', 'keywords', 'questions', 'mock_mode']);
const REWRITTEN_MAX_LEN = 300; // 与 prompt.js MAX_EXPERIENCE_LEN 对齐的硬上限（契约 §0 裁决 8）

/**
 * 校验模型输出的四要素结构（七道校验中的第 1/2 道：Schema 与理由非空）。
 * @param {unknown} parsed 模型输出（JSON.parse 结果）
 * @returns {{ ok: boolean, issues: string[] }}
 */
export function validateShape(parsed) {
  /** @type {string[]} */
  const issues = [];
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, issues: ['输出不是 JSON 对象'] };
  }
  for (const key of Object.keys(parsed)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) issues.push(`存在契约外字段「${key}」`);
  }
  if (typeof parsed.rewritten !== 'string') {
    issues.push('rewritten 缺失或不是字符串');
  } else {
    if (parsed.rewritten.trim().length === 0) issues.push('rewritten 为空');
    if (parsed.rewritten.length > REWRITTEN_MAX_LEN) {
      issues.push(`rewritten 超过 ${REWRITTEN_MAX_LEN} 字符（当前 ${parsed.rewritten.length}）`);
    }
  }
  if (!Array.isArray(parsed.diff)) {
    issues.push('diff 缺失或不是数组');
  } else {
    parsed.diff.forEach((item, i) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        issues.push(`diff[${i}] 不是对象`);
        return;
      }
      for (const f of ['original_segment', 'revised_segment', 'rationale']) {
        if (typeof item[f] !== 'string' || item[f].trim().length === 0) {
          issues.push(`diff[${i}].${f} 缺失或为空`);
        }
      }
    });
  }
  if (!Array.isArray(parsed.keywords)) {
    issues.push('keywords 缺失或不是数组');
  } else {
    parsed.keywords.forEach((item, i) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        issues.push(`keywords[${i}] 不是对象`);
        return;
      }
      if (typeof item.keyword !== 'string' || item.keyword.trim().length === 0) {
        issues.push(`keywords[${i}].keyword 缺失或为空`);
      }
      if (item.status !== 'hit' && item.status !== 'missing') {
        issues.push(`keywords[${i}].status 必须为 hit 或 missing`);
      }
      if (typeof item.source_hint !== 'string') {
        issues.push(`keywords[${i}].source_hint 缺失或不是字符串`);
      }
    });
  }
  if (!Array.isArray(parsed.questions)) {
    issues.push('questions 缺失或不是数组');
  } else {
    parsed.questions.forEach((item, i) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        issues.push(`questions[${i}] 不是对象`);
        return;
      }
      if (typeof item.question !== 'string' || item.question.trim().length === 0) {
        issues.push(`questions[${i}].question 缺失或为空`);
      }
      if (item.blocking !== false) {
        issues.push(`questions[${i}].blocking 必须恒为 false`);
      }
      if (typeof item.reason !== 'string') {
        issues.push(`questions[${i}].reason 缺失或不是字符串`);
      }
    });
  }
  if (parsed.mock_mode !== undefined && typeof parsed.mock_mode !== 'boolean') {
    issues.push('mock_mode 必须是布尔值');
  }
  return { ok: issues.length === 0, issues };
}
