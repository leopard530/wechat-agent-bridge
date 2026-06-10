import type { IncomingMessage } from "@pinixai/weixin-bot";
import type { WeChatService } from "../wechat/bot.js";
import type { OpenCodeService, ModelInfo } from "../opencode/client.js";
import type { SessionStore } from "../store/session-store.js";
import { config } from "../config.js";
import { formatForWechat, extractLargeCodeBlocks } from "./formatter.js";
import { stat, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

export interface BridgeOptions {
  wechat: WeChatService;
  opencode: OpenCodeService;
  store: SessionStore;
}

/** Cached model list so we don't fetch on every command. */
let modelCache: ModelInfo[] | null = null;

async function getModels(opencode: OpenCodeService): Promise<ModelInfo[]> {
  if (!modelCache) {
    modelCache = await opencode.listModels();
  }
  return modelCache;
}

/**
 * Connects WeChat message flow to OpenCode prompt-response cycle.
 */
export async function startBridge(options: BridgeOptions): Promise<void> {
  const { wechat, opencode, store } = options;

  // Track which users are currently being processed (prevent concurrent runs)
  const active = new Set<string>();

  // Track users who are awaiting an approval decision
  const awaitingApproval = new Set<string>();

  wechat.onMessage(async (msg: IncomingMessage) => {
    // Ignore empty messages
    let text = msg.text?.trim();
    if (!text) return;

    const userId = msg.userId;

    // ── /help, /h — show available commands ──
    if (text === "/help" || text === "/h") {
      await wechat.reply(msg, [
        "━━ 会话管理 ━━",
        "/new — 创建新会话",
        "/sessions — 列出所有会话",
        "/messages [N] — 查看最近 N 条对话",
        "/session <编号> — 切换会话",
        "/undo — 撤销上一步操作",
        "/redo — 重做已撤销操作",
        "/summarize — AI 压缩会话",
        "━━ 模型 / Agent ━━",
        "/models — 列出可用模型",
        "/model — 查看当前模型",
        "/model <编号> — 切换模型",
        "/agent [名称] — 查看/切换 agent",
        "/system [提示词] — 查看/设置系统提示",
        "━━ 文件浏览 (v2) ━━",
        "/ls [路径] — 列出目录文件",
        "/cat <路径> — 查看文件内容",
        "/find <模式> — 按名称搜索文件",
        "/grep <正则> — 搜索文件内容",
        "━━ 目录 / Git ━━",
        "/cd <路径> — 切换工作目录",
        "/diff — 查看 git diff",
        "/worktree — 查看 git worktree",
        "/send <路径> — 发送文件到微信",
        "━━ 其他 ━━",
        "/help, /h — 显示帮助",
        "/abort — 中断当前任务",
        "/todo — 查看当前任务列表",
        "/task <文本> — 异步大任务",
        "/approve, /a — 批准操作",
        "/deny, /d — 拒绝操作",
        "/status — 查看运行状态",
        "━━",
        "直接发送文字即为 OpenCode 对话。",
      ].join("\n\n"));
      return;
    }

    // ── /status — health check ──
    if (text === "/status") {
      const lines: string[] = [];
      lines.push("━━ Bridge 状态 ━━");
      lines.push("");
      lines.push(`进程: ✅ 运行中`);

      // User session count
      const entry = store.getEntry(userId);
      const sessionCount = entry?.sessions.length ?? 0;
      lines.push(`你的会话: ${sessionCount} 个`);
      if (entry) {
        lines.push(`工作目录: ${entry.workDir}`);
        lines.push(`模型: ${entry.model ?? "(默认)"}`);
        if (entry.system) lines.push(`系统提示: ${entry.system.slice(0, 50)}...`);
        if (entry.agent) lines.push(`Agent: ${entry.agent}`);
      }

      // OpenCode connectivity
      lines.push("");
      try {
        const models = await getModels(opencode);
        lines.push(`OpenCode: ✅ 已连接 (${models.length} 个模型)`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "未知错误";
        lines.push(`OpenCode: ❌ 无法连接 — ${errMsg}`);
      }

      await wechat.reply(msg, lines.join("\n"));
      return;
    }

    // ── /abort — interrupt the currently running task ──
    // Must be BEFORE the active guard so users can always abort.
    if (text === "/abort") {
      try {
        await opencode.abort(userId);
        await wechat.reply(msg, "✅ 已中断当前任务");
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "未知错误";
        await wechat.reply(msg, `❌ 中断失败: ${errMsg}`);
      }
      // Always remove from active set so user can continue
      active.delete(userId);
      awaitingApproval.delete(userId);
      return;
    }

    // ── /undo — revert last tool action ──
    if (text === "/undo") {
      try {
        const msg2 = await opencode.undo(userId);
        await wechat.reply(msg, msg2);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "未知错误";
        await wechat.reply(msg, `❌ 撤销失败: ${errMsg}`);
      }
      return;
    }

    // ── /redo — redo last undone action ──
    if (text === "/redo") {
      try {
        const msg2 = await opencode.redo(userId);
        await wechat.reply(msg, msg2);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "未知错误";
        await wechat.reply(msg, `❌ 重做失败: ${errMsg}`);
      }
      return;
    }

    // ── /approve, /deny — explicit approval commands ──
    if (text === "/approve" || text === "/a") {
      awaitingApproval.delete(userId);
      await wechat.reply(msg, "⏳ 正在发送批准...");
      // Fall through to send "approve" as a prompt
      // (OpenCode interprets it in conversation context)
      text = "approve";
    } else if (text === "/deny" || text === "/d") {
      awaitingApproval.delete(userId);
      await wechat.reply(msg, "⏳ 正在发送拒绝...");
      text = "deny";
    }

    // ── /cd <path> — switch working directory ──
    if (text.startsWith("/cd ")) {
      const dir = text.slice(4).trim();
      if (!dir) {
        await wechat.reply(msg, "用法: /cd <路径>\n例如: /cd D:\\workspace\\my-project");
        return;
      }
      // Validate path exists and is a directory
      try {
        const pathStat = await stat(dir);
        if (!pathStat.isDirectory()) {
          await wechat.reply(msg, `❌ 不是目录:\n${dir}`);
          return;
        }
      } catch {
        await wechat.reply(msg, `❌ 路径不存在:\n${dir}`);
        return;
      }
      opencode.setWorkDir(userId, dir);
      await wechat.reply(msg, `✅ 工作目录已切换为:\n${dir}`);
      return;
    }

    // ── /new — create a new session ──
    if (text === "/new") {
      await opencode.newSession(userId);
      const sessions = store.getEntry(userId)!;
      await wechat.reply(msg, `✅ 已创建新会话 (共 ${sessions.sessions.length} 个)`);
      return;
    }

    // ── /sessions — list all sessions ──
    if (text === "/sessions") {
      const entry = store.getEntry(userId);
      if (!entry || entry.sessions.length === 0) {
        await wechat.reply(msg, "暂无会话记录，发送第一条消息自动创建");
        return;
      }
      const lines = entry.sessions.map((s, i) => {
        const marker = i === entry.activeIndex ? " ✅" : "";
        return `${i + 1}. ${s.title}${marker}`;
      });
      await wechat.reply(msg, `会话列表:\n\n${lines.join("\n")}\n\n切换: /session <编号>`);
      return;
    }

    // ── /messages [N] — view recent session messages ──
    if (text === "/messages" || text.startsWith("/messages ")) {
      const limitArg = text.slice(10).trim();
      const limit = limitArg ? parseInt(limitArg, 10) : 10;
      if (Number.isNaN(limit) || limit < 1 || limit > 50) {
        await wechat.reply(msg, "用法: /messages [1-50]\n默认显示最近 10 条");
        return;
      }
      try {
        const msgs = await opencode.listMessages(userId, limit);
        if (msgs.length === 0) {
          await wechat.reply(msg, "暂无对话记录");
          return;
        }
        const lines = msgs.map((m) => {
          const icon = m.role === "user" ? "👤" : "🤖";
          const time = new Date(m.time).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
          return `${icon} [${time}] ${m.text}`;
        });
        await wechat.reply(msg, `📜 最近 ${msgs.length} 条对话:\n\n${lines.join("\n\n")}`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "未知错误";
        await wechat.reply(msg, `❌ /messages 失败: ${errMsg}`);
      }
      return;
    }

    // ── /session <n> — switch active session ──
    if (text.startsWith("/session ")) {
      const idx = parseInt(text.slice(9).trim(), 10);
      if (Number.isNaN(idx)) {
        await wechat.reply(msg, "用法: /session <编号>\n输入 /sessions 查看列表");
        return;
      }
      const ok = opencode.switchSession(userId, idx - 1);
      if (ok) {
        await wechat.reply(msg, `✅ 已切换到会话 ${idx}`);
      } else {
        await wechat.reply(msg, `❌ 编号超出范围，输入 /sessions 查看列表`);
      }
      return;
    }

    // ── /models — list available models ──
    if (text === "/models" || text.startsWith("/models ")) {
      // force refresh if any arg is passed
      if (text !== "/models") modelCache = null;

      const models = await getModels(opencode);
      if (models.length === 0) {
        await wechat.reply(msg, "❌ 未获取到可用模型，请检查 OpenCode 配置");
        return;
      }

      const current = store.getModel(userId);
      const lines = models.map((m, i) => {
        const marker = m.key === current ? " ✅" : "";
        return `${i + 1}. ${m.label}  (${m.key})${marker}`;
      });
      await wechat.reply(msg, `可用模型:\n\n${lines.join("\n")}\n\n切换: /model <编号>\n如: /model 1`);
      return;
    }

    // ── /model — switch or show current model ──
    if (text === "/model") {
      const current = store.getModel(userId) ?? config.opencode.model;
      const agent = store.getAgent(userId) ?? opencode.getDefaultAgent();
      if (current) {
        await wechat.reply(msg, `当前模型: ${current}\n切换: /model <编号>\n如: /model 1`);
      } else if (agent) {
        await wechat.reply(msg, `当前模型: 由 Agent "${agent}" 决定\n手动指定: /model <编号>\n如: /model 1`);
      } else {
        await wechat.reply(msg, `当前模型: (OpenCode 默认)\n手动指定: /model <编号>\n如: /model 1`);
      }
      return;
    }

    if (text.startsWith("/model ")) {
      const arg = text.slice(7).trim();

      // Try numeric selection from cached list
      const idx = parseInt(arg, 10);
      if (!Number.isNaN(idx)) {
        const models = await getModels(opencode);
        if (idx < 1 || idx > models.length) {
          await wechat.reply(msg, `❌ 编号超出范围 (1-${models.length})，输入 /models 查看列表`);
          return;
        }
        const selected = models[idx - 1].key;
        opencode.setModel(userId, selected);
        await wechat.reply(msg, `✅ 模型已切换为:\n${selected}`);
        return;
      }

      // Fallback: full "provider/model" string
      if (arg.indexOf("/") === -1 || arg.split("/").length !== 2) {
        await wechat.reply(
          msg,
          "用法: /model <编号> 或 /model <provider/model>\n输入 /models 查看可用列表",
        );
        return;
      }

      opencode.setModel(userId, arg);
      await wechat.reply(msg, `✅ 模型已切换为:\n${arg}`);
      return;
    }

    // ── /send <path> — send a local file to WeChat ──
    if (text.startsWith("/send ")) {
      const filePath = text.slice(6).trim();
      if (!filePath) {
        await wechat.reply(msg, "用法: /send <文件路径>");
        return;
      }

      // Prevent concurrent runs
      if (active.has(userId)) {
        await wechat.reply(msg, "⏳ 上一条任务还在执行中，请稍候...");
        return;
      }
      active.add(userId);

      try {
        await wechat.sendTyping(userId);
        await wechat.sendFile(userId, filePath);
        await wechat.stopTyping(userId);
      } catch (err) {
        await wechat.stopTyping(userId).catch(() => {});
        const errMsg = err instanceof Error ? err.message : "未知错误";
        await wechat.reply(msg, `❌ 发送失败: ${errMsg}`);
      } finally {
        active.delete(userId);
      }
      return;
    }

    // Auto-detect: pure number from user awaiting approval
    if (awaitingApproval.has(userId) && /^\d+$/.test(text)) {
      awaitingApproval.delete(userId);
      const num = parseInt(text, 10);
      await wechat.reply(msg, `⏳ 正在发送选项 ${num}...`);
      // Fall through to send it as a prompt on the same session
      // (OpenCode will interpret it in conversation context)
    } else if (awaitingApproval.has(userId)) {
      // User sent non-number — clear pending approval, treat as new prompt
      awaitingApproval.delete(userId);
    }

    // ── /ls [path] — list files in a directory ──
    if (text === "/ls" || text.startsWith("/ls ")) {
      const dirPath = text.slice(4).trim() || ".";
      try {
        const entries = await opencode.listFiles(userId, dirPath);
        if (entries.length === 0) {
          await wechat.reply(msg, `📂 ${dirPath}\n\n(空目录)`);
          return;
        }
        const maxShow = 50;
        const shown = entries.slice(0, maxShow);
        const lines = shown.map((e) => {
          const icon = e.type === "directory" ? "📁" : "📄";
          return `${icon} ${e.name}`;
        });
        let result = `📂 ${dirPath} (${entries.length} 项):\n\n${lines.join("\n")}`;
        if (entries.length > maxShow) {
          result += `\n\n... 还有 ${entries.length - maxShow} 项`;
        }
        await wechat.reply(msg, result);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "未知错误";
        await wechat.reply(msg, `❌ /ls 失败: ${errMsg}`);
      }
      return;
    }

    // ── /cat <path> — read a file's contents ──
    if (text === "/cat" || text.startsWith("/cat ")) {
      const filePath = text.slice(5).trim();
      if (!filePath) {
        await wechat.reply(msg, "用法: /cat <文件路径>");
        return;
      }
      try {
        const result = await opencode.readFile(userId, filePath);
        const maxLen = 3000;
        const content = result.content.length > maxLen
          ? result.content.slice(0, maxLen) + `\n\n... (截断, 共 ${result.content.length} 字符)`
          : result.content;
        await wechat.reply(msg, `📄 ${filePath}:\n\n${content}`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "未知错误";
        await wechat.reply(msg, `❌ /cat 失败: ${errMsg}`);
      }
      return;
    }

    // ── /find <query> — find files by name ──
    if (text === "/find" || text.startsWith("/find ")) {
      const query = text.slice(6).trim();
      if (!query) {
        await wechat.reply(msg, "用法: /find <搜索模式>\n例如: /find *.ts");
        return;
      }
      try {
        const result = await opencode.findFiles(userId, query);
        if (result.files.length === 0) {
          await wechat.reply(msg, `🔍 未找到匹配 "${query}" 的文件`);
          return;
        }
        const maxShow = 30;
        const shown = result.files.slice(0, maxShow);
        let reply = `🔍 找到 ${result.files.length} 个文件:\n\n${shown.join("\n")}`;
        if (result.files.length > maxShow) {
          reply += `\n\n... 还有 ${result.files.length - maxShow} 个`;
        }
        await wechat.reply(msg, reply);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "未知错误";
        await wechat.reply(msg, `❌ /find 失败: ${errMsg}`);
      }
      return;
    }

    // ── /grep <pattern> — search file contents ──
    if (text === "/grep" || text.startsWith("/grep ")) {
      const pattern = text.slice(6).trim();
      if (!pattern) {
        await wechat.reply(msg, "用法: /grep <正则表达式>\n例如: /grep TODO");
        return;
      }
      try {
        const result = await opencode.grepFiles(userId, pattern);
        if (result.files.length === 0) {
          await wechat.reply(msg, `🔍 未找到匹配 "${pattern}" 的内容`);
          return;
        }
        const maxShow = 20;
        const shown = result.files.slice(0, maxShow);
        let reply = `🔍 找到 ${result.files.length} 处匹配:\n\n${shown.join("\n")}`;
        if (result.files.length > maxShow) {
          reply += `\n\n... 还有 ${result.files.length - maxShow} 处`;
        }
        await wechat.reply(msg, reply);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "未知错误";
        await wechat.reply(msg, `❌ /grep 失败: ${errMsg}`);
      }
      return;
    }

    // ── /diff — show git diff ──
    if (text === "/diff") {
      try {
        const result = await opencode.getDiff(userId);
        const maxLen = 2500;
        const diff = result.diff.length > maxLen
          ? result.diff.slice(0, maxLen) + "\n\n... (截断)"
          : result.diff;
        await wechat.reply(msg, diff || "(无变更)");
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "未知错误";
        await wechat.reply(msg, `❌ /diff 失败: ${errMsg}`);
      }
      return;
    }

    // ── /worktree — list git worktrees ──
    if (text === "/worktree") {
      try {
        const worktrees = await opencode.listWorktrees();
        if (worktrees.length === 0) {
          await wechat.reply(msg, "📂 无 worktree");
          return;
        }
        const lines = worktrees.map((w) => {
          const marker = w.isCurrent ? " ✅" : "";
          return `${marker} ${w.branch}\n   ${w.path}`;
        });
        await wechat.reply(msg, `🌿 Worktrees (${worktrees.length}):\n\n${lines.join("\n\n")}`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "未知错误";
        await wechat.reply(msg, `❌ /worktree 失败: ${errMsg}`);
      }
      return;
    }

    // ── /system [text] — view or set system prompt ──
    if (text === "/system") {
      const current = store.getSystem(userId);
      if (current) {
        await wechat.reply(msg, `🧠 当前系统提示:\n\n${current}\n\n清除: /system clear`);
      } else {
        await wechat.reply(msg, "🧠 未设置系统提示\n设置: /system <提示词>\n清除: /system clear");
      }
      return;
    }
    if (text.startsWith("/system ")) {
      const arg = text.slice(8).trim();
      if (arg === "clear") {
        opencode.setSystem(userId, "");
        await wechat.reply(msg, "✅ 已清除系统提示");
      } else {
        opencode.setSystem(userId, arg);
        await wechat.reply(msg, `✅ 系统提示已设置 (${arg.length} 字)`);
      }
      return;
    }

    // ── /agent [name] — view or set agent ──
    if (text === "/agent") {
      const current = store.getAgent(userId) ?? opencode.getDefaultAgent();
      if (current) {
        await wechat.reply(msg, `🤖 当前 Agent: ${current}\n\n清除: /agent clear`);
      } else {
        await wechat.reply(msg, "🤖 未指定 Agent (使用 OpenCode 默认)\n设置: /agent <名称>\n如: /agent sisyphus");
      }
      return;
    }
    if (text.startsWith("/agent ")) {
      const arg = text.slice(7).trim();
      if (arg === "clear") {
        opencode.setAgent(userId, "");
        await wechat.reply(msg, "✅ 已恢复默认 Agent");
      } else {
        opencode.setAgent(userId, arg);
        await wechat.reply(msg, `✅ Agent 已设置为: ${arg}`);
      }
      return;
    }

    // ── /summarize — AI-compact the current session ──
    if (text === "/summarize") {
      try {
        const result = await opencode.summarize(userId);
        await wechat.reply(msg, result);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "未知错误";
        await wechat.reply(msg, `❌ 压缩失败: ${errMsg}`);
      }
      return;
    }

    // ── /todo — list current session todos ──
    if (text === "/todo") {
      try {
        const todos = await opencode.listTodos(userId);
        if (todos.length === 0) {
          await wechat.reply(msg, "📋 暂无任务");
          return;
        }
        const icons: Record<string, string> = { pending: "⏳", in_progress: "🔄", completed: "✅", cancelled: "❌" };
        const lines = todos.map((t) => {
          const icon = icons[t.status] ?? "❓";
          return `${icon} ${t.content}`;
        });
        await wechat.reply(msg, `📋 任务列表 (${todos.length}):\n\n${lines.join("\n")}`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "未知错误";
        await wechat.reply(msg, `❌ /todo 失败: ${errMsg}`);
      }
      return;
    }

    // ── /task <text> — async prompt (fire and forget) ──
    if (text === "/task" || text.startsWith("/task ")) {
      const taskText = text.slice(6).trim();
      if (!taskText) {
        await wechat.reply(msg, "用法: /task <任务描述>\n异步执行大任务，完成后结果会自动返回");
        return;
      }
      try {
        await opencode.sendPromptAsync(userId, taskText);
        await wechat.reply(msg, "🚀 任务已提交 (异步执行中)");
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "未知错误";
        await wechat.reply(msg, `❌ 提交失败: ${errMsg}`);
      }
      return;
    }

    // ── Catch-all: unknown /slash command ──
    if (text.startsWith("/")) {
      await wechat.reply(
        msg,
        `❌ 未知命令: ${text.split(/\s+/)[0]}\n\n输入 /help 查看可用命令。`,
      );
      return;
    }

    // Prevent concurrent runs for same user
    if (active.has(userId)) {
      await wechat.reply(msg, "⏳ 上一条任务还在执行中，请稍候...");
      return;
    }

    active.add(userId);

    try {
      console.log(
        `[bridge] ${userId.slice(0, 12)}...: ${text.slice(0, 100)}`,
      );

      // Show typing indicator
      await wechat.sendTyping(userId);

      // Send to OpenCode
      const result = await opencode.sendPrompt(userId, text);

      // Stop typing
      await wechat.stopTyping(userId);

      // Format for WeChat display
      const formatted = formatForWechat(result.text);

      // Extract large code blocks → send as files
      const { text: cleanText, files: codeFiles } = extractLargeCodeBlocks(formatted);

      // Reply with the text (code blocks replaced with placeholders)
      await wechat.reply(msg, cleanText);

      // Send extracted code blocks as file attachments
      for (const cf of codeFiles) {
        const tmpDir = join(tmpdir(), "wechat-bridge");
        await mkdir(tmpDir, { recursive: true });
        const tmpPath = join(tmpDir, `${randomUUID()}-${cf.filename}`);
        try {
          await writeFile(tmpPath, cf.content, "utf-8");
          await wechat.sendFile(userId, tmpPath, cf.filename);
          await rm(tmpPath, { force: true });
        } catch (err) {
          console.warn(`[bridge] Failed to send code file ${cf.filename}:`, err);
          await rm(tmpPath, { force: true }).catch(() => {});
        }
      }

      // Send any files OpenCode created/modified
      for (const file of result.files) {
        try {
          await wechat.sendFile(userId, file.path, file.label);
          console.log(`[bridge] Sent file to ${userId.slice(0, 12)}...: ${file.path}`);
        } catch (err) {
          console.warn(`[bridge] Failed to send file ${file.path}:`, err);
          await wechat.reply(msg, `⚠️ 文件发送失败: ${file.label}`);
        }
      }

      // Detect if this response asks for tool approval — set await state
      if (detectApprovalRequest(cleanText)) {
        awaitingApproval.add(userId);
        await wechat.reply(
          msg,
          "💡 回复数字选择，或 /approve /deny",
        );
      }

      console.log(
        `[bridge] Replied to ${userId.slice(0, 12)}... (${cleanText.length} chars, ${codeFiles.length} code files, ${result.files.length} output files)`,
      );
    } catch (err) {
      console.error(`[bridge] Error for ${userId.slice(0, 12)}...:`, err);

      await wechat.stopTyping(userId).catch(() => {});

      const errorMsg =
        err instanceof Error ? err.message : "未知错误";
      await wechat
        .reply(msg, `❌ 出错了: ${errorMsg}`)
        .catch(() => {});
    } finally {
      active.delete(userId);
    }
  });

  // Handle shutdown signals
  const shutdown = () => {
    console.log("[bridge] Shutting down...");
    wechat.stop();
    opencode.shutdown();
    void store.flush().then(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * Heuristic to detect if an OpenCode response is asking for tool approval.
 * Looks for common patterns in tool permission / confirmation dialogs.
 */
export function detectApprovalRequest(text: string): boolean {
  // OpenCode tool permission requests often end with confirmation
  const approvalPatterns = [
    /(?:批准|同意|允许|确认|继续|拒绝|取消).*[?？]/,
    /[?？].*(?:批准|同意|允许|确认|继续|拒绝)/,
    /(?:approve|confirm|proceed|allow|accept|yes|no|deny|reject)\s*\?/i,
    /(?:should|would you like|may)\s+I\b.*\?/i,
    /want\s+me\s+to\b.*\?/i,
    /\b(?:run|execute|write|create|modify|delete|install)\b.*\?/i,
    /\([^)]*[yY]\/[nN][^)]*\)/,  // (y/n) pattern
  ];

  // Numbered option menu heuristic: has 1. and 2. AND approval keywords
  if (/\b1\./.test(text) && /\b2\./.test(text)) {
    for (const kw of ["批准", "同意", "确认", "approve", "confirm", "拒绝", "deny", "取消", "cancel"]) {
      if (text.includes(kw)) return true;
    }
  }

  for (const pattern of approvalPatterns) {
    if (pattern.test(text)) return true;
  }
  return false;
}
