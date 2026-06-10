<div align="center">

<img src="https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square" alt="License">
<img src="https://img.shields.io/badge/node-%3E%3D20.0-green?style=flat-square&logo=node.js" alt="Node">
<img src="https://img.shields.io/badge/typescript-5.7-blue?style=flat-square&logo=typescript" alt="TypeScript">
<img src="https://img.shields.io/badge/prs-welcome-brightgreen?style=flat-square" alt="PRs Welcome">

</div>

# wechat-agent-bridge

> Bridge your personal WeChat to AI coding assistants — chat with OpenCode (and soon Claude Code) directly from WeChat.

```
 👤 WeChat Message  →  🌉 Bridge  →  🤖 AI Agent  →  📲 WeChat Response
```

## ✨ Features

- **WeChat-native** — send messages, approve/deny actions, manage sessions, all inside WeChat
- **Multi-session** — each WeChat user gets independent AI sessions, switch between them freely
- **Auto-recovery** — exponential backoff retry, health monitoring, and automatic reconnection
- **Zero-config login** — scan QR code once, token cached for subsequent launches
- **PM2-ready** — production-grade process management with auto-restart
- **Extensible** — abstracted AI backend interface, ready for multi-provider support

## 📦 Architecture

```
WeChat User  ←→  iLink (ilinkai.weixin.qq.com)
                         │
                  @pinixai/weixin-bot
                         │
              bridge/orchestrator  ← command parsing + formatting
                         │
                  @opencode-ai/sdk
                         │
                     OpenCode AI
```

## 🚀 Quick Start

### Prerequisites

- **Node.js** >= 20
- **OpenCode CLI** installed and available in PATH

### Setup

```bash
git clone https://github.com/your-username/wechat-agent-bridge.git
cd wechat-agent-bridge

# install dependencies
npm install

# configure environment (optional — defaults are sensible)
cp .env.example .env

# build
npm run build
```

### Run

```bash
npm run dev         # foreground, with hot reload
npm run pm2:start   # background, managed by PM2 (recommended for production)
```

On first launch, a QR code URL is printed — scan it with WeChat to log in. Tokens are cached under `data/wechat/`, so subsequent launches skip the scan.

Send `/status` in WeChat to verify the bridge is connected and healthy.

## 🎮 Commands

### Sessions

| Command | Description |
|---------|-------------|
| `/new` | Start a new AI session |
| `/sessions` | List all active sessions |
| `/session <n>` | Switch to session `n` |
| `/undo` | Undo the last operation |
| `/redo` | Redo a previously undone operation |
| `/abort` | Cancel the current in-progress task |

### Models

| Command | Description |
|---------|-------------|
| `/models` | List available AI models |
| `/model` | Show the currently selected model |
| `/model <n>` | Switch to model `n` |

### Files & Navigation

| Command | Description |
|---------|-------------|
| `/cd <path>` | Change the working directory on the host |
| `/send <path>` | Send a local file from the host to WeChat |

### Control

| Command | Description |
|---------|-------------|
| `/approve` `/a` | Approve a pending operation |
| `/deny` `/d` | Deny a pending operation |
| `/status` | Show bridge and connection status |
| `/help` `/h` | Show this help message |

Anything else you type is forwarded directly to the AI as a conversation message.

## 🔄 Connection Recovery

The bridge includes multiple layers of resilience — **no manual intervention needed**:

- **API Retry** — all OpenCode calls retry with exponential backoff (1s → 2s → 4s → … → 30s)
- **Health Monitoring** — heartbeat every 30s; 3 consecutive failures trigger automatic recovery
- **Auto-Reconnect** — crashed AI processes are restarted with increasing intervals (5s → 10s → 20s → … → 5min max), never giving up
- **Message Queuing** — WeChat messages are queued during reconnection and processed once recovered

This works regardless of how you launch: `npm run dev`, `node dist/index.js`, or PM2. PM2 adds an extra layer of process-level supervision for double protection.

## ⚙️ Configuration

Configuration is loaded from environment variables (via `.env` or the system environment).

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCODE_HOST` | `127.0.0.1` | OpenCode server host |
| `OPENCODE_PORT` | `4096` | OpenCode server port |
| `OPENCODE_MODEL` | — | Default model, e.g. `anthropic/claude-sonnet-4` |
| `WECHAT_DATA_DIR` | `./data/wechat` | WeChat credential storage path |
| `SESSION_STORE_PATH` | `./data/sessions.json` | Session persistence file |
| `LOG_LEVEL` | `info` | Logging level |

## 🚢 Deployment

### Personal Machine / Dev Server

```bash
git clone https://github.com/your-username/wechat-agent-bridge.git
cd wechat-agent-bridge
npm install
cp .env.example .env   # edit as needed
npm run build
npm run pm2:start
```

### Persist Across Reboots

```bash
npx pm2 save        # snapshot the current process list
npx pm2 startup     # generate a startup script (follow the printed instructions)
```

### Verify

```bash
npm run pm2:status   # should show "online"
npm run pm2:logs     # confirm no startup errors
```

### Update

```bash
git pull
npm install           # if new dependencies were added
npm run build
npm run pm2:restart
```

## 🧪 Development

```bash
npm test              # run all tests
npm run test:watch    # watch mode
```

## 🛠 Tech Stack

- **[TypeScript](https://www.typescriptlang.org/)** — type-safe JavaScript
- **[OpenCode SDK](https://github.com/opencode-ai/sdk)** — AI agent communication
- **[@pinixai/weixin-bot](https://www.npmjs.com/package/@pinixai/weixin-bot)** — WeChat iLink protocol client
- **[PM2](https://pm2.keymetrics.io/)** — production process manager
- **[Vitest](https://vitest.dev/)** — unit testing framework

## 📄 License

[Apache 2.0](./LICENSE) © 2025
