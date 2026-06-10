# Claude Code 支持方案

## Context

当前项目 `wechat-agent-bridge` 是微信个人号 ↔ OpenCode AI 编程助手的桥接服务。用户通过微信发送消息，桥接层将消息转发给 OpenCode SDK 后端，AI 处理后返回结果。

现在需要增加 **Claude Code** 作为第二个 AI 后端选项，让用户可以选择使用 Claude Code 而非 OpenCode。

---

## 核心设计：抽象 AIService 接口 + 双后端实现

### 现状分析

当前架构中，`OpenCodeService` 接口（`src/opencode/client.ts:69-101`）定义了完整的服务契约。Bridge Orchestrator（`src/bridge/orchestrator.ts`）直接依赖这个接口。我们需要：

1. 将 `OpenCodeService` 升级为通用 `AIService` 接口
2. OpenCode 实现改为 `OpenCodeService`（适配该接口）
3. 新增 `ClaudeCodeService`（适配同一接口）

### Claude Code 集成方式选择

经过调研，Claude Code 的集成有以下选项：

| 方案 | 说明 |
|------|------|
| `@anthropic-ai/claude-agent-sdk` | 官方 SDK，有 `query()`/`queryStream()` API |
| CLI subprocess (`claude --print`) | 社区主流做法，`claude-code-node`、`@palon7/cc-client` 都基于此 |

**推荐方案：CLI subprocess 模式**，理由：
- Claude Code CLI (`@anthropic-ai/claude-code`) 本身就是 Node.js 包，安装后可直接 `npx claude`
- `--print` 模式支持 headless 非交互式调用
- `--output-format stream-json` 支持结构化流式输出
- 社区已验证的成熟模式（`claude-code-node` 有 39 个测试用例）
- 不需要额外的 SDK 依赖

---

## 实施步骤

### Step 1: 提取通用 AIService 接口

**文件**: `src/ai/service.ts` (新建)

将 `OpenCodeService` 接口中的方法提取为通用 `AIService` 接口。关键方法：

```typescript
export interface AIService {
  // 会话管理
  ensureSession(wechatUserId: string): Promise<string>;
  newSession(wechatUserId: string): Promise<string>;
  switchSession(wechatUserId: string, index: number): boolean;
  listSessions(wechatUserId: string): SessionEntry | null;

  // 核心对话
  sendPrompt(wechatUserId: string, text: string): Promise<PromptResult>;
  sendPromptAsync(wechatUserId: string, text: string): Promise<void>;
  abort(wechatUserId: string): Promise<void>;

  // 撤销/重做
  undo(wechatUserId: string): Promise<string>;
  redo(wechatUserId: string): Promise<string>;

  // 模型 & Agent
  listModels(): Promise<ModelInfo[]>;
  setModel(wechatUserId: string, model: string): void;
  setSystem(wechatUserId: string, system: string): void;
  setAgent(wechatUserId: string, agent: string): void;
  getDefaultAgent(): string | undefined;

  // 工作目录
  setWorkDir(wechatUserId: string, workDir: string): void;

  // 文件操作
  listFiles(wechatUserId: string, dirPath?: string): Promise<FileEntry[]>;
  readFile(wechatUserId: string, filePath: string): Promise<FileContentResult>;
  findFiles(wechatUserId: string, query: string): Promise<FindResult>;
  grepFiles(wechatUserId: string, pattern: string): Promise<FindResult>;

  // Git
  getDiff(wechatUserId: string): Promise<DiffResult>;
  listWorktrees(): Promise<WorktreeEntry[]>;

  // 其他
  listMessages(wechatUserId: string, limit?: number): Promise<SessionMessage[]>;
  summarize(wechatUserId: string): Promise<string>;
  listTodos(wechatUserId: string): Promise<TodoItem[]>;

  // 生命周期
  isHealthy(): Promise<boolean>;
  shutdown(): void;
}
```

同时将共享类型（`ModelInfo`, `PromptResult`, `FileEntry` 等）提取到 `src/ai/types.ts`。

### Step 2: 重构 OpenCode 实现

**文件**: `src/opencode/client.ts` → 实现 `AIService` 接口

改动最小化：
- import `AIService` 接口
- `createOpenCodeService` 返回类型改为 `Promise<AIService>`
- 内部实现不变

### Step 3: 实现 ClaudeCodeService

**文件**: `src/claude-code/client.ts` (新建)

