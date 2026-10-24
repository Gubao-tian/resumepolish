/**
 * 极简 .env 加载器（仅本地开发使用）。
 *
 * 为什么不用 `node --env-file-if-exists=.env`：
 * - `--env-file` 需 Node ≥20.6，`--env-file-if-exists` 需 Node ≥22.9；
 * - 本项目 CI 与部分开发者环境仍在 Node 20（见 .github/workflows/ci.yml），
 *   改用 CLI flag 会让 `npm start` 在 Node 20 上直接失败（unknown option）。
 * 自行加载可跨版本一致工作，且不引入额外依赖。
 *
 * 为什么必须加载：README 与 .env.example 指导用户把 LLM_API_KEY 写入 .env，
 * 而原先 `npm start` 不会读取它 —— 用户填了 Key 仍会静默进入 Mock 模式（缺陷 #18 修复）。
 *
 * 规则：
 * - 忽略空行与 `#` 开头的整行注释；
 * - 支持 `KEY=VALUE`（= 两侧空白裁剪），去掉成对单/双引号；
 * - 支持行内注释：未加引号的值中 `#` 之后的内容被剥离（`KEY=sk-x # 这是我的 Key`）；
 *   已加引号的值**不剥离**（`KEY="a#b"` 保留 `#`），以兼容含 `#` 的密钥；
 * - 支持 `export KEY=VALUE` 前缀（兼容 shell 习惯写法）；
 * - **不覆盖**已存在的环境变量：真实环境与平台注入优先，避免 .env 误覆盖线上配置；
 * - 文件不存在或读取失败时静默返回，不阻断启动（Mock 演示模式仍可用）。
 */

import { readFile } from 'node:fs/promises';

/**
 * 解析 .env 文本为键值对。
 * @param {string} text
 * @returns {Record<string,string>}
 */
export function parseEnv(text) {
  /** @type {Record<string,string>} */
  const out = {};
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = body.indexOf('=');
    if (eq <= 0) continue; // 无 = 或键名为空
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue; // 非法键名跳过
    let value = body.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.at(-1) === quote && value.length >= 2) {
      value = value.slice(1, -1); // 已加引号：原样保留（含 # 的密钥不被截断）
    } else {
      // 未加引号：剥离行内注释，避免「KEY=sk-x # 注释」把注释当成密钥的一部分
      const hash = value.indexOf('#');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/**
 * 把 .env 内容并入 env（不覆盖已有键）。
 * @param {string} file 文件路径
 * @param {NodeJS.ProcessEnv} [env] 目标环境，默认 process.env
 * @returns {Promise<{ loaded: string[], skipped: string[], missing: boolean }>}
 *   loaded=新写入的键；skipped=因已存在而未覆盖的键；missing=文件不存在
 */
export async function loadEnv(file, env = process.env) {
  /** @type {string[]} */ const loaded = [];
  /** @type {string[]} */ const skipped = [];
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return { loaded, skipped, missing: true };
  }
  for (const [k, v] of Object.entries(parseEnv(text))) {
    if (Object.prototype.hasOwnProperty.call(env, k)) skipped.push(k);
    else {
      env[k] = v;
      loaded.push(k);
    }
  }
  return { loaded, skipped, missing: false };
}
