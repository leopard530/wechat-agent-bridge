import {
  createOpencode,
  type TextPart,
  type ToolPart,
  type PatchPart,
  type FilePart,
  type Part,
  type ToolStateCompleted,
  type AssistantMessage,
  type FileNode,
  type FileContent,
  type VcsFileDiff,
  type Message,
} from "@opencode-ai/sdk/v2";
import type { SessionStore, SessionEntry } from "../store/session-store.js";
import { config } from "../config.js";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";

export interface ModelInfo {
  key: string;
  label: string;
  provider: string;
}

export interface FileOutput {
  path: string;
  label: string;
}

export interface PromptResult {
  text: string;
  files: FileOutput[];
}

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
}

export interface FileContentResult {
  path: string;
  content: string;
}

export interface FindResult {
  files: string[];
}

export interface DiffResult {
  diff: string;
}

export interface WorktreeEntry {
  id: string;
  branch: string;
  path: string;
  isCurrent: boolean;
}

export interface SessionMessage {
  role: "user" | "assistant";
  text: string;
  time: number;
}

export interface OpenCodeService {
  ensureSession(wechatUserId: string): Promise<string>;
  newSession(wechatUserId: string): Promise<string>;
  sendPrompt(wechatUserId: string, text: string): Promise<PromptResult>;
  listModels(): Promise<ModelInfo[]>;
  listSessions(wechatUserId: string): SessionEntry | null;
  switchSession(wechatUserId: string, index: number): boolean;
  setWorkDir(wechatUserId: string, workDir: string): void;
  setModel(wechatUserId: string, model: string): void;
  setSystem(wechatUserId: string, system: string): void;
  setAgent(wechatUserId: string, agent: string): void;
  /** Get the auto-detected default agent (undefined if none). */
  getDefaultAgent(): string | undefined;
  abort(wechatUserId: string): Promise<void>;
  undo(wechatUserId: string): Promise<string>;
  redo(wechatUserId: string): Promise<string>;
  shutdown(): void;
  isHealthy(): Promise<boolean>;

  listFiles(wechatUserId: string, dirPath?: string): Promise<FileEntry[]>;
  readFile(wechatUserId: string, filePath: string): Promise<FileContentResult>;
  findFiles(wechatUserId: string, query: string): Promise<FindResult>;
  grepFiles(wechatUserId: string, pattern: string): Promise<FindResult>;
  getDiff(wechatUserId: string): Promise<DiffResult>;
  listWorktrees(): Promise<WorktreeEntry[]>;
  listMessages(wechatUserId: string, limit?: number): Promise<SessionMessage[]>;
  /** AI-compact a session to summarize. */
  summarize(wechatUserId: string): Promise<string>;
  /** List current todo items from the active session. */
  listTodos(wechatUserId: string): Promise<{ content: string; status: string; priority: string }[]>;
  /** Send a prompt asynchronously (fire and forget). */
  sendPromptAsync(wechatUserId: string, text: string): Promise<void>;
}

// ── Retry utilities ──────────────────────────────────────────────

const RETRY_OPTS = {
  maxRetries: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
};

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  label: string,
  opts: typeof RETRY_OPTS = RETRY_OPTS,
): Promise<T> {
  let lastError: unknown;
  let delay = opts.baseDelayMs;

  for (let attempt = 1; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetryableError(err)) throw err;

      if (attempt < opts.maxRetries) {
        const jitter = Math.random() * delay * 0.3;
        const wait = delay + jitter;
        console.warn(
          `[opencode] ${label} attempt ${attempt}/${opts.maxRetries} — retrying in ${Math.round(wait)}ms:`,
          err instanceof Error ? err.message : String(err),
        );
        await sleep(wait);
        delay = Math.min(delay * 2, opts.maxDelayMs);
      }
    }
  }

  throw lastError;
}

