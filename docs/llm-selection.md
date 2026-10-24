# T1 LLM 选型报告（桌面推演版）

> 状态：**桌面推演已完成**（基于公开参数/定价/国内访问性/中文能力，数据源：api-docs.deepseek.com、docs.bigmodel.cn，2026-10-24 核对）；**实测数据待用户提供 API Key 后复核**。按 PM 裁决：不为实测注册或充值任何服务；T9 真实调用层（≥30 次 P95）同步挂起，Key 就绪后按第七节计划执行。
> 作者：研发工程师 1 ｜ 日期：2026-10-24 ｜ 关联：tech-design ADR-2、PRD §8.4、契约 v1.2 §5

## 一、选型标准（按权重排序）

| # | 标准 | 门槛 | 来源 |
|---|------|------|------|
| 1 | 中文简历语境质量 | 改写自然、无翻译腔；负面词表外无明显 AI 味 | PRD 红线「无 AI 味」 |
| 2 | 结构化输出遵循度 | JSON Schema 首 Try 合法率 ≥90%（直接影响 INVALID_OUTPUT 重试率与 30 秒预算） | 契约 v1.2 §5/§6 |
| 3 | 延迟 | 首 token ≤3s；12 样本 P95 总延迟 <15s（留 10s 重试预算） | 契约 §5 超时预算 |
| 4 | 成本 | 单次 ≤0.02 元（满足用户侧 ≤10 元红线） | PRD §8.4 |
| 5 | 可用性 | 国内直连稳定；OpenAI 兼容协议 | ADR-2、R7 |

## 二、候选与公开数据对比（桌面推演）

| 维度 | **主选：DeepSeek-V4-Flash** | 同厂商升档：DeepSeek-V4-Pro | **备选：智谱 GLM-5.3-Flash** | 零成本兜底：GLM-4.7-Flash |
|------|---------------------------|---------------------------|------------------------------|--------------------------|
| 输入价（元/百万 tokens，缓存未命中） | ≈0.99（$0.14） | ≈3.09（$0.435） | 0.8 | 免费 |
| 输出价（元/百万 tokens） | ≈1.99（$0.28） | ≈6.18（$0.87） | 2.8 | 免费 |
| 缓存命中输入价 | ≈0.02（$0.0028） | ≈0.02（$0.0028） | 限时免费 | 免费 |
| 估算单次成本（见第三节） | ≈0.003–0.005 元 | ≈0.010–0.017 元 | ≈0.004–0.006 元 | 0 元 |
| 上下文 | 1M | 1M | 128K 级 | — |
| JSON 输出（response_format） | ✓ 官方支持 | ✓ 官方支持 | ✓ 官方支持 | ✓ |
| 思考模式 | 默认开启，可关 | 默认开启，可关 | 始终开启（不可关） | — |
| 国内直连 | ✓ | ✓ | ✓ | ✓ |
| OpenAI 兼容 | ✓（/v1） | ✓（/v1） | ✓（/api/paas/v4） | ✓ |
| 并发限制 | 2500 | 500 | 视套餐 | 视套餐 |

汇率按 7.1 折算。注意事项：
- DeepSeek 官方公告将实行**峰谷定价**（高峰时段全部计费项 2 倍）——即便 2 倍，估算单次成本仍 <0.01 元，不撼动门槛；T9 实测需核对计费口径。
- 旧别名 `deepseek-chat`/`deepseek-reasoner` 已于 **2026-07-24 退役**（无宽限期），V4 时代必须使用显式模型 ID。
- GLM-5.3-Flash 为原生多模态基座、思考不可关闭，输出 token 按「含推理 token」估算；免费档 GLM-4.7-Flash 存在速率限制，仅作演示兜底，不作生产主选。

## 三、单次成本估算（基于本工具实测 Prompt 规模）

对 `buildMessages` 实测（2026-10-24，样本：经历 52 字 + JD 满额 2000 字 + 1 轮 followups）：

