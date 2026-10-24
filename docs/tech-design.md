# 简历润笔 ResumePolish V1.0 技术设计文档

> 状态：**已评审定稿 v1.1**（v1.0 经两位工程师澄清裁决；v1.1 修订 ADR-1 工具链决策与工作量口径，依据前端实现证据）
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

- 前端：静态 SPA（React + Vite + TypeScript），`base` 由 `VITE_BASE` 注入（默认 `/`，适配 Vercel 同域部署）；
- 后端：Vercel Serverless Function（Node 18+ 运行时，原生 `fetch`），仅作 LLM 代理，隐藏 API Key；
- 共享核心：`shared/` 纯函数模块（Prompt 构建 / 输出校验 / 数字归一化 / 负面词表），ESM JavaScript + JSDoc，服务端与 node:test 单测共用，保证"契约即代码"；
- Mock 模式为一等公民：无 Key 可完整演示与测试，仅替换 `callLLM`，限流/校验/降级全链路真实。

## 3. 模块划分与职责

| 路径 | 语言/工具 | 职责 | 作者 |
|------|-----------|------|------|
| `shared/*.js` | JS + JSDoc | 负面词表 / 数字归一化 / Schema / Prompt 构建 / 输入输出校验 / 限流器（纯函数） | E1 |
| `api/rewrite.js` | JS | Serverless handler（编排上述模块，Vercel 约定入口） | E1 |
| `server/dev-server.js` | JS | 本地单端口服务器（`/api/rewrite` + `dist/` 静态托管） | E1 |
| `scripts/load-test.mjs` | JS | 两层压测脚本（Mock 层 + 真实层） | E1 |
| `src/**` | TS + React | 单页工具前端（types/api.ts 即契约的类型化） | E2 |
| `src/mocks/**` | TS + MSW | 前端 API mock（开发/测试双端） | E2 |
| `tests/*.test.js` | node:test | 服务端单测与集成测试 | E1 |
| `src/**/*.test.ts(x)` | vitest + Testing Library | 前端单测/组件测试/集成测试 | E2 |
| `.github/workflows/ci.yml` | — | push/PR 触发 `npm run test:all` + `npm run build` | E1 |
| `vercel.json` | — | 部署路由（静态 + `/api/*` → Function） | E1 |

## 4. 关键设计决策（ADR）

### ADR-1（v2，取代 v1）：前后端工具链分离——前端 TypeScript，服务端 ESM JavaScript

- **背景**：v1 决策为全仓 ESM JS + JSDoc（最小工具链）。前端实现证据：`src/types/api.ts` 将契约固化为类型（请求/响应/错误码），配合 25 项 vitest + Testing Library + MSW 测试全绿，契约安全与测试资产价值超过工具链统一性收益。
- **决策**：`src/**` 用 TypeScript（vitest 跑测试）；`shared/`、`api/`、`server/`、`scripts/`、`tests/` 保持 ESM JS + node:test。服务端 TS 化仍列 V1.1。
- **后果**：CI 需跑两套测试运行器（`npm run test:all`）；`npm test` 必须 glob 限定 `tests/**/*.test.js`——实测 Node 22 默认发现会误抓 `src/**/*.test.ts` 并因 `vitest` 包不可用而失败（2026-10-24 实测）。
- **修订纪律**：ADR 冻结后如需偏离，先提修订请求再实施（本次为证据驱动的事后追认，流程教训记入附录 B）。

### ADR-2：LLM 走 OpenAI 兼容协议，默认 DeepSeek，可替换

- 单一 `callLLM(messages, {timeout})` 封装 `POST {LLM_BASE_URL}/chat/completions`；选型只改环境变量。
- `temperature=0.3`（稳定性优先）；模型选择主选 DeepSeek 级国产 API（成本约 0.01 元/次，满足 ≤10 元红线；GPT-4 贵且国内访问不稳——PRD §8）。
- T1 选型实测（主选 + 1 备选）结论随 serverless PR 附上，不阻塞 core PR。

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
| 10 | 前端工作量 | 以自底向上口径为准；实际 T1-T9 合计约 6 人日（含 25 项测试，超出原冻结 3.5 的部分为质量资产，予以接纳）；PRD §8.5 前端按 **6 人日**修订，总量约 14.75 人日（≤15） | E2 实测 |
| 11 | 工具链 | ADR-1 v2：前端 TS + vitest/MSW；服务端 JS + node:test；`npm test` glob 限定 `tests/**/*.test.js` | 实现证据 |
| 12 | 超时「继续等待」按钮 | **不实现**：服务端总预算 ≤25s 早于前端 30s  abort，前端收到 504 时服务端已放弃，"继续等待"无适用窗口 | E2 Q2 |
| 13 | 部署目标 | Vercel 同域（ADR-5）；GitHub Pages 不作演示（无 API 运行时）；`base` 由 VITE_BASE 注入保留静态托管灵活性 | E2 提问 |

