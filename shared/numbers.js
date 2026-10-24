/**
 * 数字归一化与溯源纯函数（契约 v1.2 §6 第 4 道：数字溯源，一票否决）。
 *
 * 规则：全半角统一、千分位去分隔、万/亿/千 换算为绝对值比较、中文/阿拉伯数字互转；
 * 「待补充」占位符不含数字字符，天然放行（prompt.js PLACEHOLDER_TOKEN）。
 *
 * 设计取舍：抽取偏向"宁可多抽不可漏抽"——漏抽会导致改写中数字被误判为虚构（假拦截），
 * 多抽只会让溯源更宽松（假放行），由回归集人工评分兜底。
 */

const CN_DIGITS = { '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
const CN_UNITS = { '十': 10, '百': 100, '千': 1000 };
const CN_BIG_UNITS = { '万': 1e4, '亿': 1e8 };
const ARABIC_UNITS = { '万': 1e4, '亿': 1e8, '千': 1e3 };
/** 单字中文数字须后接量词才视为数字，避免"统一/一定/万物"误抽取 */
const MEASURE_WORDS = '个名条次种项家天人周年月日周版倍层步类串批位岁届成章节轮';

/** 数字 token：阿拉伯（含千分位/小数/单位后缀，允许与单位间有空格）或中文数字串 */
const NUMBER_TOKEN = /\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?\s*[万亿千]?|[零〇一二两三四五六七八九十百千万亿]+/g;
/** 拉丁 token：字母开头，可含数字与 + # .（如 iOS、C++、v2） */
const LATIN_TOKEN = /[A-Za-z][A-Za-z0-9+#.]*/g;

/**
 * 中文数字串 → 数值（支持 十二 / 三千五 / 一百万 / 两亿 等）。
 * 口语简写：三千五 = 3500、三万五 = 35000（末位裸数字承接上一级单位的十分之一）；
 * 一百零五 = 105（零之后的末位数字不简写）。
 * @param {string} s
 * @returns {number} 无法解析时返回 NaN
 */
function cnToNumber(s) {
  if (!/[零〇一二两三四五六七八九十]/.test(s)) return NaN; // 纯单位串（万/千/百）不是数字
  let total = 0;
  let section = 0;
  let num = 0;
  let lastUnit = 0;
  let zeroAfterUnit = false;
  for (const ch of s) {
    if (ch in CN_DIGITS) {
      if (CN_DIGITS[ch] === 0) {
        num = 0;
        if (lastUnit > 0) zeroAfterUnit = true;
      } else {
        num = CN_DIGITS[ch];
      }
    } else if (ch in CN_UNITS) {
      if (num === 0) num = 1; // "十万"按 100000 计
      section += num * CN_UNITS[ch];
      lastUnit = CN_UNITS[ch];
      num = 0;
      zeroAfterUnit = false;
    } else if (ch in CN_BIG_UNITS) {
      total += (section + num) * CN_BIG_UNITS[ch];
      section = 0;
      num = 0;
      lastUnit = CN_BIG_UNITS[ch];
      zeroAfterUnit = false;
    } else {
      return NaN;
    }
  }
  if (num > 0 && lastUnit > 1 && !zeroAfterUnit) num *= lastUnit / 10;
  return total + section + num;
}

/**
 * 归一化单个数字 token 为规范值字符串。
 * @param {unknown} token 如 '３万' / '30,000' / '三万' / '30000' / '3.5万'
 * @returns {string|null} 规范值（如 '30000'）；不是数字时返回 null
 */
export function normalizeNumberToken(token) {
  if (typeof token !== 'string') return null;
  const s = token.normalize('NFKC').replace(/\s+/g, '');
  if (!s) return null;
  const m = s.match(/^([+-]?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(万|亿|千)?$/);
  if (m) {
    const [, sign, intPart, frac, unit] = m;
    const value = Number(`${sign === '-' ? '-' : ''}${intPart.replace(/,/g, '')}${frac ? `.${frac}` : ''}`) * (unit ? ARABIC_UNITS[unit] : 1);
    return Number.isFinite(value) ? String(value) : null;
  }
  if (/^[零〇一二两三四五六七八九十百千万亿]+$/.test(s)) {
    const value = cnToNumber(s);
    return Number.isFinite(value) ? String(value) : null;
  }
  return null;
}

/**
 * 抽取文本中的全部数字，返回规范值数组（保序去重）。
 * @param {unknown} text
 * @returns {string[]}
 */
export function extractNumbers(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  // 入口 NFKC：全角数字（３）归一为 ASCII，使 \d 可匹配
  const norm = text.normalize('NFKC');
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  const re = new RegExp(NUMBER_TOKEN.source, 'g');
  let m;
  while ((m = re.exec(norm)) !== null) {
    const raw = m[0];
    /** @type {string|null} */
    let canon = null;
    if (raw[0] >= '0' && raw[0] <= '9') {
      canon = normalizeNumberToken(raw);
    } else {
      const nextCh = norm[re.lastIndex] ?? '';
      const hasDigitChar = /[零〇一二两三四五六七八九]/.test(raw);
      if (raw.length === 1) {
        // 单字：数字或"十"须后接量词；纯单位字（万/千/百）跳过
        if (hasDigitChar || raw === '十') {
          if (!MEASURE_WORDS.includes(nextCh)) continue;
          canon = normalizeNumberToken(raw);
          // "三成" = 30%，与输出"30%"互通
          if (canon !== null && nextCh === '成') canon = String(Number(canon) * 10);
        }
      } else {
        canon = normalizeNumberToken(raw);
      }
    }
    if (canon !== null && !seen.has(canon)) {
      seen.add(canon);
      out.push(canon);
    }
  }
  return out;
}

/**
 * 判断 haystack 中是否存在与 needle 等价的数字。
 * needle 非数字时退化为归一化子串判断（供调用方复用同一归一化口径）。
 * @param {unknown} haystack
 * @param {unknown} needle
 * @returns {boolean}
 */
export function textContainsNumber(haystack, needle) {
  if (typeof haystack !== 'string' || typeof needle !== 'string' || needle.length === 0) return false;
  const canon = normalizeNumberToken(needle);
  if (canon !== null) return extractNumbers(haystack).includes(canon);
  return normalizeForMatch(haystack).includes(normalizeForMatch(needle));
}

/**
 * 文本归一化（子串匹配口径）：NFKC（全半角统一）→ 去标点/符号/空白/控制符 → 小写。
 * 前端黄标校验与后端 original_segment 子串校验共用此口径。
 * @param {unknown} text
 * @returns {string}
 */
export function normalizeForMatch(text) {
  if (typeof text !== 'string') return '';
  return text
    .normalize('NFKC')
    .replace(/[\p{P}\p{Z}\p{C}\p{S}]/gu, '')
    .toLowerCase();
}

/**
 * 抽取文本中的拉丁字母 token（长度≥2 字母，过滤 v2/A/B/C++ 等噪声）。
 * 用于专有名词溯源（契约 §6 第 7 道拉丁部分）。
 * @param {unknown} text
 * @returns {string[]} 小写 token 数组（保序去重）
 */
export function extractLatinTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const tokens = text.normalize('NFKC').match(LATIN_TOKEN) ?? [];
  const out = [];
  const seen = new Set();
  for (const t of tokens) {
    const lower = t.toLowerCase();
    if ((lower.match(/[a-z]/g) ?? []).length < 2) continue; // 单字母 token 跳过
    if (!seen.has(lower)) {
      seen.add(lower);
      out.push(lower);
    }
  }
  return out;
}