| 组成 | 字符数 | 估算 tokens |
|------|--------|-------------|
| system（角色红线 + 25 词禁用 + JSON Schema + 溯源规则） | 972 | ≈650 |
| user（原文 + JD + 历史问答累积） | 582–2600 | ≈390–1730 |
| **输入合计** | **1550–3570** | **≈1040–2380** |
| 输出（rewritten ≤300 字 + diff/keywords/questions） | — | ≈500–800（思考模式另加推理 token） |

按上表折算单次成本（输入 2000 + 输出 700 tokens）：

- **DeepSeek-V4-Flash**：2000×0.99/1M + 700×1.99/1M ≈ **0.0034 元**；思考模式输出翻倍 ≈0.005 元；峰时 2 倍 ≈0.010 元
- **GLM-5.3-Flash**：2000×0.8/1M + 700×2.8/1M ≈ **0.0036 元**（思考常开按 1400 输出 ≈0.0055 元）

全部候选对门槛 4（≤0.02 元/次）有 2–5 倍余量。黑客松量级（估 5000 次/月）月成本 ≤25 元，远低于用户侧 ≤10 元红线对应的预算约束。

## 四、桌面推演结论

**主选：DeepSeek-V4-Flash**。理由：
1. 成本处于市场最低档（缓存命中输入 ≈0.02 元/M），单次 ≈0.003–0.005 元，门槛余量最大；
2. JSON Output 为官方文档明确支持的能力，直接服务标准 #2（首 Try 合法率），降低 INVALID_OUTPUT 重试率；
3. 1M 上下文远超本工具需求（输入 <2.4K tokens），JD 满额 + 多轮 followups 无截断风险；
4. 国内直连、OpenAI 兼容（`/v1`）、2500 并发，满足标准 #5；
5. 同厂商 V4-Pro 提供质量升档路径（约 3 倍成本），无需换协议。

**备选：智谱 GLM-5.3-Flash**。理由：同为国产 OpenAI 兼容协议（`open.bigmodel.cn/api/paas/v4`）、JSON 输出官方支持、成本同量级；核心价值是**验证 ADR-2「协议可替换」设计**——切换仅需改 `LLM_BASE_URL`/`LLM_MODEL` 两个环境变量，代码零改动。GLM-4.7-Flash 免费档记录为演示环境零成本兜底选项。

## 五、关键配置决策（第 1/3/4 条已于 2026-10-24 二次核对官方后修订，见裁决 #18/#19）

1. **默认模型 `deepseek-flash`（裁决 #18 修订）**：本节原记录「已修正为 `deepseek-v4-flash`」。2026-10-24 复核
   `api-docs.deepseek.com/quick_start/pricing` 脚注，官方原文为：「Use **`deepseek-flash`** as the model name. The legacy
   names **`deepseek-v4-flash`** ... are still accepted, but the corresponding models **have been retired**」——
   即 `deepseek-v4-flash` 同样是官方标注的**退役 legacy name**（请求仍被接受，实际由 DeepSeek-V4.1-Flash-1017 承接
   并按 Flash 计费），此前「修正退役别名」的方向修错了。默认值改为官方现行 ID **`deepseek-flash`**，`.env.example` 同步加注。
