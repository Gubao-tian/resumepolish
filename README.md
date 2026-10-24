# 简历润笔 ResumePolish

> 把真实经历，翻译成目标岗位看得懂、经得起面试追问的语言。
>
> **零虚构 · 无 AI 味 · 不存数据**

面向求职者的简历单条经历改写工具：粘贴一条简历经历 + 目标岗位 JD，30 秒内返回四项输出——结构化改写文案、逐处修改对照、岗位关键词提示、缺失信息反问。

## 文档

- 产品需求文档（PRD V1.0）：https://github.com/Gubao-tian/resume-optimizer-prd
- 技术设计文档：[`docs/tech-design.md`](docs/tech-design.md)

## 快速开始

```bash
npm install
cp .env.example .env   # 可选：填写 LLM_API_KEY；留空自动进入 Mock 演示模式

# 终端 1：启动 API 服务器（Mock 或真实 LLM）
npm run server

# 终端 2：启动前端开发服务器
npm run dev            # http://localhost:5173
```

生产模式（单端口，同时提供静态页面与 API）：

```bash
npm run build
npm start              # http://localhost:8787
```

## 测试

```bash
npm test               # node:test，覆盖 Prompt 构建 / 输出校验 / API 集成
```

## 隐私承诺

免注册、免登录；输入内容仅用于本次生成，服务端不落盘、不记正文日志。详见 PRD「目标与非目标」。

## 团队

五人产品团队：产品经理 ×1、用户代表 ×2、研发工程师 ×2。
研发流程：需求澄清 → 技术设计 → 功能分支 → Pull Request → 交叉 Review → 合入 main。
