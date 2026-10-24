# 简历润笔 ResumePolish

> 把真实经历，翻译成目标岗位看得懂、经得起面试追问的语言。
>
> **零虚构 · 无 AI 味 · 不存数据**

面向求职者的简历单条经历改写工具：粘贴一条简历经历 + 目标岗位 JD，30 秒内返回四项输出——

1. **改写后的经历描述**：按「动作 + 方法 + 结果」语序重写，300 字以内；
2. **逐处修改对照**：改了哪里、为什么改，每处修改必带理由；
3. **岗位关键词提示**：JD 关键词哪些已保留、哪些待补充（只提示，不替你写入）；
4. **缺失信息反问**：缺数字的地方会问你——不会替你编。

产品不会新增你原文与补充回答中没有的事实、数字或专有名词；输出中的每个数字都必须可溯源至原文或补充回答（服务端七道校验一票否决）。

## 文档

- 产品需求文档（PRD V1.0）：https://github.com/Gubao-tian/resume-optimizer-prd
- 技术设计文档（ADR + 17 项 PM 裁决记录）：[`docs/tech-design.md`](docs/tech-design.md)
- API 契约 v1.2（冻结版，唯一权威）：[`docs/api-contract.md`](docs/api-contract.md)
- LLM 选型记录：[`docs/llm-selection.md`](docs/llm-selection.md)

## 快速开始

环境要求：Node.js ≥ 18.17。

```bash
npm install
cp .env.example .env   # 可选：填写 LLM_API_KEY；留空自动进入 Mock 演示模式
```

### Mock 演示模式（无需 API Key）

```bash
MOCK=1 npm start        # http://localhost:8787
```

页面会显示「演示模式」角标。Mock 为一等公民：限流、输入校验、七道输出校验全链路保持真实，仅 LLM 调用返回确定性演示数据（同输入同输出）。

### 真实模型模式

`.env` 中填写 `LLM_API_KEY`（默认 DeepSeek，OpenAI 兼容协议）：

```bash
npm start               # http://localhost:8787
```

环境变量：`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` / `PORT` / `MOCK`（见 `.env.example`）。

### 开发模式（前端热更新）

```bash
# 终端 1：API 服务器
npm run server          # 8787

# 终端 2：Vite 开发服务器（/api 自动代理到 8787）
npm run dev             # http://localhost:5173
```

## 命令一览

| 命令 | 说明 |
|------|------|
| `npm run dev` | Vite 开发服务器（5173，`/api` 代理至 8787） |
| `npm run server` | 启动本地 API 服务器（8787） |
| `npm start` | 同 `server`（生产单端口入口） |
| `npm run build` | 构建前端至 `dist/` |
| `npm test` | node:test 全量单测（104 项） |
| `node scripts/load-test.mjs` | Mock 层两层压测（P50/P95 + 同 IP 429 验证，T11） |

## 工作原理

```
浏览器（React 单页）
   │  POST /api/rewrite { experience, jd, followups? }
   ▼
Serverless handler（api/rewrite.js）
   │  ① 405 方法检查 → ② 滑动窗口限流（30 次/小时/IP，429 + Retry-After）
   │  → ③ 输入校验（300/2000 字符上限，UTF-16 码元）
   │  → ④ Prompt 构建（shared/prompt.js，三层结构 + 溯源红线）
   │  → ⑤ LLM 调用（首调 15s；结构非法重试一次 10s + 修复指令）
   │  → ⑥ 输出七道校验（shared/validate.js：负面词 / 数字溯源 / 专有名词 / …）
   ▼
{ mock_mode, rewritten, diff[], keywords[], questions[] }
```

- `shared/` 为前后端共用的纯函数核心（Prompt 构建、输入/输出校验、数字归一化、负面词表、Schema、限流器）；
- 前端 `src/api.js` 自带 30s AbortController 与响应结构纵深防御，服务端错误 `message` 原样展示，前端不做自动重试（服务端已有一次重试预算）；
- 隐私：服务端不落盘、不记正文日志，仅输出脱敏指标（耗时/状态码/错误码/token 用量）；响应带 `Cache-Control: no-store` 与 `X-Content-Storage: none`。

## 质量保障

- **104 项 node:test 单测**：Prompt 构建、输入/输出七道校验、限流器、handler 集成（200/400/405/429/500/502/504/Mock 确定性）、前端契约适配（错误码映射/超时/结构校验）、dev-server HTTP 冒烟；
- **CI 门禁**：每次 push / PR 自动执行 `npm test` + `npm run build`（GitHub Actions，ubuntu-latest + Node 20）；
- **压测工具**：`scripts/load-test.mjs` 提供 Mock 层两层压测（不烧钱）；
- **挂起项**：真实样本回归集（T10，需 User A/B 各 ≥3 条）随 M2 单独提交；真实 LLM 调用实测（T9，≥30 次 P95）待用户提供 API Key 后执行，选型推演见 `docs/llm-selection.md`。

## 部署

Vercel（同域单项目，`vercel.json` 已配置 `api` 函数 `maxDuration=30s` 与 `dist` 输出目录）：前端构建产物与 Serverless Function 同源部署，无需单独后端。也可用 `npm run build && npm start` 以单端口方式自托管。

## 目录结构

```
├── api/rewrite.js          # Serverless handler（Vercel 入口 + 编排链）
├── server/dev-server.js    # 本地单端口服务器（/api + dist 静态托管）
├── shared/                 # 前后端共用纯函数核心
│   ├── prompt.js           #   Prompt 三层构建 + 溯源红线
│   ├── validate.js         #   输入/输出校验（七道）
│   ├── numbers.js          #   数字归一化与抽取（溯源判定基础）
│   ├── negative-words.js   #   负面词表 v1（25 词）
│   ├── schema.js           #   响应结构 Schema
│   └── ratelimit.js        #   滑动窗口限流器（30 次/小时/IP）
├── src/                    # React 前端（Vite）
│   ├── api.js              #   /api/rewrite 客户端（契约适配 + 30s 超时）
│   ├── App.jsx             #   状态机与页面组装
│   └── components/         #   ExperienceForm / ResultPanel
├── tests/                  # node:test 单测（7 个文件，104 项）
├── scripts/load-test.mjs   # Mock 层两层压测
└── docs/                   # 技术设计 / API 契约 / LLM 选型
```

## 已知限制与 V1.1 待办

- 真实 LLM 调用实测（T9）挂起，待用户提供 API Key；
- 真实样本回归集（T10）随 M2 提交（需 User A/B 真实样本）；
- 限流 IP 判定取 `x-forwarded-for` 左邻 hop（Vercel 会覆写；自托管场景可伪造，V1.1 加固）；
- `questions`/`rationale` 字段的数字暂不纳入服务端溯源（设计取舍见 `shared/validate.js` 第 4 道注释）。

## 隐私承诺

免注册、免登录；输入内容仅用于本次生成，服务端不落盘、不记正文日志。详见 PRD「目标与非目标」。

## 团队与流程

五人产品团队：产品经理 ×1、用户代表 ×2、研发工程师 ×2。
研发流程：需求澄清 → 技术设计（ADR）→ 契约冻结 → 功能分支 → Pull Request → 交叉 Review（后端 PR 前端审、前端 PR 后端审）→ squash 合入 main → CI 门禁。

## License

MIT
