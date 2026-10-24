# 简历润笔 ResumePolish V1.0 技术设计文档

> 状态：**已评审定稿**（PM 汇总两位工程师《需求澄清与技术方案报告》，裁决全部开放项）
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

- 前端：纯静态 SPA（React 18 + Vite 5），`base: './'`，可托管于任意静态平台；
- 后端：Vercel Serverless Function（Node 18+ 运行时，原生 `fetch`），仅作 LLM 代理，隐藏 API Key；
- 共享核心：`shared/` 纯函数模块（Prompt 构建 / 输出校验 / 数字归一化 / 负面词表），前端不引用、服务端与单测共用，保证"契约即代码"；
- Mock 模式为一等公民：无 Key 可完整演示与测试，仅替换 `callLLM`，限流/校验/降级全链路真实。

## 3. 模块划分与职责

| 路径 | 职责 | 作者 |
|------|------|------|
| `shared/negative-words.js` | 负面词表 v1（25 词） | E1 |
| `shared/numbers.js` | 数字归一化与包含判断纯函数 | E1 |
| `shared/schema.js` | 四要素 RESPONSE_SCHEMA + 结构校验 | E1 |
| `shared/prompt.js` | `buildMessages({experience, jd, followups})` → `{system, user, temperature: 0.3}` | E1 |
| `shared/validate.js` | `validateInput(body)` / `validateOutput(parsed, sources)`（七道校验 + 关键词降级） | E1 |
| `shared/ratelimit.js` | 滑动窗口限流器（30 次/小时/IP） | E1 |
| `api/rewrite.js` | Serverless handler（编排上述模块，Vercel 约定入口） | E1 |
| `server/dev-server.js` | 本地单端口服务器（`/api/rewrite` + `dist/` 静态托管） | E1 |
| `scripts/load-test.mjs` | 两层压测脚本（Mock 层 + 真实层） | E1 |
| `src/*`（App/components/api.js/styles.css） | 单页工具前端 | E2 |
| `tests/*` | node:test 单测与集成测试 | E1/E2 |
| `.github/workflows/ci.yml` | push/PR 跑 `npm test` + `npm run build` | E1 |
| `vercel.json` | 部署路由（静态 + `/api/*` → Function） | E1 |

## 4. 关键设计决策（ADR）

### ADR-1：V1.0 采用 ESM JavaScript + JSDoc，不做 TypeScript

- **背景**：工程师 1 建议 Node + TypeScript。
- **决策**：V1.0 用零额外工具链的 ESM JS + JSDoc 类型标注；`node:test` 直跑测试，`vite` 直构前端，不引入 tsc/@types/tsx。
- **理由**：契约文档（api-contract.md）+ JSDoc 已提供接口纪律；TS 的编译链路在 Serverless/测试/CI 三处增加配置面，V1.0 追求最小可信工具链。TypeScript 迁移列入 V1.1 技术债。
- **后果**：接口变更靠评审与测试把关；`validateOutput` 的返回结构必须有充分单测覆盖（已列入测试清单）。

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

数字归一化规则（`shared/numbers.js`）：全半角统一、千分位去分隔、万/亿换算为数量级比较、中文/阿拉伯数字互转；"待补充"占位符白名单。

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
| 5 | 埋点口径 | **V1.0 仅后端脱绒指标日志**（耗时/结构合法性/错误类型/token 用量，禁打印输入）；前端事件不落地；撤销前端最小三事件方案（省 0.25-0.5 人日） | E1 Q4 / E2 Q5 修订 |
| 6 | 限流阈值与验证码 | 30 次/小时/IP（非 10 次/分钟，保护 R5 成本）；验证码移 V1.1；压测两层（Mock 无限次 + 真实 ≥30 次 P95） | E1 Q5 |
| 7 | 负面词表 | v1 共 25 词批准签发（附录 A）；扫描范围=`rewritten`+`diff[].rationale`；hit→missed 自动降级 | E1 Q6 |
| 8 | 命名分歧 | 双工程师共识优先：`rewritten` 纯文本；其余字段名取显式命名（diff/keywords/questions），char_count 前端自算 | E1/E2 会商 |
| 9 | 交互流 | 维持一次性往返、四要素同屏、反问不阻断（`blocking` 恒 false） | E2 Q1 |
| 10 | 前端工作量 | 以自底向上 5.25 人日为基线；V1.0 冻结 T1/T2/T3/T5/T6/T7/T9=3.5 人日；T4 组件测试、T8 埋点移 V1.1；PRD §8.5 "2-3 人日"按 3.5 修订 | E2 8.5 |
| 11 | 工具链 | ADR-1（ESM JS + JSDoc，TS 移 V1.1） | E1 D1 修订 |

