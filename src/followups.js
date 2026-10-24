/**
 * 多轮反问回答的累积合并（契约 §2 全量累积；FR-6 补充并重新生成）。
 *
 * 语义：重新生成时前端必须回传「全部已回答项」（本轮新答 + 历史回答），
 * 同一 question 以后来回答为准，保留首次出现的顺序——服务端据此拼装
 * 数字溯源白名单（experience + followups），顺序与去重都影响溯源结果。
 *
 * 提取为纯函数以便在 node:test 下直测（ADR-1 v1：零新增依赖、单一测试运行器）。
 *
 * @param {Array<{question: string, answer: string}>} prev 历史已回答项
 * @param {Array<{question: string, answer: string}>} incoming 本轮新增或更新的回答项
 * @returns {Array<{question: string, answer: string}>} 合并后的全量回答（新数组，不修改入参）
 */
export function mergeFollowups(prev, incoming) {
  const merged = prev.map((item) => ({ ...item }));
  for (const item of incoming) {
    const idx = merged.findIndex((f) => f.question === item.question);
    if (idx >= 0) merged[idx] = { ...item };
    else merged.push({ ...item });
  }
  return merged;
}
