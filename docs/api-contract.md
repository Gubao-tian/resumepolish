# 简历润笔 V1.0 API 契约（API Contract v1.2 · 冻结版）

> 状态：**已冻结**（PM 综合两位工程师澄清报告裁决；经前后端双向确认；工程师 1 技术会签随 core PR 评审完成）
> 依据：PRD V1.0 第七章 FR-1~FR-10、第八章技术方案、第九章 DoD、第十章指标、第十一章风险；需求澄清报告（前端视角 Q1-Q6 / 后端视角 Q1-Q6 + 2 处 PRD 矛盾）
> 日期：2026-10-24 ｜ 变更链：v1.0（前端口径）→ v1.1（双工程师会商）→ v1.2（采纳工程侧共识定名）

## 0. 版本裁决记录

| # | 项 | 裁决 | 理由 |
|---|----|------|------|
| 1 | 请求体 | `experience` / `jd` / `followups?: [{question, answer}]` | FR-6「补充反问后重新生成」；followups 全量累积回传，进入溯源白名单（采纳工程师 1 Q3） |
| 2 | 改写文字段 | **`rewritten: string`（纯文本）** | 双工程师共识：纯文本复制 UX 一致、避免结构化拆分引入结构非法率；`char_count` 由前端自行计算（v1.1 曾定 `{full_text, char_count}`，本版按工程共识回落） |
| 3 | 错误信封 | `{ error: { code, message, detail? } }`，detail 可选 | 双工程师确认信封主体；detail 仅用于 `INVALID_INPUT` 指明字段 |
| 4 | HTTP 映射 | 400 / 429 / 504 / 502 / 500 | 502=LLM 上游非 2xx（Key 无效/额度不足等），与 504 超时区分 |
| 5 | 限流 | 30 次/小时/IP，滑动窗口，429 + `Retry-After` | 工程师 1 建议 10 次/分钟（≈600/小时）过松，不利于 R5 成本保护；30/小时对真实使用充足 |
| 6 | 超时预算 | 首调 15s + 非法结构重试一次 10s；服务端总预算 ≤25s；前端 AbortController 30s | 采纳工程师 1 Q1；P95 口径=用户感知端到端（含内部重试） |
| 7 | 错误码 | INVALID_INPUT(400) / RATE_LIMITED(429) / UPSTREAM_TIMEOUT(504) / UPSTREAM_ERROR(502) / INVALID_OUTPUT(500) / INTERNAL_ERROR(500) | 重试后仍非法（INVALID_OUTPUT）与一般 500 区分，便于回归定位 |
| 8 | 输出长度 | 硬校验=非空且 ≤300 字符；≤200 字为 Prompt 指令与人工评分项 | 避免为压字数丢内容，违背「挖而不编」 |
| 9 | 关键词降级 | `status=hit` 未子串命中 `rewritten` → 服务端自动降级 `missing` | 采纳工程师 1 Q6（模型自评会高估） |

## 1. 端点

```
POST /api/rewrite
Content-Type: application/json
```

## 2. 请求体

| 字段 | 类型 | 必填 | 约束 | 说明 |
|------|------|------|------|------|
| `experience` | string | 是 | 1-300 字符 | 单条简历经历原文 |
| `jd` | string | 是 | 1-2000 字符 | 目标岗位 JD 纯文本 |
| `followups` | array | 否 | `[{question, answer}]` | 对上一轮 `questions` 的回答；重新生成时全量累积回传 |

字符计数含标点；sanitize=去控制字符与零宽字符、保留正常 Unicode。
空/超限/仅空白 → `400 INVALID_INPUT`（`detail.field` 指明字段）。

## 3. 成功响应（200）

```json
{
  "mock_mode": false,
  "rewritten": "string",
  "diff":     [{ "original_segment": "string", "revised_segment": "string", "rationale": "string" }],
  "keywords": [{ "keyword": "string", "status": "hit | missing", "source_hint": "string" }],
  "questions":[{ "question": "string", "blocking": false, "reason": "string" }]
}
```

### 字段语义（可追溯至调研验收标准）

- `rewritten`：改写后完整文案（纯文本）。硬校验：非空且 ≤300 字符；≤200 字精炼目标由 Prompt 指令与人工评分保证，不做硬失败。
- `diff[]`：逐处修改对照。**`original_segment` 必须是 `experience` 的子串**（User A 验收标准"每句话能从原文找出处"）；`rationale` 必填非空（FR-4 理由缺失率 0）。
- `keywords[]`：JD 关键词提示。`status=hit` 表示已覆盖且经服务端子串复核；`missing` 表示未覆盖（原 hit 未命中者自动降级）；`source_hint` 提示可从经历哪部分挖掘——**仅提示，不得写入改写文**（PRD 研发评审条件）。
- `questions[]`：缺失信息反问。**`blocking` 恒为 `false`**（V1.0 反问不阻断改写）；`reason` 说明为何需要。前端提供"补充并重新生成"入口（followups 全量累积再次请求）。
- `mock_mode`：`true` 表示 Mock 演示（`MOCK=1` 或未配置 `LLM_API_KEY`）。前端展示"演示模式"标识。

