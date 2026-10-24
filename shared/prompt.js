/**
 * Prompt 构建（tech-design §6 三层结构）。
 *
 * system 层：角色与红线 + 负面词清单 + 四要素 JSON Schema + 溯源规则 + 专有名词规则；
 * user   层：经历原文 + JD + followups 问答（如有）+ 约束复述。
 *
 * temperature 固定 0.3（契约 v1.2 §5）；结构非法重试时由调用方追加修复指令，温度不变。
 */

import { NEGATIVE_WORDS } from './negative-words.js';

export const MAX_EXPERIENCE_LEN = 300;
export const MAX_JD_LEN = 2000;
export const PLACEHOLDER_TOKEN = '待补充';

/** @returns {string} system prompt（三层结构） */
function buildSystem() {
  return [
    '你是资深简历文案编辑，唯一原则是「挖而不编」：只把用户真实的经历翻译成目标岗位看得懂、经得起面试追问的成果描述；绝不新增用户原文与补充回答中没有的事实、数字或专有名词。',
    '',
    '【输出禁用词】以下词汇禁止出现在任何输出字段中：',
    NEGATIVE_WORDS.join('、'),
    '',
    '【输出格式】只输出一个 JSON 对象本身，不要输出解释文字，不要使用 Markdown 代码块标记。字段固定为：',
    '- rewritten：string，改写后的完整经历描述，单段文本，按「动作+方法+结果」语序组织；控制在 200 字以内，不得超过 300 字；',
    '- diff：array，逐处修改对照，每项含 original_segment（必须是经历原文的逐字片段）、revised_segment（对应改后片段）、rationale（修改理由，说明为什么这样改）；',
    '- keywords：array，岗位关键词提示，每项含 keyword（从 JD 提取的与岗位能力相关的关键词或技能名词，5-10 个）、status（hit=该关键词已出现在 rewritten 中；missing=未出现）、source_hint（提示可从经历哪部分挖掘；仅提示，不得把 JD 专有名词写进改写文）；',
    '- questions：array，缺失信息反问，每项含 question（具体追问）、blocking（恒为 false）、reason（为何需要该信息）；无需追问时输出空数组。',
    '',
    '【溯源红线】违反以下任一条即视为严重错误：',
    '1. rewritten 与 diff[].revised_segment 中出现的每一个数字，都必须原样来自经历原文或用户的补充回答；不得换算放大、不得四舍五入、不得新造；',
    `2. 原文与补充中缺失的数字，用「${PLACEHOLDER_TOKEN}」占位，并同步在 questions 中追问；严禁编造具体数值；`,
    '3. 公司名、人名、产品名、证书名、工具名等专有名词禁止新造；JD 中出现的专有名词不得写入改写文案；',
    '4. diff[].original_segment 必须是原文逐字片段，不得概括、不得改写后冒充原文。',
  ].join('\n');
}

/**
 * 构建 LLM 消息（纯函数，可独立单测）。
 * @param {{ experience?: string, jd?: string, followups?: Array<{ question?: string, answer?: string }> }} input
 * @returns {{ system: string, user: string, temperature: 0.3 }}
 */
export function buildMessages({ experience, jd, followups } = {}) {
  const exp = typeof experience === 'string' ? experience : '';
  const jdText = typeof jd === 'string' ? jd : '';
  const fu = Array.isArray(followups) ? followups : [];

  let user = `【经历原文】\n${exp}\n\n【目标岗位 JD】\n${jdText}`;
  if (fu.length > 0) {
    const qa = fu.map((f) => `问：${f && typeof f.question === 'string' ? f.question : ''}\n答：${f && typeof f.answer === 'string' ? f.answer : ''}`).join('\n\n');
    user += `\n\n【用户对反问的补充】\n${qa}`;
  }
  user += '\n\n【输出要求】严格按系统提示中的字段输出，仅输出 JSON 对象本身。';

  return { system: buildSystem(), user, temperature: 0.3 };
}
