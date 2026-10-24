/**
 * 负面词表 v1（25 词，PM 批准签发，tech-design 附录 A）。
 * 命中任一即判输出非法；扫描范围：rewritten + diff[].rationale（契约 v1.2 §6 第 5 道）。
 * 词表随回归集人工复核持续增补（V1.1 机制化）。
 */

/** @type {readonly string[]} */
export const NEGATIVE_WORDS = Object.freeze([
  // 用户调研中点名的"AI 味三件套"
  '赋能', '抓手', '闭环',
  // 过程虚词
  '颗粒度', '对齐', '拉通', '沉淀', '链路', '打法', '心智',
  // 宏大叙事
  '护城河', '顶层设计', '底层逻辑', '方法论', '组合拳', '强力驱动',
  '全面升级', '深度整合', '高效协同', '持续优化', '显著提升',
  '卓有成效', '全方位', '多维度', '顶层思维',
]);

/**
 * 扫描文本中命中的负面词（子串匹配）。
 * @param {unknown} text 待扫描文本
 * @returns {string[]} 命中词列表（按词表顺序，词表内无重复故无需去重）
 */
export function findNegativeWords(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  /** @type {string[]} */
  const hits = [];
  for (const word of NEGATIVE_WORDS) {
    if (text.includes(word)) hits.push(word);
  }
  return hits;
}