## 10. 任务拆分与里程碑

| ID | 任务 | 负责 | 人日 | 依赖 | 交付物 |
|----|------|------|------|------|--------|
| T0 | 契约冻结 + 技术设计文档 | PM | 0.5 | — | docs/*.md |
| T1 | LLM 选型实测（主选+备选） | E1 | 0.5 | — | 选型报告（随 PR #3） |
| T2-T4 | shared 核心 + 单测 + CI | E1 | 2.0 | T0 | PR #2 ✅ |
| T5-T9 | 限流/handler/服务器/Mock/压测/部署配置 | E1 | 2.75 | T2-T4 | PR #3 |
| T10 | 回归脚本 + 12 样本 | E1 | 0.5 | T9 | PR #3 |
| T12 | Vercel 部署 + 联调 | E1 | 0.5 | 全部 | 演示地址 |
| F1-F9 | 前端（含 25 项测试） | E2 | 6.0 | T0 | PR #4 |
| R1-R3 | 交叉 Review（PR #2/#3/#4） | E1/E2 | 1.5 | — | Review 记录 |

后端合计 ≈ 6.75 人日（T1 不阻塞主线）+ 前端 6.0 + Review 1.5 + 文档 0.5 ≈ **14.75 人日**，落在 PRD §8.5 的 12-15 人日区间。

## 11. 测试策略

**测试运行器分工（ADR-1 v2）**

| 层 | 运行器 | 命令 | 覆盖 |
|----|--------|------|------|
| 服务端 | node:test | `npm test`（=`node --test tests/**/*.test.js`） | shared 纯函数、限流、API 集成（64 项） |
| 前端 | vitest + Testing Library + MSW | `npm run test:web` | 接口层/组件/主流程（25 项） |
| 全量 | — | `npm run test:all` | CI 门禁 |

**服务端单测（node:test）**

- `tests/prompt.test.js`：system 含负面词表/Schema/溯源规则；followups 正确拼接；temperature=0.3；
- `tests/validate-input.test.js`：长度边界 299/300/301、1999/2000/2001、空/纯空白、控制字符与零宽字符、followups 结构；
- `tests/validate-output.test.js`：Schema 违规（缺字段/类型错/理由空）、数字溯源（拦截"3 渠道"改"10 渠道"；放行"待补充"；放行 followups 补充；归一化 ３万/30,000/三万/30000/三千五互通）、负面词命中、关键词降级、original_segment 非子串；
- `tests/numbers.test.js`：归一化边界；
- `tests/ratelimit.test.js`：窗口内放行/超限 429/Retry-After；
- `tests/rewrite-api.test.js`：集成——Mock 模式 200 形状、mock_mode=true、400/429/500 路径。

**前端测试（vitest，25 项）**：接口层 9（400/429/500/超时/非法结构/重试语义/followups 传递）；InputPanel 7；ResultPanel 6；App 主流程集成 3。MSW 覆盖 200/400/429/500/超时五路径。

**回归与压测**

- 回归集 12 条（§9 裁决 2）；门槛见契约 §7；
- 压测两层：Mock 层无限次验证 P95 与限流触发；真实层 ≥30 次记录 P95（需 Key，手动执行）。

**已知风险（E1 提出，回归集度量）**：拉丁 token 硬校验严格——SQL/Python 等出现在输出但原文没有时可能误判 INVALID_OUTPUT；若回归集误报率高，V1.0 增设常见技术名词白名单。

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
- 响应头 `Cache-Control: no-store`、`X-Content-Storage: none`。

## 14. PRD 勘误（随本文档提交修订）

1. §9.3 U1「不低于三分之二」→「不低于 65%」（与 §10.1 北极星口径统一）；
2. §12.2 发布门禁引用 U1 处同步为 65%；
3. §8.5 前端工作量「2-3 人日」→「6 人日（自底向上口径，含 25 项前端测试）」；后端 6.75，总量 14.75；
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
- CI：push/PR 触发 `npm run test:all` + `npm run build`，红即禁合；
- 常用命令：`npm run dev`（5173，/api 代理 8787）｜`npm run server`（8787）｜`npm run build`｜`npm start`（单端口演示）｜`npm test`（服务端）｜`npm run test:web`（前端）｜`npm run test:all`；
- **ADR 修订纪律**：冻结决策如需偏离，先提修订请求并记录证据，再实施；事后追认需在本文档登记（ADR-1 v2 即首例，教训：派工指令应附带"偏离需先请示"的显式约束）。