function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError" || err.name === "TimeoutError") return false;

  const msg = err.message.toLowerCase();
  if (msg.includes("econnrefused")) return true;
  if (msg.includes("etimedout")) return true;
  if (msg.includes("enotfound")) return true;
  if (msg.includes("econnreset")) return true;
  if (msg.includes("fetch failed")) return true;
  if (msg.includes("network error")) return true;
  if (msg.includes("socket hang up")) return true;
  if (msg.includes("request timeout")) return true;
  if (msg.includes("500") || msg.includes("502") || msg.includes("503") || msg.includes("504")) return true;
  if (msg.includes("unexpected server error")) return true;
  if (msg.includes("unknownerror")) return true;

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Default agent detection ────────────────────────────────────────

let _detectedDefaultAgent: string | undefined = undefined;
let _agentDetected = false;

function detectDefaultAgent(): string | undefined {
  if (_agentDetected) return _detectedDefaultAgent;
  _agentDetected = true;

  const configDir = process.env.OPENCODE_CONFIG_DIR ??
    join(homedir(), ".config", "opencode");

  console.log(`[opencode] Looking for plugin config in ${configDir}...`);

  for (const name of ["opencode.jsonc", "opencode.json"]) {
    try {
      const raw = readFileSync(join(configDir, name), "utf-8");
      const stripped = raw.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      const cfg = JSON.parse(stripped);
      const plugins: string[] = cfg?.plugin ?? [];
      console.log(`[opencode] ${name}: plugins = [${plugins.join(", ")}]`);
      if (plugins.some((p) => p.startsWith("oh-my-openagent"))) {
        _detectedDefaultAgent = "sisyphus";
        console.log("[opencode] Detected oh-my-openagent plugin → default agent: sisyphus");
        return _detectedDefaultAgent;
      }
    } catch (e) {
      console.log(`[opencode] ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log("[opencode] No oh-my-openagent plugin detected, using OpenCode default agent");
  return _detectedDefaultAgent;
}

// ── Health monitor ─────────────────────────────────────────────────

const HEALTH_CHECK_INTERVAL_MS = 30_000;
const HEALTH_FAIL_THRESHOLD = 3;
const RECONNECT_BASE_DELAY_MS = 5_000;
const RECONNECT_MAX_DELAY_MS = 300_000;

export async function createOpenCodeService(
  store: SessionStore,
): Promise<OpenCodeService> {
  const { client, server } = await createOpencode({
    hostname: config.opencode.host,
    port: config.opencode.port,
  });

  const defaultDir = config.store.opencodeDir;
  const state = { client, server };
  let serverGeneration = 0;
  const validSessions = new Set<string>();

  console.log(`[opencode] Server started at ${server.url}`);

  // ── Health monitor ──────────────────────────────────────────

  let healthy = true;
  let consecutiveFails = 0;
  let reconnecting = false;
  let healthTimer: ReturnType<typeof setInterval> | null = null;

  async function runHealthCheck(): Promise<void> {
    if (reconnecting) return;
    try {
      await retryWithBackoff(
        () => state.client.config.providers({ directory: defaultDir }),
        "health-check",
        { maxRetries: 2, baseDelayMs: 2_000, maxDelayMs: 10_000 },
      );
      healthy = true;
      consecutiveFails = 0;
    } catch (err) {
      consecutiveFails++;
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[opencode] Health check failed (${consecutiveFails}/${HEALTH_FAIL_THRESHOLD}): ${errMsg}`);
      if (consecutiveFails >= HEALTH_FAIL_THRESHOLD) {
        healthy = false;
        await attemptReconnect();
      }
    }
  }

  async function attemptReconnect(): Promise<void> {
    if (reconnecting) return;
    reconnecting = true;
    stopHealthMonitor();
    console.error("[opencode] Connection lost — starting reconnect loop...");
    try { state.server.close(); } catch { /* already gone */ }

    let attempt = 0;
    while (true) {
      try {
        const delay = Math.min(RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt), RECONNECT_MAX_DELAY_MS);
        if (attempt > 0) {
          console.log(`[opencode] Reconnect attempt ${attempt + 1} in ${Math.round(delay / 1000)}s...`);
          await sleep(delay);
        }
        const result = await createOpencode({
          hostname: config.opencode.host,
          port: config.opencode.port,
        });
        state.client = result.client;
        state.server = result.server;
        serverGeneration++;
        validSessions.clear();
        healthy = true;
        consecutiveFails = 0;
        reconnecting = false;
        console.log(`[opencode] ✅ Reconnected after ${attempt + 1} attempt(s)! Server at ${result.server.url}`);
        startHealthMonitor();
        return;
      } catch (err) {
        attempt++;
        console.error(`[opencode] Reconnect attempt ${attempt} failed:`, err instanceof Error ? err.message : String(err));
      }
    }
  }

  function startHealthMonitor(): void {
    if (healthTimer) return;
    void runHealthCheck();
    healthTimer = setInterval(() => { void runHealthCheck(); }, HEALTH_CHECK_INTERVAL_MS);
    console.log("[opencode] Health monitor started");
  }

  function stopHealthMonitor(): void {
    if (healthTimer) {
      clearInterval(healthTimer);
      healthTimer = null;
    }
  }

  startHealthMonitor();

  // ── Service methods ─────────────────────────────────────────

  const ensureSession = async (wechatUserId: string): Promise<string> => {
    const existing = store.getActiveSessionId(wechatUserId);
    if (existing && validSessions.has(existing)) return existing;
    return newSession(wechatUserId);
  };

  const newSession = async (wechatUserId: string): Promise<string> => {
    const workDir = store.getWorkDir(wechatUserId, defaultDir);
    const count = (store.getEntry(wechatUserId)?.sessions.length ?? 0) + 1;

    const result = await retryWithBackoff(
      () => state.client.session.create({
        directory: workDir,
        title: `WeChat #${count}: ${wechatUserId.slice(0, 12)}`,
      }),
      "session.create",
    );

    const sessionId = result.data?.id;
    if (!sessionId) throw new Error("Session create returned no ID");
    validSessions.add(sessionId);
    store.addSession(wechatUserId, sessionId, `会话 ${count}`, workDir);
    console.log(`[opencode] Created session ${sessionId} (#${count}) for user ${wechatUserId.slice(0, 12)}...`);
    return sessionId;
  };

  const sendPrompt = async (wechatUserId: string, text: string): Promise<PromptResult> => {
    const sessionId = await ensureSession(wechatUserId);
    const workDir = store.getWorkDir(wechatUserId, defaultDir);
    store.touch(wechatUserId);

    const modelStr = store.getModel(wechatUserId) ?? config.opencode.model ?? undefined;
    const modelObj = modelStr ? parseModel(modelStr) : undefined;
    const systemPrompt = store.getSystem(wechatUserId);
    const agent = store.getAgent(wechatUserId);

    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        const delay = Math.min(5_000 * Math.pow(2, attempt), 30_000);
        console.log(`[opencode] Retrying prompt after UnknownError (attempt ${attempt + 1}/3 in ${Math.round(delay / 1000)}s)...`);
        await sleep(delay);
      }

      const result = await retryWithBackoff(
        () => state.client.session.prompt({
          sessionID: sessionId,
          directory: workDir,
          model: modelObj,
          system: systemPrompt,
          agent: agent,
          parts: [{ type: "text", text }],
        }),
        "session.prompt",
        { maxRetries: 3, baseDelayMs: 3_000, maxDelayMs: 30_000 },
      );

      if (!result.error) {
        const response = result.data as { info: AssistantMessage; parts: Part[] } | undefined;
        const parts: Part[] = response?.parts ?? [];

        if (response?.info) {
          console.log(`[opencode] Response from ${response.info.providerID}/${response.info.modelID} (${response.info.agent})`);
        }

        const textParts = parts
          .filter((p): p is TextPart => p.type === "text")
          .map((p) => p.text)
          .join("\n");

        const files = extractFiles(parts, workDir);

        return {
          text: textParts || "(no text response)",
          files,
        };
      }

      // Retry transient server errors (plugin not ready, etc.)
      const err = result.error as Record<string, unknown>;
      if (err.name === "UnknownError") {
        lastError = new Error(`OpenCode prompt error: ${JSON.stringify(result.error)}`);
        continue;
      }

      throw new Error(`OpenCode prompt error: ${JSON.stringify(result.error)}`);
    }

    throw lastError;
  };

  const listModels = async (): Promise<ModelInfo[]> => {
    const result = await retryWithBackoff(
      () => state.client.config.providers({ directory: defaultDir }),
      "config.providers",
    );

    if (result.error || !result.data) {
      console.error("[opencode] Failed to list providers:", result.error);
      return [];
    }

    const data = result.data as { providers: Array<{ id: string; name: string; models: Record<string, { name?: string }> }> };
    const models: ModelInfo[] = [];
    for (const provider of data.providers ?? []) {
      for (const [modelId, model] of Object.entries(provider.models)) {
        models.push({
          key: `${provider.id}/${modelId}`,
          label: model.name ?? modelId,
          provider: provider.name,
        });
      }
    }
    return models;
  };

  const setWorkDir = (wechatUserId: string, workDir: string): void => {
    store.setWorkDir(wechatUserId, workDir, defaultDir);
  };

  const setModel = (wechatUserId: string, model: string): void => {
    store.setModel(wechatUserId, model, defaultDir);
  };

  const setSystem = (wechatUserId: string, system: string): void => {
    store.setSystem(wechatUserId, system, defaultDir);
  };

  const setAgent = (wechatUserId: string, agent: string): void => {
    store.setAgent(wechatUserId, agent, defaultDir);
  };

  const listSessions = (wechatUserId: string) => store.listSessions(wechatUserId);
  const switchSession = (wechatUserId: string, index: number) => store.switchSession(wechatUserId, index);

  const abort = async (wechatUserId: string): Promise<void> => {
    const sessionId = store.getActiveSessionId(wechatUserId);
    if (!sessionId) return;
    await retryWithBackoff(
      () => state.client.session.abort({ sessionID: sessionId }),
      "session.abort",
    );
    console.log(`[opencode] Aborted session ${sessionId}`);
  };

  const undo = async (wechatUserId: string): Promise<string> => {
    const sessionId = store.getActiveSessionId(wechatUserId);
    if (!sessionId) return "没有活跃会话";
    const workDir = store.getWorkDir(wechatUserId, defaultDir);

    const result = await retryWithBackoff(
      () => state.client.session.revert({ sessionID: sessionId, directory: workDir }),
      "session.revert",
    );

    if (result.error) {
      console.error("[opencode] Undo failed:", result.error);
      return "❌ 撤销失败 — 可能已经没有可撤销的操作";
    }
    return "✅ 已撤销上一步操作";
  };

  const redo = async (wechatUserId: string): Promise<string> => {
    const sessionId = store.getActiveSessionId(wechatUserId);
    if (!sessionId) return "没有活跃会话";
    const workDir = store.getWorkDir(wechatUserId, defaultDir);

    const result = await retryWithBackoff(
      () => state.client.session.unrevert({ sessionID: sessionId, directory: workDir }),
      "session.unrevert",
    );

    if (result.error) {
      console.error("[opencode] Redo failed:", result.error);
      return "❌ 重做失败 — 可能已经没有可恢复的操作";
    }
    return "✅ 已重做上一步操作";
  };

  // ── v2 features ─────────────────────────────────────────────

  const listFiles = async (wechatUserId: string, dirPath?: string): Promise<FileEntry[]> => {
    const workDir = store.getWorkDir(wechatUserId, defaultDir);

    const result = await retryWithBackoff(
      () => state.client.file.list({ directory: workDir, path: dirPath ?? "." }),
      "file.list",
    );

    if (result.error || !result.data) {
      console.error("[opencode] file.list failed:", result.error);
      return [];
    }

    const entries = result.data as FileNode[];
    return entries.map((e) => ({ name: e.name, path: e.path, type: e.type }));
  };

  const readFile = async (wechatUserId: string, filePath: string): Promise<FileContentResult> => {
    const workDir = store.getWorkDir(wechatUserId, defaultDir);

    const result = await retryWithBackoff(
      () => state.client.file.read({ directory: workDir, path: filePath }),
      "file.read",
    );

    if (result.error || !result.data) {
      const errMsg = result.error ? JSON.stringify(result.error) : "no data";
      throw new Error(`读取文件失败: ${errMsg}`);
    }

    const data = result.data as FileContent;
    return { path: filePath, content: data.content ?? "" };
  };

  const findFiles = async (wechatUserId: string, query: string): Promise<FindResult> => {
    const workDir = store.getWorkDir(wechatUserId, defaultDir);

    const result = await retryWithBackoff(
      () => state.client.find.files({ directory: workDir, query }),
      "find.files",
    );

    if (result.error || !result.data) {
      console.error("[opencode] find.files failed:", result.error);
      return { files: [] };
    }

    return { files: result.data as string[] };
  };

  const grepFiles = async (wechatUserId: string, pattern: string): Promise<FindResult> => {
    const workDir = store.getWorkDir(wechatUserId, defaultDir);

    const result = await retryWithBackoff(
      () => state.client.find.text({ directory: workDir, pattern }),
      "find.text",
    );

    if (result.error || !result.data) {
      console.error("[opencode] find.text failed:", result.error);
      return { files: [] };
    }

    const matches = result.data as Array<{ path: { text: string }; lines: { text: string } }>;
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const m of matches) {
      const key = `${m.path.text}:${m.lines.text.trim()}`;
      if (!seen.has(key)) {
        seen.add(key);
        lines.push(`${m.path.text}: ${m.lines.text.trim()}`);
      }
    }
    return { files: lines };
  };

  const getDiff = async (wechatUserId: string): Promise<DiffResult> => {
    const workDir = store.getWorkDir(wechatUserId, defaultDir);

    const result = await retryWithBackoff(
      () => state.client.vcs.diff({ directory: workDir, mode: "git", context: 3 }),
      "vcs.diff",
    );

    if (result.error || !result.data) {
      const errMsg = result.error ? JSON.stringify(result.error) : "no data";
      throw new Error(`获取 diff 失败: ${errMsg}`);
    }

    const diffs = result.data as VcsFileDiff[];
    const text = diffs.map((d) => {
      const header = `${d.status ?? "modified"}: ${d.file} (+${d.additions}/-${d.deletions})`;
      return d.patch ? `${header}\n${d.patch}` : header;
    }).join("\n\n");
    return { diff: text || "(no changes)" };
  };

  const listWorktrees = async (): Promise<WorktreeEntry[]> => {
    const result = await retryWithBackoff(
      () => state.client.worktree.list({ directory: defaultDir }),
      "worktree.list",
    );

    if (result.error || !result.data) {
      console.error("[opencode] worktree.list failed:", result.error);
      return [];
    }

    const dirs = result.data as string[];
    return dirs.map((d, i) => {
      const parts = d.split(/[/\\]/);
      const branch = parts[parts.length - 1] || d;
      return { id: String(i), branch, path: d, isCurrent: i === 0 };
    });
  };

  const listMessages = async (wechatUserId: string, limit = 10): Promise<SessionMessage[]> => {
    const sessionId = store.getActiveSessionId(wechatUserId);
    if (!sessionId) return [];

    const workDir = store.getWorkDir(wechatUserId, defaultDir);

    const result = await retryWithBackoff(
      () => state.client.session.messages({
        sessionID: sessionId,
        directory: workDir,
        limit,
      }),
      "session.messages",
    );

    if (result.error || !result.data) {
      console.error("[opencode] session.messages failed:", result.error);
      return [];
    }

    const msgList = result.data as Array<{ info: Message; parts: Part[] }>;
    return msgList.map((m) => {
      const textParts = m.parts
        .filter((p): p is TextPart => p.type === "text")
        .map((p) => p.text)
        .join("\n");
      return {
        role: m.info.role as "user" | "assistant",
        text: textParts.slice(0, 200),
        time: (m.info as { time: { created: number } }).time?.created ?? 0,
      };
    });
  };

  const summarize = async (wechatUserId: string): Promise<string> => {
    const sessionId = store.getActiveSessionId(wechatUserId);
    if (!sessionId) return "没有活跃会话";

    const workDir = store.getWorkDir(wechatUserId, defaultDir);

    const result = await retryWithBackoff(
      () => state.client.session.summarize({
        sessionID: sessionId,
        directory: workDir,
      }),
      "session.summarize",
    );

    if (result.error) {
      console.error("[opencode] Summarize failed:", result.error);
      return "❌ 压缩失败 — 会话可能已经是最简状态";
    }
    return "✅ 会话已压缩 (summarized)";
  };

  const listTodos = async (wechatUserId: string): Promise<{ content: string; status: string; priority: string }[]> => {
    const sessionId = store.getActiveSessionId(wechatUserId);
    if (!sessionId) return [];

    const workDir = store.getWorkDir(wechatUserId, defaultDir);

    const result = await retryWithBackoff(
      () => state.client.session.todo({
        sessionID: sessionId,
        directory: workDir,
      }),
      "session.todo",
    );

    if (result.error || !result.data) {
      console.error("[opencode] session.todo failed:", result.error);
      return [];
    }

    const todos = result.data as Array<{ content: string; status: string; priority: string }>;
    return todos;
  };

  const sendPromptAsync = async (wechatUserId: string, text: string): Promise<void> => {
    const sessionId = await ensureSession(wechatUserId);
    const workDir = store.getWorkDir(wechatUserId, defaultDir);
    store.touch(wechatUserId);

    const modelStr = store.getModel(wechatUserId) ?? config.opencode.model ?? undefined;
    const modelObj = modelStr ? parseModel(modelStr) : undefined;
    const systemPrompt = store.getSystem(wechatUserId);
    const agent = store.getAgent(wechatUserId);

    // Fire and forget — no retry, no await for result
    state.client.session.promptAsync({
      sessionID: sessionId,
      directory: workDir,
      model: modelObj,
      system: systemPrompt,
      agent: agent,
      parts: [{ type: "text", text }],
    }).catch((err) => {
      console.error("[opencode] promptAsync error:", err instanceof Error ? err.message : String(err));
    });

    console.log(`[opencode] Async prompt queued for session ${sessionId}`);
  };

  return {
    ensureSession,
    newSession,
    sendPrompt,
    listModels,
    listSessions,
    switchSession,
    setWorkDir,
    setModel,
    setSystem,
    setAgent,
    getDefaultAgent: () => detectDefaultAgent(),
    abort,
    undo,
    redo,
    shutdown: () => {
      stopHealthMonitor();
      state.server.close();
    },
    isHealthy: async () => healthy && !reconnecting,
    listFiles,
    readFile,
    findFiles,
    grepFiles,
    getDiff,
    listWorktrees,
    listMessages,
    summarize,
    listTodos,
    sendPromptAsync,
  };
}