2. **`response_format: {type:'json_object'}` 已启用**：提升 JSON 首 Try 合法率（标准 #2），两家候选均官方支持；Markdown 包裹容忍 + 一次结构重试作为纵深防御保留。
3. **思考模式由「保持默认开启」改为「显式关闭」（裁决 #19 修订）**：原决策是「V4-Flash 默认 thinking on，质量优先，
   15s 首调预算内可容纳，降级开关记录在案但不启用」。复核 `api-docs.deepseek.com/guides/thinking_mode` 后发现一条
   此前未知的事实：**thinking 模式下 `temperature` 无效**——「for compatibility ... setting these parameters will not
   trigger an error but will also have no effect」。这与本节原第 4 条「temperature 维持 0.3（契约 §5 冻结值）」直接冲突：
   **契约冻结的确定性控制手段实际处于静默失效状态**，而代码无任何报错提示。
   又因 V1.0 的输出质量由服务端七道校验兜底（而非模型推理深度），且本场景为单条经历改写（轻任务），
   故改为显式下发 `thinking: {type:'disabled'}`：使 temperature=0.3 真正生效，同时降低延迟与 token 成本
   （thinking=high 会显著增加输出 token 与耗时，直接威胁 15s 首调预算与单次成本红线）。
   该字段**仅对 DeepSeek 端点下发**（非 DeepSeek 端点返回 null 不携带），以保持 ADR-2 协议可替换性；
   保留 `LLM_THINKING=enabled` 开关供 T9 做 A/B 实测对比。
4. **temperature 维持 0.3**（契约 §5 冻结值，**实际生效性经 #19 修订后恢复**）：此前因 thinking 默认开启，
   该冻结值被上游静默忽略；关闭 thinking 后重新成为有效的确定性控制手段。

## 六、Mock 层已验证的结论（T9 挂起期间的能力边界）

**未实测变量已收窄为「真实上游的延迟、成本与输出质量」**：2026-10-24 以本地 OpenAI 兼容假上游
（`FAKE_MODE` 覆盖 ok / 5xx / 401 / 非 JSON 文本 / 延迟 20s / 数字放大 / 空 content 共七种行为）
对 `callLLM` 的**真实分支**做了端到端验证，**7/7 通过**——请求体构造、超时预算（首调严格 15s）、
错误映射（5xx 与 401 → 502 `UPSTREAM_ERROR`；结构非法 → 重试一次后 500 `INVALID_OUTPUT`；
上游超时 → 504 `UPSTREAM_TIMEOUT`）、数字溯源一票否决在真实分支同样生效、token 用量正常回传。
在此之前该分支**仅有 Mock 覆盖，从未被端到端执行过**。
因此仍需真实 Key 才能测量的只剩：真实延迟 P50/P95、真实 token 成本、真实模型的输出质量与 JSON 首 Try 合法率。

其余链路已由 Mock 模式（MOCK=1 或缺 Key 自动进入，`mock_mode:true`）全链路实测：

- 限流：同 IP 35 连发 → 30×200 + 5×429（Retry-After 正确），窗口滑动恢复符合预期；
- 七道输出校验：64 项单测覆盖（Schema/理由非空/原文子串/数字溯源一票否决/负面词一票否决/关键词降级/拉丁 token 分层）；
- 降级与重试：结构非法重试一次（10s + 修复指令）、上游 502/504/500 映射正确；
- 压测（Mock 层）：并发 5 × 50 请求 P95 ≈ 4ms、0 错误（`scripts/load-test.mjs`，真实层压测需 Key，见 T9）；
- 隐私：响应头 `Cache-Control: no-store` + `X-Content-Storage: none`，日志仅脱敏指标（耗时/状态码/错误码/token 用量/mock 标记）。

## 七、T9 实测计划（用户提供 Key 后执行）

1. 样本：回归集 12 条（E1/U3 共用集合）× 每家 3 轮；另做 ≥30 次连续调用测 P95；
2. 参数与线上一致：temperature=0.3、response_format=json_object、thinking=disabled；
   另跑一组 `LLM_THINKING=enabled`（≥30 次）做 A/B 对比，用于复核裁决 #19 关于
   「关闭 thinking 不损失输出质量」的判断（该判断目前只有官方参数语义支撑，尚无实测证据）；
3. 记录：首 token 延迟、总延迟 P50/P95、prompt/completion token 用量、单次成本、JSON 首 Try 合法率、
   七道校验通过率（复用 `shared/validate.js`）、峰谷计费口径、thinking on/off 两组的质量与延迟对比；
4. 判定：达门槛 #2/#3 → 维持主选；未达 → 按 ADR-2 仅改环境变量切备选并重跑本报告，代码零改动。