## 4. 错误响应

```json
{ "error": { "code": "INVALID_INPUT", "message": "经历不能超过 300 字", "detail": { "field": "experience" } } }
```

| HTTP | code | 含义 | 触发条件 | 前端表现 |
|------|------|------|----------|----------|
| 400 | `INVALID_INPUT` | 输入非法 | 空/超限/仅空白/非法字符 | 输入框内联错误 |
| 429 | `RATE_LIMITED` | 超频 | 超过 30 次/小时/IP | 提示含 `Retry-After` 重试时间 |
| 504 | `UPSTREAM_TIMEOUT` | 上游超时 | 首调 15s 或重试 10s 超时 | 友好降级提示 + 重试 |
| 502 | `UPSTREAM_ERROR` | 上游错误 | LLM 返回非 2xx（Key 无效/额度不足等） | 重试按钮 |
| 500 | `INVALID_OUTPUT` | 重试后输出仍非法 | Schema/负面词/溯源校验失败 | 重试按钮 |
| 500 | `INTERNAL_ERROR` | 服务端异常 | 未分类异常 | 重试按钮 |

## 5. 非功能约束

- **超时预算**（工程师 1 Q1）：首调 15s；输出结构非法时重试一次（10s，temperature 保持 0.3，追加"严格按 Schema 输出"修复指令）；服务端总预算 ≤25s；前端 `AbortController` 30s。
- **限流**（FR-9/R3/R5）：单 IP 滑动窗口 30 次/小时，超限 429 + `Retry-After`。V1.0 不做验证码（移 V1.1，避免损害 User A/B 零门槛诉求）。
- **隐私**：请求即走即弃；不落盘、不记正文日志（仅脱敏指标：耗时/结构合法性/错误类型/token 用量；禁打印用户输入）；响应头 `Cache-Control: no-store`、`X-Content-Storage: none`。
- **Mock 模式**：`MOCK=1` 或 `LLM_API_KEY` 缺失时返回确定性 Mock 响应（`mock_mode=true`）；Mock 仅替换 LLM 调用，限流/校验/降级全链路保持真实。
- **Key 安全**：LLM Key 仅存服务端环境变量，前端 bundle 不含任何 Key（PRD 第八章）。
- **埋点**（工程师 1 Q4 裁决）：V1.0 仅后端脱敏指标日志；前端事件不落地（V1.1 再评估）。

## 6. 服务端输出校验管道（validateOutput 七道校验）

1. **Schema**：四要素字段齐全、类型正确，缺一即非法 → 触发重试一次；
2. **理由非空**：`diff[].rationale` 全部非空（FR-4）；
3. **原文子串**：`diff[].original_segment` 均为 `experience` 子串；
4. **数字溯源（一票否决）**：`rewritten` 与 `diff[].revised_segment` 中的数字，经归一化（全半角、千分位、万/亿、中/阿拉伯数字）后必须可在 `experience + followupText` 中找到，否则整体判非法；占位符"待补充"白名单放行；
5. **负面词（一票否决）**：负面词表 v1（25 词，见 tech-design 附录 A）命中 `rewritten` 或 `diff[].rationale` 任一 → 非法；
6. **关键词复核**：`status=hit` 未子串命中 `rewritten` → 服务端自动降级为 `missing`；
7. **专有名词分层**：拉丁字母 token 脚本校验；中文专有名词靠 Prompt 硬规则 + 回归集人工复核（V1.0 务实取舍，风险 R1 已记录）。

## 7. 回归样本与通过门槛（E1/U3，已裁定）

- 样本量：**12 条固定回归样本**（E1 与 U3 共用同一集合），覆盖四类失败场景（空输入 / 超长输入 / 特殊字符 / 幻觉倾向样本）；≥3 条 User A 课程项目类、≥3 条 User B 投放/活动类。
- 通过门槛：100% 返回合法四要素 JSON；负面词 0 命中；数字 100% 可溯源；人工 5 分制均分 ≥4 且虚构 0。
- **Q3 操作化定义**（矛盾 2 裁决）：同一输入连续 3 次运行，结构 100% 合法 + 负面词 0 命中 + 人工评分极差 ≤1 分。

## 8. 变更记录

| 版本 | 日期 | 变更 | 作者 |
|------|------|------|------|
| v1.0 | 2026-10-24 | 初版（前端契约口径） | PM |
| v1.1 | 2026-10-24 | 双工程师会商：followups 入请求体、限流 30/小时、超时 15s+10s、INVALID_OUTPUT、长度硬校验 ≤300、关键词降级 | PM |
| v1.2 | 2026-10-24 | 采纳工程侧共识：`rewritten` 纯文本定名、错误信封 detail 可选、新增 502 UPSTREAM_ERROR | PM |
