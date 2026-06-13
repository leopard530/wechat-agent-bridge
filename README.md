<div align="center">

<img src="https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square" alt="License">
<img src="https://img.shields.io/badge/node-%3E%3D20.0-green?style=flat-square&logo=node.js" alt="Node">
<img src="https://img.shields.io/badge/typescript-5.7-blue?style=flat-square&logo=typescript" alt="TypeScript">
<img src="https://img.shields.io/badge/prs-welcome-brightgreen?style=flat-square" alt="PRs Welcome">

</div>

# wechat-agent-bridge

> 通过微信 / 飞书直接与 AI 编程助手对话。<br>
> Chat with AI coding assistants directly from WeChat / Feishu.

```
 👤 消息  →  🌉 Bridge  →  🤖 AI Agent  →  📲 回复
```

---

## ✨ 功能亮点 / Features

- **微信 + 飞书双通道** — 微信 iLink + 飞书 WebSocket 同时在线
- **多会话支持** — 每个用户可拥有多个独立 AI 会话，自由切换
- **自动容灾** — 指数退避重试、心跳监控、自动重连
- **智能连接** — 自动探测已运行的 OpenCode 服务，无需手动管理进程
- **扫码即用** — 首次扫码登录后凭据缓存，后续免扫码
- **模型 / Agent 管理** — 列出、切换 AI 模型和 Agent
- **文件浏览** — ls / cat / find / grep / diff / worktree 全支持
- **代码文件发送** — 大段代码自动提取为文件附件发送到微信

---

## 📦 架构 / Architecture

```
微信用户  ←→  iLink / 飞书 WebSocket
                        │
             bridge/orchestrator  ← 命令解析 + 格式化
                        │
                 @opencode-ai/sdk
                        │
                    OpenCode AI
```

---

## 🚀 快速开始 / Quick Start

### 环境要求 / Prerequisites

- **Node.js** >= 20
- **OpenCode CLI** 已安装并在 PATH 中

### 安装 / Setup

```bash
git clone https://github.com/leopard530/wechat-agent-bridge.git
cd wechat-agent-bridge

# 安装依赖
npm install

# 配置环境变量（可选，默认值即可运行）
cp .env.example .env

# 构建
npm run build
```

### 启动 / Run

```bash
npm run dev             # 开发调试
npm start               # 生产运行（需先 npm run build）
npm run dev -- --channel wechat   # 只启动微信通道
npm run dev -- --channel feishu   # 只启动飞书通道
```

首次启动会打印扫码链接，用微信扫描即可登录。凭据缓存在 `data/wechat/` 下，后续无需重复扫码。

在微信中发送 `/status` 即可确认 Bridge 连接正常。

---

## 🎮 命令参考 / Commands

### 会话 / Sessions

| 命令 | 说明 |
|---------|-------------|
| `/new` | 创建新的 AI 会话 |
| `/sessions` | 列出所有活跃会话 |
| `/session <n>` | 切换到第 n 号会话 |
| `/messages [N]` | 查看最近 N 条对话 |
| `/undo` | 撤销上一步操作 |
| `/redo` | 重做已撤销的操作 |
| `/summarize` | AI 压缩当前会话 |
| `/abort` | 中断当前正在执行的任务 |

### 模型 / Models

| 命令 | 说明 |
|---------|-------------|
| `/models` | 列出可用模型（加任意参数刷新缓存） |
| `/model` | 查看当前模型及实际使用的模型 |
| `/model <序号>` | 使用 `/models` 列表中的序号切换模型 |
| `/model <provider/model>` | 按 provider/model 格式切换模型 |
| `/model clear` | 恢复默认模型 |

### Agent

| 命令 | 说明 |
|---------|-------------|
| `/agents` | 列出可用 Agent |
| `/agent` | 查看当前 Agent |
| `/agent <序号/名称>` | 切换 Agent |
| `/agent clear` | 恢复默认 Agent |

### 系统提示 / System Prompt

