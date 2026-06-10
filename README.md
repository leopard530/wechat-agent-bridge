<div align="center">

<img src="https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square" alt="License">
<img src="https://img.shields.io/badge/node-%3E%3D20.0-green?style=flat-square&logo=node.js" alt="Node">
<img src="https://img.shields.io/badge/typescript-5.7-blue?style=flat-square&logo=typescript" alt="TypeScript">
<img src="https://img.shields.io/badge/prs-welcome-brightgreen?style=flat-square" alt="PRs Welcome">

</div>

# wechat-agent-bridge

> 通过微信直接与 AI 编程助手对话 —— 支持 OpenCode（即将支持 Claude Code）。<br>
> Chat with AI coding assistants directly from WeChat — OpenCode (Claude Code coming soon).

```
 👤 微信消息  →  🌉 Bridge  →  🤖 AI Agent  →  📲 微信回复
```

---

## ✨ 功能亮点 / Features

- **微信原生** — 发消息、批准/拒绝操作、管理会话，全在微信内完成
- **多会话支持** — 每个微信用户可拥有多个独立 AI 会话，自由切换
- **自动容灾** — 指数退避重试、心跳监控、自动重连，无需手动干预
- **扫码即用** — 首次扫码登录后凭据缓存，后续启动免扫码
- **可扩展架构** — 抽象 AI 后端接口，支持多 AI 提供商接入

---

## 📦 架构 / Architecture

```
微信用户  ←→  iLink (ilinkai.weixin.qq.com)
                       │
                @pinixai/weixin-bot
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
npm run dev   # 开发调试，支持热重载
npm start     # 生产运行（需先 npm run build）
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
| `/undo` | 撤销上一步操作 |
| `/redo` | 重做已撤销的操作 |
| `/abort` | 中断当前正在执行的任务 |

### 模型 / Models

| 命令 | 说明 |
|---------|-------------|
| `/models` | 列出可用 AI 模型 |
| `/model` | 查看当前使用的模型 |
| `/model <n>` | 切换到第 n 号模型 |

### 文件与目录 / Files & Navigation

| 命令 | 说明 |
|---------|-------------|
| `/cd <路径>` | 切换主机工作目录 |
| `/send <路径>` | 将主机上的文件发送到微信 |

### 控制 / Control

| 命令 | 说明 |
|---------|-------------|
| `/approve` `/a` | 批准待确认操作 |
| `/deny` `/d` | 拒绝待确认操作 |
| `/status` | 查看 Bridge 和连接状态 |
| `/help` `/h` | 显示此帮助信息 |

直接发送文字内容即为 AI 对话消息。

---

## 🔄 连接恢复 / Connection Recovery

Bridge 内置多层容灾机制，**无需手动干预**：

- **API 重试** — 所有 OpenCode 调用均采用指数退避重试（1s → 2s → 4s → … → 30s）
- **健康监控** — 每 30 秒心跳检测，连续 3 次失败触发自动恢复
- **自动重连** — AI 进程异常退出后自动重拉，间隔逐步增加（5s → 10s → 20s → … → 最多 5 分钟）
- **消息排队** — 重连期间微信消息排队等待，恢复后继续处理

无论是 `npm run dev` 还是 `npm start` 启动，均自动容灾恢复。

---

## ⚙️ 配置 / Configuration

通过环境变量配置（支持 `.env` 文件或系统环境变量）。

| 变量 | 默认值 | 说明 |
|----------|---------|-------------|
| `OPENCODE_HOST` | `127.0.0.1` | OpenCode 服务地址 |
| `OPENCODE_PORT` | `4096` | OpenCode 服务端口 |
| `OPENCODE_MODEL` | — | 默认模型，如 `anthropic/claude-sonnet-4` |
| `WECHAT_DATA_DIR` | `./data/wechat` | 微信凭据存储路径 |
| `SESSION_STORE_PATH` | `./data/sessions.json` | 会话持久化文件 |
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
| [OpenCode SDK](https://github.com/opencode-ai/sdk) | AI Agent 通信 |
| [@pinixai/weixin-bot](https://www.npmjs.com/package/@pinixai/weixin-bot) | 微信 iLink 协议客户端 |
| [Vitest](https://vitest.dev/) | 单元测试框架 |

---

## 📄 许可证 / License

[Apache 2.0](./LICENSE) © 2025
