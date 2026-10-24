# Bug 管理闭环案例：Issue #22

> 本文档完整记录 Issue #22 从提交到关闭的全过程，作为项目「Bug Management」流程的一个可追溯范例。
> 所有时间戳、评论、提交均来自 GitHub 公开记录，可在对应链接上查证。

---

## 案例概览

| 项 | 内容 |
|------|------|
| Issue | [#22 经历仅输入标点返回 500](https://github.com/Gubao-tian/resumepolish/issues/22) |
| 类型 | 🐛 Bug |
| 修复 PR | [#25](https://github.com/Gubao-tian/resumepolish/pull/25)（commit `1f79370`） |
| 提交人 | User A |
| 全程耗时 | 约 34 分钟（14:08:30 提交 → 14:42:32 关闭） |

---

## 八个阶段

### 1️⃣ Issue Submitted（提交）— 14:08:30

User A 提交，正文五段齐全（问题描述 → 复现步骤 → 预期结果 → 实际结果 → 日志证据）。

**问题**：经历仅输入标点（「。」「！！！」）时返回 `500 INVALID_OUTPUT`，而预期应是 `400` 友好引导。

她甚至自行定位了根因方向：`normalizeForMatch()` 剥掉标点后归一化归零，导致下游校验必然失败；并指出**这不是 Mock 专属**——真实模型路径同样必然 500，每次白烧「首调 15s + 重试 10s」两次 LLM 调用。

### 2️⃣ Triage（分诊定级）— 14:13

PM 定级 **P1**（排在最前）。理由：它不在 Mock 路径，会直接消耗真实 LLM 预算。

PM 独立复现时**扩展了触发面**——不止标点，纯 emoji「🎉」、符号「￥」同样 500，因为 `normalizeForMatch()` 剥的是四类字符（`\p{P}\p{Z}\p{C}\p{S}`），任何「归一化后为空」的输入都命中。

### 3️⃣ Reproduce（研发复现与根因）— 14:13 起

研发 engineer-review **独立复现，未沿用 PM 结论**，定位根因：

```
shared/validate.js:54   输入校验用 experience.trim().length === 0 判「空」
shared/validate.js:111  输出校验用 normalizeForMatch(seg).length === 0 判「空」
```

两道校验的「空」口径不一致：纯标点能骗过 `trim()`（非空），却在下游归一化后归零，使输出校验第 3 道对**任何**模型输出都必然失败。

### 4️⃣ Fix（修复）— PR #25，14:30 合并

分支 `fix/validate-normalized-empty → main`，+48 行。

修法**不是「禁止标点」这种打补丁**，而是**统一口径**：在 `validateInput` 中为 `experience` 与 `jd` 补「归一化后非空」判定，复用同一个 `normalizeForMatch()`。`trim()` 判定保留在前，使纯空白仍走原有分支。新增 4 项单测。

### 5️⃣ Code Review（评审）— 14:30 后

研发 review 通过，并**反哺出 #34–#38 五个后续缺陷**——因为 review 发现 #22 只堵了「输入层面归一化为空」，没堵「片段层面剥离后为空」（纯虚词）这第二个同族分支。

这正是 review 的价值：不是盖章式通过，而是逼出下一层问题。

### 6️⃣ Test（测试）— 全程

全量单测从 166 → 197 项全绿（Node 20 与 Node 22 双环境），CI 门禁通过。

端到端：`。！！！，，，🎉￥……` 全部 `400`；含 emoji 的正常输入不误伤。

### 7️⃣ User Acceptance（用户验收）— 15:08

**User A 本人账号**留验收评论（非 PM 转述）：

> 我用提 Issue 时的原场景复验，确认修的就是我遇到的那个问题。

并注明她额外补测了 `￥`——比原 Issue 记录的触发面更宽。

### 8️⃣ Closed（关闭）— 14:42:32

Issue 关闭。整条链 8 个阶段、4 条公开评论、1 个 PR、1 个合并 commit，全部可查。

---

## 为什么这条案例值得作为范例

1. **根因定位靠研发独立复现**，不是 PM 拍脑袋——研发还纠正了 PM 注释里一处不严谨的措辞（「对任何输出都必然失败」，实测 `diff:[]` 时第 3 道不执行反而通过）。
2. **修复方案是「统一口径」而非「打补丁」**——如果只针对标点加判断，堵不住 emoji（扩展触发面），也堵不住后续的纯虚词（#34）。
3. **Code Review 反哺出新缺陷**——#22 的 review 直接催生了 #34–#38 五个后续 Issue，这是流程「活」的标志。

---

## 证据链索引

| 阶段 | 公开记录 |
|------|----------|
| Issue 本体 | [issues/22](https://github.com/Gubao-tian/resumepolish/issues/22) |
| PM 复现评论 | issues/22 · 评论 1（14:13:27） |
| 修复说明 | issues/22 · 评论 2（14:42:31，附 PR #25） |
| 用户验收 | issues/22 · 评论 3（15:08:51，User A） |
| 研发核验 | issues/22 · 评论 4（15:13:41） |
| 修复 PR | [pull/25](https://github.com/Gubao-tian/resumepolish/pull/25) |
| 合并 commit | `1f79370` |