| 命令 | 说明 |
|---------|-------------|
| `/system` | 查看当前系统提示 |
| `/system <提示词>` | 设置系统提示 |
| `/system clear` | 清除系统提示 |

### 文件浏览 / File Browsing

| 命令 | 说明 |
|---------|-------------|
| `/ls [路径]` | 列出目录文件 |
| `/cat <路径>` | 查看文件内容 |
| `/find <模式>` | 按名称搜索文件 |
| `/grep <正则>` | 搜索文件内容 |
| `/diff` | 查看 git diff |
| `/worktree` | 查看 git worktree |

### 其他 / Other

| 命令 | 说明 |
|---------|-------------|
| `/cd <路径>` | 切换工作目录 |
| `/send <路径>` | 将文件发送到微信 |
| `/todo` | 查看当前任务列表 |
| `/task <文本>` | 异步大任务 |
| `/approve` `/a` | 批准待确认操作 |
| `/deny` `/d` | 拒绝待确认操作 |
| `/status` | 查看 Bridge 和连接状态 |
| `/help` `/h` | 显示帮助信息 |

直接发送文字内容即为 AI 对话消息。

---

## 🔄 连接恢复 / Connection Recovery

Bridge 内置多层容灾机制：

- **智能连接** — 启动时自动探测已运行的 OpenCode 服务，直接连接；无则自动启动新进程
- **API 重试** — 所有 OpenCode 调用均采用指数退避重试（1s → 30s）
- **503 重试** — 服务端 5xx 错误自动重试 3 次
- **健康监控** — 每 30 秒心跳检测，连续 3 次失败触发自动恢复
- **自动重连** — 服务中断后先探测同端口是否有新服务，没有则启动新进程
- **飞书代理兼容** — 自动绕过本地代理，直连飞书 API

---

## ⚙️ 配置 / Configuration

通过环境变量配置（支持 `.env` 文件或系统环境变量）。

| 变量 | 默认值 | 说明 |
|----------|---------|-------------|
| `OPENCODE_HOST` | `127.0.0.1` | OpenCode 服务地址 |
| `OPENCODE_PORT` | `4096` | OpenCode 服务端口 |
| `OPENCODE_MODEL` | — | 默认模型，如 `opencode-go/qwen3.7-plus` |
| `WECHAT_DATA_DIR` | `./data/wechat` | 微信凭据存储路径 |
| `SESSION_STORE_PATH` | `./data/sessions.json` | 会话持久化文件 |
| `FEISHU_APP_ID` | — | 飞书机器人 App ID |
| `FEISHU_APP_SECRET` | — | 飞书机器人 App Secret |
| `LOG_LEVEL` | `info` | 日志级别 |

---

## 🚢 部署 / Deployment

### 开发机 / 个人电脑

```bash
git clone https://github.com/leopard530/wechat-agent-bridge.git
cd wechat-agent-bridge
npm install
cp .env.example .env   # 按需编辑
npm run build
npm start
```

### 更新

```bash
git pull
npm install           # 如有新依赖
npm run build
# 重启进程即可
```

---

## 🧪 开发 / Development

```bash
npm test              # 运行全部测试
npm run test:watch    # 监听模式
```

---

## 🛠 技术栈 / Tech Stack

| 技术 | 用途 |
|------|------|
| [TypeScript](https://www.typescriptlang.org/) | 类型安全的 JavaScript |
| [OpenCode SDK v2](https://github.com/opencode-ai/sdk) | AI Agent 通信 |
| [@pinixai/weixin-bot](https://www.npmjs.com/package/@pinixai/weixin-bot) | 微信 iLink 协议客户端 |
| [@larksuiteoapi/node-sdk](https://www.npmjs.com/package/@larksuiteoapi/node-sdk) | 飞书机器人 SDK |
| [Vitest](https://vitest.dev/) | 单元测试框架 |

---

## 📄 许可证 / License

[Apache 2.0](./LICENSE) © 2025