使用 `child_process.spawn` 调用 `claude` CLI：

**核心流程**:
```
用户发消息 → ensureSession → spawn('claude', ['--print', '--output-format', 'stream-json', ...])
           → 通过 stdin 写入 prompt
           → 从 stdout 解析 NDJSON 事件流
           → 聚合 text 事件为最终响应
           → 返回 PromptResult
```

**CLI 参数设计**:
```
claude --print \
  --output-format stream-json \
  --max-turns 30 \
  --permission-mode acceptEdits \
  --allowedTools "Read,Write,Edit,Bash(search),Glob,Grep" \
  --model <model> \
  --system-prompt <system> \
  --prompt <user text>
```

**会话管理**:
- Claude Code 本身支持 session resume (`claude -r <sessionId>`)
- 但 subprocess 模式下，每次 `spawn` 是独立进程
- 方案：通过 `--continue` 标志 + 上次 session ID 恢复对话
- 或者维护长连接 subprocess（一个 WeChat 用户 = 一个 claude 进程池）
- **推荐**: 对于 MVP，每次请求独立 `spawn`（类似 OpenCode 的 stateless HTTP 调用模式），通过 `--resume <sessionId>` 传递上下文

**健康检查**: 
- 检查 `claude --version` 是否可执行
- 检查 `ANTHROPIC_API_KEY` 环境变量是否设置

### Step 4: 扩展配置

**文件**: `src/config.ts`

添加 Claude Code 配置项：

```typescript
export const config = {
  // ... existing ...
  ai: {
    backend: env("AI_BACKEND", "opencode"),  // "opencode" | "claude-code"
    claudeCode: {
      apiKey: process.env["ANTHROPIC_API_KEY"],
      model: env("CLAUDE_MODEL", "claude-sonnet-4-6"),
      maxTurns: envInt("CLAUDE_MAX_TURNS", 30),
      permissionMode: env("CLAUDE_PERMISSION_MODE", "acceptEdits"),
    },
  },
  // ... existing opencode, wechat, store, log ...
};
```

### Step 5: 更新 Orchestrator 和入口

**文件**: `src/bridge/orchestrator.ts`
- `BridgeOptions` 中的 `opencode: OpenCodeService` → `ai: AIService`
- 所有 `opencode.xxx()` 调用 → `ai.xxx()`

**文件**: `src/index.ts`
- 根据 `config.ai.backend` 创建对应的 service
- `opencode` → `createOpenCodeService(store)`
- `claude-code` → `createClaudeCodeService(store)`

---

## 文件变更清单

| 操作 | 文件 | 说明 |
|------|------|------|
| **新建** | `src/ai/types.ts` | 共享类型定义 |
| **新建** | `src/ai/service.ts` | AIService 接口 |
| **新建** | `src/claude-code/client.ts` | Claude Code 后端实现（~300行） |
| **修改** | `src/opencode/client.ts` | 实现 AIService 接口 |
| **修改** | `src/config.ts` | 添加 ai.backend 和 claudeCode 配置 |
| **修改** | `src/bridge/orchestrator.ts` | 使用 AIService 替代 OpenCodeService |
| **修改** | `src/index.ts` | 按配置选择后端 |
| **修改** | `package.json` | 无需新增依赖（使用系统 claude CLI） |

---

## 注意事项

1. **Claude Code CLI 依赖**: 用户需要预先安装 `npm install -g @anthropic-ai/claude-code`，设置 `ANTHROPIC_API_KEY`
2. **资源开销**: Claude Code subprocess 每次调用启动新进程（~200-500ms 冷启动），相比 OpenCode SDK 的 HTTP 调用略慢
3. **功能差异**: Claude Code 的部分功能（如 worktree、todo list）CLI 不直接支持，需要在 `ClaudeCodeService` 中通过 Node.js 原生实现或返回"不支持"的友好提示
4. **向后兼容**: 默认 `AI_BACKEND=opencode`，现有用户无需任何改动

---

## 验证方法

1. 设置 `AI_BACKEND=claude-code` 和 `ANTHROPIC_API_KEY`
2. 启动桥接服务 `npm run dev`
3. 微信发送消息，确认能收到 Claude Code 的回复
4. 测试 `/new`, `/models`, `/cd`, `/ls`, `/cat`, `/diff` 等命令
5. 切回 `AI_BACKEND=opencode` 确认原有功能不受影响