// ── File extraction ──────────────────────────────────────────────

function extractFiles(parts: Part[], workDir: string): FileOutput[] {
  const seen = new Set<string>();
  const files: FileOutput[] = [];

  for (const part of parts) {
    if (part.type === "tool") {
      const tool = part as ToolPart;
      if (tool.state.status === "completed") {
        const completed = tool.state as ToolStateCompleted;
        for (const att of completed.attachments ?? []) {
          const attSource = att as FilePart;
          const path = attSource.source && "path" in attSource.source
            ? attSource.source.path
            : undefined;
          if (path && !seen.has(path)) {
            seen.add(path);
            files.push({ path: resolve(workDir, path), label: `${completed.title}: ${path}` });
          }
        }
      }
    }

    if (part.type === "patch") {
      const patch = part as PatchPart;
      for (const filePath of patch.files) {
        if (!seen.has(filePath)) {
          seen.add(filePath);
          files.push({ path: resolve(workDir, filePath), label: `已修改: ${filePath}` });
        }
      }
    }
  }

  return files;
}

function parseModel(model: string): { providerID: string; modelID: string } {
  const slashIdx = model.indexOf("/");
  if (slashIdx === -1) throw new Error(`Invalid model format: ${model}. Expected "provider/model"`);
  return { providerID: model.slice(0, slashIdx), modelID: model.slice(slashIdx + 1) };
}