## 10. 任务拆分与里程碑

| ID | 任务 | 负责 | 人日 | 依赖 | 交付物 |
|----|------|------|------|------|--------|
| T0 | 契约冻结 + 技术设计文档 | PM | 0.5 | — | docs/*.md |
| T1 | LLM 选型实测（主选+备选） | E1 | 0.5 | — | 选型报告（随 PR #3） |
| T2 | shared/prompt.js | E1 | 0.5 | T0 | PR #2 |
| T3 | shared/validate.js + numbers.js | E1 | 1.0 | T0 | PR #2 |
| T4 | 单测：prompt / validate / numbers | E1 | 0.5 | T2,T3 | PR #2 |
| T5 | shared/ratelimit.js + 单测 | E1 | 0.25 | T0 | PR #3 |
| T6 | api/rewrite.js handler | E1 | 1.0 | T2,T3,T5 | PR #3 |
| T7 | server/dev-server.js + 集成测试 | E1 | 0.75 | T6 | PR #3 |
| T8 | Mock 模式 | E1 | 0.25 | T6 | PR #3 |
| T9 | vercel.json + CI workflow | E1 | 0.25 | T7 | PR #3 |
| T10 | 回归脚本 + 12 样本 | E1 | 0.5 | T8 | PR #3 |
| T11 | 压测两层 | E1 | 0.5 | T9 | PR #3 |
| T12 | Vercel 部署 + 联调 | E1 | 0.5 | 全部 | 演示地址 |
| F1-F9 | 前端（form/api.js/ResultPanel/状态机/样式/构建验收/部署适配） | E2 | 3.5 | T0 | PR #4 |
| R1-R3 | 交叉 Review（PR #2/#3/#4） | E1/E2 | 1.5 | — | Review 记录 |

后端合计 ≈ 6.75 人日（T1 不阻塞主线）+ 前端 3.5 + Review 1.5 + 文档 0.5 ≈ **12.25 人日**，落在 PRD §8.5 的 12-15 人日区间。

## 11. 测试策略

**单元测试（node:test，零额外依赖）**

- `tests/prompt.test.js`：system 含负面词表/Schema/溯源规则；followups 正确拼接；temperature=0.3；
- `tests/validate-input.test.js`：长度边界 299/300/301、1999/2000/2001、空/纯空白、控制字符与零宽字符、followups 结构；
- `tests/validate-output.test.js`：Schema 违规（缺字段/类型错/理由空）、数字溯源（拦截"3 渠道"改"10 渠道"；放行"待补充"；放行 followups 补充；归一化 ３万/30,000/三万/30000 互通）、负面词命中、关键词降级、original_segment 非子串；
- `tests/numbers.test.js`：归一化边界；
- `tests/ratelimit.test.js`：窗口内放行/超限 429/Retry-After；
- `tests/rewrite-api.test.js`：集成——Mock 模式 200 形状、mock_mode=true、400/429/500 路径。

**回归与压测**

- 回归集 12 条（§9 裁决 2）；门槛见契约 §7；
- 压测两层：Mock 层无限次验证 P95 与限流触发；真实层 ≥30 次记录 P95（需 Key，手动执行）。

**前端门禁（V1.0）**：`npm run build` 通过 + 手工验收（User A/B 验收标准清单）+ 联调（T12）。组件测试（vitest+jsdom）移 V1.1。

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
3. §8.5 前端工作量「2-3 人日」→「3.5 人日（自底向上口径，V1.0 冻结范围 T1/T2/T3/T5/T6/T7/T9）」；
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
- CI：push/PR 触发 `npm test` + `npm run build`，红即禁合。
