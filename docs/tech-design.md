# 简历润笔 ResumePolish V1.0 技术设计文档

> 状态：**已评审定稿 v1.2**（v1.0 澄清裁决 → v1.1 曾试修订 ADR-1 为前端 TS → v1.2 依据实现证据撤回该修订，ADR-1 v1 维持）
> 关联：[PRD V1.0](https://github.com/Gubao-tian/resume-optimizer-prd) · [API 契约 v1.2](api-contract.md)
> 日期：2026-10-24 ｜ 作者：产品经理（团队 lead）｜ 评审：研发工程师 1（后端/全栈）、研发工程师 2（前端/AI 应用）

---

## 1. 范围与目标

V1.0 唯一核心功能（PRD §7）：**JD 对照的单条经历改写**。用户输入一条简历经历（≤300 字）+ 目标岗位 JD（≤2000 字），30 秒内返回四要素：改写文（`rewritten`）、逐处修改对照（`diff`）、关键词提示（`keywords`）、缺失信息反问（`questions`）。

三条不可逾越红线：**零虚构、无 AI 味、不存用户简历数据**。

非目标（V1.0）：全文评分、排版、多经历批量、历史记录、登录注册、验证码、前端埋点（详见 PRD §3 与本文档 §9 裁决）。

## 2. 架构总览

```
┌─────────────┐   POST /api/rewrite   ┌──────────────────────────┐
│  浏览器      │ ───────────────────▶ │  Serverless Function      │
│  (Vite 静态  │ ◀─────────────────── │  api/rewrite.js           │
│   React SPA) │   四要素 JSON / 错误  │  ├─ validateInput         │
└─────────────┘                      │  ├─ rateLimit (30/h/IP)   │
       ▲                             │  ├─ buildMessages         │
       │ 30s AbortController         │  ├─ callLLM (15s)         │
       │                             │  ├─ validateOutput        │
       │                             │  │   └─ 非法→重试1次(10s)  │
       │                             │  └─ callLLM 可替换为 Mock  │
       │                             └──────────┬───────────────┘
       │                                        │ OpenAI 兼容协议
       │                                        ▼
       │                              ┌──────────────────┐
       └── 演示/测试（MOCK=1）────────│  Mock 确定性响应   │
                                      └──────────────────┘
```

- 前端：静态 SPA（React 18 + Vite 5，ESM JS + JSX），同源部署（Vercel），开发态 `/api` 代理到 `127.0.0.1:8787`；
- 后端：Vercel Serverless Function（Node 18+ 运行时，原生 `fetch`），仅作 LLM 代理，隐藏 API Key；
- 共享核心：`shared/` 纯函数模块（Prompt 构建 / 输出校验 / 数字归一化 / 负面词表 / 限流器），服务端与 node:test 单测共用，保证"契约即代码"；
- Mock 模式为一等公民：无 Key 可完整演示与测试，仅替换 `callLLM`，限流/校验/降级全链路真实。

## 3. 模块划分与职责

| 路径 | 职责 | 作者 | PR |
|------|------|------|-----|
| `shared/negative-words.js` | 负面词表 v1（25 词） | E1 | #2 |
| `shared/numbers.js` | 数字归一化与包含判断纯函数 | E1 | #2 |
| `shared/schema.js` | 四要素 RESPONSE_SCHEMA + 结构校验 | E1 | #2 |
| `shared/prompt.js` | `buildMessages({experience, jd, followups})` | E1 | #2 |
| `shared/validate.js` | `validateInput` / `validateOutput`（七道校验 + 关键词降级） | E1 | #2 |
| `src/api.js` | 前端 API 客户端（30s 超时/错误码映射/结构校验） | E2 | #3 |
| `src/components/ExperienceForm.jsx` | 输入区（计数/内联错误/隐私声明） | E2 | #3 |
| `src/components/ResultPanel.jsx` | 四要素结果区 + 反问补充重生成 | E2 | #3 |
| `src/App.jsx` | 状态机 + 错误态 + followups 累积 | E2 | #3 |
| `tests/*.test.js` | node:test 单测与集成（服务端 + 前端契约适配） | E1/E2 | #2/#3 |
| `.github/workflows/ci.yml` | push/PR 触发 `npm test` + `npm run build` | E1 | #2 |
| `shared/ratelimit.js`、`api/rewrite.js`、`server/dev-server.js`、`scripts/load-test.mjs`、`vercel.json`、`tests/ratelimit.test.js`、`tests/rewrite-api.test.js`、`docs/llm-selection.md` | Serverless 代理与压测 | E1 | #4（进行中） |

## 4. 关键设计决策（ADR）

### ADR-1（v1，维持）：全仓 ESM JavaScript + JSX，零 TypeScript

- **决策**：`src/**`、`shared/**`、`api/**`、`server/**`、`tests/**` 全部使用 ESM JavaScript（JSX 用于 React 组件）；不引入 TypeScript / tsc / @types；测试用 Node 内置 `node:test`；不引入 vitest / jsdom / MSW / Testing Library。
- **理由**：契约文档（api-contract.md）+ JSDoc + 前后端双重结构校验已提供接口纪律；最小工具链使 CI 只需 `npm test` + `npm run build` 两条命令，依赖面最小（运行时仅 react/react-dom）。
- **已知代价（接受）**：V1.0 无组件级测试；前端契约适配以 Node 直测 `src/api.js`（fetch 注入、无 import.meta 依赖）覆盖 17 项，见 tests/web-api.test.js。
- **修订历史**：v1.1 曾依据前端 TS 原型（25 项 vitest 测试）修订为"前端 TypeScript"（v2）；实现阶段前端最终按派工清单以 JS 交付且 PR #3 不含 package.json 变更，该修订于 v1.2 撤回，ADR-1 v1 维持。教训：派工指令须显式绑定"冻结 ADR 偏离需先请示"。

### ADR-2：LLM 走 OpenAI 兼容协议，默认 DeepSeek，可替换

- 单一 `callLLM(messages, {timeout})` 封装 `POST {LLM_BASE_URL}/chat/completions`；选型只改环境变量。
- `temperature=0.3`（稳定性优先）；主选 DeepSeek 级国产 API（成本约 0.01 元/次，满足 ≤10 元红线；GPT-4 贵且国内访问不稳——PRD §8）。
- T1 选型结论随 serverless PR（docs/llm-selection.md）附上；**实测数据待用户提供 API Key 后复核**（见裁决 15）。

### ADR-3：Mock 模式为一等公民

- `MOCK=1` 或 `LLM_API_KEY` 缺失 → 确定性 Mock 响应（`mock_mode=true`），输入哈希决定 fixture，保证同输入同输出。
- Mock 仅替换 LLM 调用层；限流、校验、降级、错误信封全链路真实——压测与 CI 不依赖真实 Key。

### ADR-4：纯函数核心 + 薄 handler

- `buildMessages` / `validateOutput` 为无副作用纯函数，可独立单测；handler 只做编排（校验→限流→调用→校验→降级→响应）。
- 重试策略内置于 handler：结构非法 → 追加修复指令重试一次（10s），仍非法 → `INVALID_OUTPUT`。

### ADR-5：部署 Vercel（静态 + Functions 同域），GitHub Actions 仅 CI

- 静态前端与 API 同域部署，无 CORS 问题；Vercel 免费档起步，成本上限靠限流控制（PRD §8.4/R5）。
- GitHub Pages 不作为演示目标：Pages 无 API 运行时，会造成"半可用"演示。CI（test + build）由 Actions 承担。

## 5. API 契约

以 [docs/api-contract.md v1.2](api-contract.md) 为唯一权威。要点：

- 请求：`experience`(1-300) / `jd`(1-2000) / `followups?`（全量累积 `[{question, answer}]`）；
- 响应：`{mock_mode, rewritten, diff[], keywords[], questions[]}`；`diff[].original_segment` 必须是原文子串；`questions[].blocking` 恒 `false`；
- 错误：`INVALID_INPUT`(400) / `RATE_LIMITED`(429) / `UPSTREAM_TIMEOUT`(504) / `UPSTREAM_ERROR`(502) / `INVALID_OUTPUT`(500) / `INTERNAL_ERROR`(500)。

## 6. Prompt 设计（三层结构）

```
system = 角色与红线（挖而不编；零虚构；无 AI 味）
       + 负面词表（输出禁用清单，25 词）
       + 四要素 JSON Schema（字段强制）
       + 溯源规则（新增信息必须出自原文/followups；否则进 questions）
       + 专有名词规则（公司/人名/证书/产品名等中文专有名词禁止新造）
user   = 经历原文 + JD + followups 问答（如有）
       + 约束复述（≤300 字精炼、四要素齐全、逐处对照）
```

- `temperature=0.3`；重试时追加"严格按 Schema 输出"修复指令，温度不变。

## 7. 输出校验管道（七道，详见契约 §6）

Schema → 理由非空 → 原文子串 → **数字溯源（一票否决）** → **负面词（一票否决）** → 关键词 hit 复核降级 → 专有名词分层（拉丁 token 脚本 + 中文 Prompt 硬规则 + 人工复核）。

数字归一化规则（`shared/numbers.js`）：全半角统一、千分位去分隔、万/亿换算为数量级比较、中文/阿拉伯数字互转（含"三千五"=3500 等口语简写）；"待补充"占位符白名单。

## 8. 限流与超时预算

| 项 | 值 | 说明 |
|----|----|------|
| 限流 | 30 次/小时/IP（滑动窗口） | 429 + `Retry-After`；V1.0 无验证码 |
| 首调超时 | 15s | 国产模型首 token 1-3s，800 字生成约 10-20s |
| 重试 | 1 次，10s | 仅结构非法触发 |
| 服务端总预算 | ≤25s | 超时 → 504 友好降级 |
| 前端 | AbortController 30s | 用户感知 P95 ≤30s（DoD-F） |

## 9. PM 裁决记录（开放项闭环）

| # | 事项 | 裁决 | 出处 |
|---|------|------|------|
| 1 | 北极星口径矛盾（§10.1 ≥65% vs §9.3 U1 "三分之二" vs §12.2 门禁） | **统一为 ≥65%**，以 §10.1 为唯一口径；U1 与 §12.2 表述按此修订（PRD 勘误） | E1 矛盾 1 |
| 2 | Q3 可测性 + E1/U3 样本量矛盾 | E1 与 U3 **共用同一回归集，规模 12 条**（12-15 区间下限，覆盖四类失败）；Q3 操作化：同输入 3 次运行结构 100% 合法 + 负面词 0 + 人工评分极差 ≤1 | E1 矛盾 2 |
| 3 | Q2 虚构检测 vs 关键词边界 | 三点默认假设全部采纳：溯源拦截仅数字与狭义专有名词；hit=子串命中且非专有名词或原文已含；专有名词不得以 JD 形式进入文案 | E1 Q2 |
| 4 | followups 契约 | 采纳：请求体 `followups:[{question,answer}]` 全量累积，进入溯源白名单 | E1 Q3 |
| 5 | 埋点口径 | **V1.0 仅后端脱敏指标日志**（耗时/结构合法性/错误类型/token 用量，禁打印输入）；前端事件不落地；前端埋点桩整项剔除（T7 取消） | E1 Q4 / E2 Q5 修订 |
| 6 | 限流阈值与验证码 | 30 次/小时/IP（否决 10 次/分钟过松口径）；验证码移 V1.1；压测两层（Mock 无限次 + 真实 ≥30 次 P95） | E1 Q5 |
| 7 | 负面词表 | v1 共 25 词批准签发（附录 A）；扫描范围=`rewritten`+`diff[].rationale`；hit→missed 自动降级 | E1 Q6 |
| 8 | 命名分歧 | 双工程师共识优先：`rewritten` 纯文本（不拆 action/method/result）；其余字段名取显式命名（diff/keywords/questions） | E1/E2 会商 |
| 9 | 交互流 | 一次性往返、四要素同屏、反问不阻断（`blocking` 恒 false） | E2 Q1 |
| 10 | 前端工作量 | 自底向上口径；实际 T1-T9 约 6 人日（含 17 项契约适配测试，已入库 tests/web-api.test.js）；PRD §8.5 前端按 6 人日修订，总量约 14.75 人日（≤15） | E2 实测 |
| 11 | 工具链 | ADR-1 v1 维持：全仓 ESM JS + JSX，node:test 单运行器（v1.1 的 v2 修订已撤回，见 ADR-1 修订历史） | 实现证据 |
| 12 | 超时「继续等待」按钮 | **不实现**：服务端总预算 ≤25s 早于前端 30s abort——超时场景下前端先收到 504 错误响应，"继续等待"没有适用窗口 | E2 Q2 |
| 13 | 部署目标 | Vercel 同域（ADR-5）；GitHub Pages 不作演示（无 API 运行时） | E2 提问 |
| 14 | FR-8 隐私声明形态 | **常驻隐私声明行接受**（表单下方常驻"输入仅用于本次生成，不存储、不用于其他用途"）：始终可见优于首访横幅（无 dismissal、无 localStorage、无"已读"状态管理），FR-8 核心诉求（明示不存储）满足 | E1 评审建议 + PM 裁决 |
| 15 | T1 LLM Key | 团队无 Key：选型按公开参数与定价完成桌面推演（docs/llm-selection.md），**实测数据待用户提供 Key 后复核**；T9 真实调用层（≥30 次 P95）同步挂起，Mock 层验证已完成 | 环境约束 |
| 16 | 字符计数口径 | **UTF-16 码元**（`String.length`，emoji 记 2）：契约原书「字符」未定单位，属澄清而非变更；后端 `shared/validate.js`（`experience.length>300` / `jd.length>2000`）与前端 `src/api.js`（`countChars=text.length`）已双统一，前后端无口径差；改码点口径需动已过全量测试的两侧实现，边缘场景不值得回归风险 | E2 分歧 2 + PM 裁决 |
| 17 | Mock 数字放大 | **不放大**：Mock「数量翻倍」场景保守回落原文数字是正确行为——溯源红线「数字必须原样来自原文或补充回答，不得换算放大、不得四舍五入、不得新造」（shared/prompt.js）+ 七道校验一票否决，翻倍产出会被自己的校验判 INVALID_OUTPUT；保守回落符合「挖而不编」原则 | E1 缺陷 #9 裁决 |
| 18 | 默认模型名 | **改为官方现行 ID `deepseek-flash`**：此前把已退役的 `deepseek-chat` 「修正」为 `deepseek-v4-flash`，**方向修错**——复核 api-docs.deepseek.com 定价页脚注，官方原文「Use `deepseek-flash` as the model name. The legacy names **`deepseek-v4-flash`** ... are still accepted, but the corresponding models **have been retired**」，即 `deepseek-v4-flash` 同为退役 legacy name（请求仍被接受、由 DeepSeek-V4.1-Flash-1017 承接并按 Flash 计费）。影响面有限（不会报 400、功能可用，故严重度中而非阻断），但默认值不应指向官方标注退役的名字 | 2026-10-24 官方核对 |
| 19 | thinking 模式 | **由「保持默认开启」改为「显式关闭」**（修订 docs/llm-selection.md 第五节第 3 条原决策）：原决策假设「thinking 有质量增益、15s 预算内可容纳」。复核官方 Thinking Mode 文档后发现原决策时未知的事实——**thinking 模式下 `temperature` 无效**（「will not trigger an error but will also have no effect」），与本节「契约 §5 冻结 temperature=0.3」直接冲突：**冻结的确定性控制手段实际静默失效且无任何提示**。又因 V1.0 输出质量由服务端七道校验兜底（而非模型推理深度），且本场景为单条经历改写（轻任务），故显式下发 `thinking:{type:'disabled'}`：让 temperature=0.3 真正生效，并降低延迟与 token 成本（thinking=high 会显著增加输出 token 与耗时，直接威胁 15s 首调预算与单次成本红线）。**仅对 DeepSeek 端点下发**（非 DeepSeek 返回 null 不携带），保持 ADR-2 可替换性；保留 `LLM_THINKING=enabled` 供 T9 A/B 对比。注意：**「关闭 thinking 不损失输出质量」目前只有官方参数语义支撑，尚无实测证据**，列为 T9 必测项，不得据此宣称质量已验证 | 2026-10-24 官方核对 |
| 20 | `npm start` 不读 `.env` | **必须修（阻断级）**：README 与 `.env.example` 均指导用户把 `LLM_API_KEY` 写入 `.env`，但 package.json 的 `server`/`start` 脚本未带任何 env 加载机制 → **用户填了 Key 仍会静默进入 Mock 模式且无任何提示**，直接阻断真实模型使用。**不采用** `node --env-file-if-exists=.env`：该 flag 需 Node ≥22.9，而 CI 为 Node 20（.github/workflows/ci.yml），会让 Node 20 用户 `npm start` 直接失败（unknown option）。改为自带极简加载器 `shared/load-env.js`：**不覆盖**已有环境变量（平台注入优先，避免 .env 误覆盖线上配置）、文件缺失静默跳过（Mock 演示仍可用）；启动时回显「已加载 .env：N 项生效」与当前真实/Mock 模式，**仅回显键名与数量，绝不打印任何值**（守隐私红线） | 2026-10-24 链路验证 |

## 10. 任务拆分与里程碑

| ID | 任务 | 负责 | 人日 | 依赖 | 交付物 |
|----|------|------|------|------|--------|
| T0 | 契约冻结 + 技术设计文档 | PM | 0.5 | — | docs/*.md ✅ |
| T1 | LLM 选型（桌面推演 + 实测待 Key） | E1 | 0.5 | — | docs/llm-selection.md（随 PR #4） |
| T2-T4 | shared 核心 + 单测 + CI | E1 | 2.0 | T0 | PR #2 ✅ |
| T5-T9 | 限流/handler/服务器/Mock/压测/部署配置 | E1 | 2.75 | T2-T4 | PR #4（进行中） |
| T10 | 回归脚本 + 12 样本 | E1 | 0.5 | T9 | PR #4 |
| T12 | Vercel 部署 + 前后端联调 | E1/E2 | 0.5 | 全部 | 演示地址（待 Key/部署） |
| F1-F9 | 前端（含 17 项契约适配测试） | E2 | 6.0 | T0 | PR #3 ✅ |
| R1-R3 | 交叉 Review（PR #2/#3/#4） | E1/E2 | 1.5 | — | Review 记录 ✅（#2/#3 已完成） |

后端合计 ≈ 6.75 人日（T1 不阻塞主线）+ 前端 6.0 + Review 1.5 + 文档 0.5 ≈ **14.75 人日**，落在 PRD §8.5 的 12-15 人日区间。

## 11. 测试策略

**单一运行器（node:test，零额外依赖）**

| 层 | 命令 | 覆盖 |
|----|------|------|
| 服务端 + 前端契约适配 | `npm test`（=`node --test`，默认发现 `**/*.test.js`） | shared 纯函数、限流、API 集成、src/api.js 契约适配 |

**服务端单测**

- `tests/prompt.test.js`：system 含负面词表/Schema/溯源规则；followups 正确拼接；temperature=0.3；
- `tests/validate-input.test.js`：长度边界 299/300/301、1999/2000/2001、空/纯空白、控制字符与零宽字符、followups 结构；
- `tests/validate-output.test.js`：Schema 违规（缺字段/类型错/理由空）、数字溯源（拦截"3 渠道"改"10 渠道"；放行"待补充"；放行 followups 补充；归一化 ３万/30,000/三万/30000/三千五互通）、负面词命中、关键词降级、original_segment 非子串；
- `tests/numbers.test.js`：归一化边界（含副词串 NaN 跳过回归用例）；
- `tests/ratelimit.test.js`：窗口内放行/超限 429/Retry-After；
- `tests/rewrite-api.test.js`：集成——Mock 模式 200 形状、mock_mode=true、400/429/500 路径。

**前端契约适配测试**（tests/web-api.test.js，17 项）：400/429/500/超时/非法结构/supplements 传递/followups 累积/Retry-After 解析/结构校验降级。`src/api.js` 以 fetch 注入解耦，无 import.meta 依赖，可在 Node 下直测。

**回归与压测**

- 回归集 12 条（§9 裁决 2）；门槛见契约 §7；
- 压测两层：Mock 层无限次验证 P95 与限流触发（已完成）；真实层 ≥30 次记录 P95（待 Key，裁决 15）。

**测试发现纪律（Node 22 守卫）**：若未来引入 `.test.ts` 文件，`node --test` 默认发现会误抓并因 `vitest` 包不存在而失败——届时须将 test 脚本改为 glob 限定 `tests/**/*.test.js`。V1.0 无 .ts 文件，暂不触发。

**已知风险（E1 提出，回归集度量）**：拉丁 token 硬校验严格——SQL/Python 等出现在输出但原文没有时可能误判 INVALID_OUTPUT；若回归集误报率高，V1.0 增设常见技术名词白名单。

**V1.1 测试项**：①溯源范围扩展至 `questions[].question` 与 `diff[].rationale`（E2 评审建议：反问中幻觉数字同样误导用户）；②组件级测试（vitest + Testing Library，需先修订 ADR-1）。

## 12. 风险与应对（映射 PRD 第十一章）

| 风险 | 工程对策 | 验证 |
|------|----------|------|
| R1 幻觉/虚构 | 数字与专有名词溯源一票否决 + 重试 + followups 引导 | validate-output 单测 + 回归集 |
| R2 AI 味 | 负面词表 v1 扫描 + Prompt 禁用清单 | 负面词 0 命中门槛 |
| R3 滥用/刷量 | 30/h/IP 限流（V1.0 无验证码） | 429 集成测试 + 压测 |
| R4 时效 | 15s+10s 预算 + 504 降级 | 压测 P95 |
| R5 成本 | 限流 + 免费档 + 低成本模型 | 压测 + token 日志 |
| R6 隐私 | 不落盘/不记正文/Key 服务端/no-store | 代码评审 + 日志 lint |
| R7 上游不稳 | 协议可替换 + 502/504 区分 + 重试 | 集成测试 |

## 13. 隐私与安全

- 免注册免登录；输入仅用于本次生成；
- 服务端日志禁打印用户输入（lint 规则 + 评审检查项）；
- Key 仅服务端环境变量；`.env` 不入库（.gitignore）；
- 响应头 `Cache-Control: no-store`、`X-Content-Storage: none`；
- 前端隐私声明常驻展示（裁决 14）。

## 14. PRD 勘误（随本文档提交修订）

1. §9.3 U1「不低于三分之二」→「不低于 65%」（与 §10.1 北极星口径统一）；
2. §12.2 发布门禁引用 U1 处同步为 65%；
3. §8.5 前端工作量「2-3 人日」→「6 人日（自底向上口径，含 17 项契约适配测试）」；后端 6.75，总量 14.75；
4. §8.5「回归集 ≥10 条」→「回归集 12 条（E1/U3 共用）」。

---

## 附录 A：负面词表 v1（25 词，PM 批准签发）

赋能、抓手、闭环、颗粒度、对齐、拉通、沉淀、链路、打法、心智、护城河、顶层设计、底层逻辑、方法论、组合拳、强力驱动、全面升级、深度整合、高效协同、持续优化、显著提升、卓有成效、全方位、多维度、顶层思维

> 命中任一即判输出非法（扫描范围：`rewritten` + `diff[].rationale`）。词表随回归集人工复核持续增补（V1.1 机制化）。

## 附录 B：开发流程约定

- 分支：`feat/*`（功能）/ `docs/*`（文档）/ `chore/*`（工程）；从 `main` 切，PR 合入，squash merge；
- 提交信息：`type(scope): 描述`（feat/fix/docs/test/chore/refactor）；
- PR 模板：背景 / 内容 / 验证（命令+输出）/ 契约符合性 / 风险；
- Review：交叉评审（后端 PR 由前端工程师审、前端 PR 由后端工程师审），Google 式清单（正确性/契约/测试/安全/可读性）；
- CI：push/PR 触发 `npm test` + `npm run build`，红即禁合；
- 常用命令：`npm run dev`（5173，/api 代理 8787）｜`npm run server`（8787，Mock 或真实 LLM）｜`npm run build`｜`npm start`（单端口演示）｜`npm test`（node:test 全量）；
- 环境说明：团队共用单一 GitHub 账户（Gubao-tian），PR 作者无法批准自己的 PR，交叉评审以 COMMENT 形式交付（结论 Approve / Request changes），合入动作由 PM 执行；
- **ADR 修订纪律**：冻结决策如需偏离，先提修订请求并记录证据，再实施；事后追认需在本文档登记（ADR-1 v1→v2→v1 为首例）。
