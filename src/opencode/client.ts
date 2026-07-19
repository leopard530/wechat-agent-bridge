import {
  createOpencode,
  createOpencodeClient,
  type OpencodeClient,
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
import { existsSync } from "node:fs";

export interface ModelInfo {
  key: string;
  label: string;
  provider: string;
  isDefault?: boolean;
}

export interface AgentInfo {
  name: string;
  description?: string;
  mode: "primary" | "subagent" | "all";
  native?: boolean;
  hidden?: boolean;
}

export interface PermissionRequest {
  id: string;
  sessionId: string;
  permission: string;
  patterns: string[];
  tool?: { messageId: string; callId: string };
}

export interface FileOutput {
  path: string;
  label: string;
}

export interface ProgressUpdate {
  type: "tool" | "text" | "reasoning" | "step" | "permission" | "compacting";
  text: string;
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
  /** Returns true if the user needs a new OpenCode session (e.g. after restart). */
  needsNewSession(wechatUserId: string): boolean;
  sendPrompt(wechatUserId: string, text: string, onProgress?: (update: ProgressUpdate) => void): Promise<PromptResult>;
  listModels(): Promise<ModelInfo[]>;
  listAgents(): Promise<AgentInfo[]>;
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
  /** Get the model actually used in the last prompt for a user. */
  getLastUsedModel(wechatUserId: string): string | undefined;
  /** Check for pending permission requests for a user's session. */
  listPendingPermissions(wechatUserId: string): Promise<PermissionRequest[]>;
  /** Approve a permission request. */
  approvePermission(wechatUserId: string, requestId: string, always?: boolean): Promise<void>;
  /** Deny a permission request. */
  denyPermission(wechatUserId: string, requestId: string): Promise<void>;
  /** Fetch session info from OpenCode (title, etc). */
  getSessionInfo(wechatUserId: string): Promise<{ id: string; title: string }[]>;

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

  // TypeError from fetch usually means network failure (server down, DNS, etc.)
  if (err.name === "TypeError") return true;

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

/**
 * Build a descriptive error from an OpenCode SDK result with error.
 * Includes HTTP status code, status text, and error details.
 */
function buildPromptError(result: { error: unknown; response?: { status: number; statusText: string } }): Error {
  const status = result.response
    ? `HTTP ${result.response.status} ${result.response.statusText}`
    : "No HTTP response";
  const errObj = result.error as Record<string, unknown> | undefined;

  // If the error is empty or only has a name, the status is more informative
  if (!errObj || Object.keys(errObj).filter((k) => k !== "name").length === 0) {
    const name = errObj?.name;
    return new Error(
      `OpenCode prompt error: ${status}${name ? ` (${name})` : ""} — upstream server returned no details`,
    );
  }

  return new Error(`OpenCode prompt error: ${status} — ${JSON.stringify(result.error)}`);
}

// ── Default agent detection ────────────────────────────────────────

let _detectedDefaultAgent: string | undefined = undefined;
let _agentDetected = false;

// ── Health monitor ─────────────────────────────────────────────────

const HEALTH_CHECK_INTERVAL_MS = 30_000;
const HEALTH_FAIL_THRESHOLD = 3;
const RECONNECT_BASE_DELAY_MS = 5_000;
const RECONNECT_MAX_DELAY_MS = 300_000;

export async function createOpenCodeService(
  store: SessionStore,
): Promise<OpenCodeService> {
  const defaultDir = config.store.opencodeDir;
  const baseUrl = `http://${config.opencode.host}:${config.opencode.port}`;

  let client: OpencodeClient;
  let server: { url: string; close(): void };
  let managedServer = false;

  try {
    console.log(`[opencode] Probing existing server at ${baseUrl}...`);
    const probe = await fetch(`${baseUrl}/api/session/list?directory=${encodeURIComponent(defaultDir)}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(3_000),
    });
    if (probe.ok || probe.status === 400 || probe.status === 404) {
      console.log(`[opencode] Found existing server at ${baseUrl}, connecting...`);
      client = createOpencodeClient({ baseUrl });
      server = { url: baseUrl, close: () => { console.log("[opencode] Disconnected from external server (not closing)"); } };
    } else {
      throw new Error(`Server responded with status ${probe.status}`);
    }
  } catch (err) {
    const probeErr = err instanceof Error ? err.message : String(err);
    console.log(`[opencode] No existing server found (${probeErr}), spawning new one...`);
    const result = await createOpencode({
      hostname: config.opencode.host,
      port: config.opencode.port,
    });
    client = result.client;
    server = result.server;
    managedServer = true;
  }

  const state = { client, server };
  let serverGeneration = 0;
  const validSessions = new Set<string>();

  // Dedup concurrent session creation for the same user
  const pendingSessions = new Map<string, Promise<string>>();

  // Track the model actually used in the last successful response per user
  const lastUsedModel = new Map<string, string>();

  console.log(`[opencode] Server ready at ${server.url}${managedServer ? " (spawned)" : " (external)"}`);

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
    if (managedServer) {
      try { state.server.close(); } catch { /* already gone */ }
    }

    let attempt = 0;
    while (true) {
      try {
        const delay = Math.min(RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt), RECONNECT_MAX_DELAY_MS);
        if (attempt > 0) {
          console.log(`[opencode] Reconnect attempt ${attempt + 1} in ${Math.round(delay / 1000)}s...`);
          await sleep(delay);
        }

        const probeBaseUrl = `http://${config.opencode.host}:${config.opencode.port}`;

        // 1. Try probing for an existing server
        try {
          const probe = await fetch(`${probeBaseUrl}/api/session/list?directory=${encodeURIComponent(defaultDir)}`, {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(3_000),
          });
          if (probe.ok || probe.status === 400 || probe.status === 404) {
            console.log(`[opencode] Found existing server at ${probeBaseUrl}, reconnecting...`);
            state.client = createOpencodeClient({ baseUrl: probeBaseUrl });
            state.server = { url: probeBaseUrl, close: () => { console.log("[opencode] Disconnected from external server (not closing)"); } };
            managedServer = false;
            serverGeneration++;
            validSessions.clear();
            healthy = true;
            consecutiveFails = 0;
            reconnecting = false;
            console.log(`[opencode] ✅ Reconnected to existing server at ${probeBaseUrl}`);
            startHealthMonitor();
            return;
          }
        } catch {
          // No existing server found, fall through to spawn
        }

        // 2. No existing server — spawn a new one
        const result = await createOpencode({
          hostname: config.opencode.host,
          port: config.opencode.port,
        });
        state.client = result.client;
        state.server = result.server;
        managedServer = true;
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

  // ── Detect default agent from API ──

  void (async () => {
    try {
      const result = await retryWithBackoff(
        () => state.client.app.agents({ directory: defaultDir }),
        "app.agents",
      );
      if (!result.error && result.data) {
        const primary = result.data.find((a) => a.mode === "primary" && !a.hidden);
        if (primary) {
          _detectedDefaultAgent = primary.name;
          console.log(`[opencode] Default agent: ${primary.name}`);
        } else {
          console.log("[opencode] No primary agent detected, using OpenCode default");
        }
      }
    } catch (err) {
      console.warn("[opencode] Failed to detect default agent:", err instanceof Error ? err.message : String(err));
    }
    _agentDetected = true;
  })();

  // ── Service methods ─────────────────────────────────────────

  const ensureSession = async (wechatUserId: string): Promise<string> => {
    const existing = store.getActiveSessionId(wechatUserId);
    if (existing && validSessions.has(existing)) return existing;

    // Dedup: if a session is already being created for this user, wait on it
    const pending = pendingSessions.get(wechatUserId);
    if (pending) return pending;

    const promise = newSession(wechatUserId);
    pendingSessions.set(wechatUserId, promise);
    try {
      return await promise;
    } finally {
      pendingSessions.delete(wechatUserId);
    }
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
    const sessionTitle = (result.data as { title?: string } | undefined)?.title ?? `会话 ${count}`;
    store.addSession(wechatUserId, sessionId, sessionTitle, workDir);
    console.log(`[opencode] Created session ${sessionId} (#${count}) for user ${wechatUserId.slice(0, 12)}...`);
    return sessionId;
  };

  const sendPrompt = async (wechatUserId: string, text: string, onProgress?: (update: ProgressUpdate) => void): Promise<PromptResult> => {
    const sessionId = await ensureSession(wechatUserId);
    let workDir = store.getWorkDir(wechatUserId, defaultDir);

    // Auto-heal: if stored workDir no longer exists (project moved), fall back to default
    if (!existsSync(workDir)) {
      console.warn(`[opencode] Stored workDir no longer exists: ${workDir} — using ${defaultDir}`);
      workDir = defaultDir;
      store.setWorkDir(wechatUserId, workDir, defaultDir);
    }

    store.touch(wechatUserId);

    const modelStr = store.getModel(wechatUserId) ?? config.opencode.model ?? undefined;
    const modelObj = modelStr ? parseModel(modelStr) : undefined;
    const systemPrompt = store.getSystem(wechatUserId);
    const agent = store.getAgent(wechatUserId);

    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        const delay = Math.min(5_000 * Math.pow(2, attempt), 30_000);
        console.warn(`[opencode] Retrying prompt (attempt ${attempt + 1}/3 in ${Math.round(delay / 1000)}s)...`);
        await sleep(delay);
      }

      // Run prompt and auto-approve permissions + stream progress concurrently
      let stopPolling = false;
      let lastSeenMessageIndex = 0;
      const promptPromise = retryWithBackoff(
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

      // Background polling: permissions + message progress
      const backgroundPromise = (async () => {
        await sleep(3_000);
        while (!stopPolling) {
          // Auto-approve permissions
          try {
            const perms = await state.client.permission.list({ directory: workDir });
            if (perms.data && Array.isArray(perms.data) && perms.data.length > 0) {
              for (const perm of perms.data as Array<{ id: string; permission: string; patterns: string[] }>) {
                const desc = perm.patterns?.length > 0 ? perm.patterns.join(", ") : perm.permission;
                console.log(`[opencode] Auto-approving permission: ${desc}`);
                onProgress?.({ type: "permission", text: desc });
                await state.client.permission.reply({
                  requestID: perm.id,
                  directory: workDir,
                  reply: "once",
                });
                await sleep(500);
              }
            }
          } catch (err) {
            console.log(`[opencode] Permission poll: ${err instanceof Error ? err.message : String(err)}`);
          }

          // Stream progress: poll recent messages for tool calls / steps
          if (onProgress) {
            try {
              const msgs = await state.client.session.messages({
                sessionID: sessionId,
                directory: workDir,
                limit: 10,
              });
              if (msgs.data && Array.isArray(msgs.data)) {
                const msgList = msgs.data as Array<{ info: { role: string; time?: { created: number } }; parts: Part[] }>;
                for (let i = lastSeenMessageIndex; i < msgList.length; i++) {
                  const m = msgList[i];
                  if (m.info?.role !== "assistant") continue;
                  for (const part of m.parts ?? []) {
                    if (part.type === "tool" && (part as ToolPart).state?.status === "running") {
                      const tool = part as ToolPart;
                      onProgress({ type: "tool", text: tool.tool ?? "running tool..." });
                    }
                  }
                }
                lastSeenMessageIndex = msgList.length;
              }
            } catch {
              // Message polling failed, ignore
            }
          }

          await sleep(3_000);
        }
      })();

      const result = await promptPromise;
      stopPolling = true;
      await backgroundPromise.catch(() => {});

      if (!result.error) {
        const response = result.data as { info: AssistantMessage; parts: Part[] } | undefined;
        const parts: Part[] = response?.parts ?? [];

        if (response?.info) {
          console.log(`[opencode] Response from ${response.info.providerID}/${response.info.modelID} (${response.info.agent})`);
          lastUsedModel.set(wechatUserId, `${response.info.providerID}/${response.info.modelID}`);
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

      // Retry transient server errors (plugin not ready, rate limit, etc.)
      const err = result.error as Record<string, unknown>;
      const status = result.response?.status;
      const isRetryable =
        err.name === "UnknownError" ||
        !err.name ||
        (typeof status === "number" && [500, 502, 503, 504].includes(status));
      if (isRetryable) {
        lastError = buildPromptError(result);
        console.warn(`[opencode] Prompt error (attempt ${attempt + 1}/3): ${buildPromptError(result).message}`);
        continue;
      }

      throw buildPromptError(result);
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

    const data = result.data as { providers: Array<{ id: string; name: string; models: Record<string, { name?: string }> }>; default?: Record<string, string> };
    const defaults: Record<string, string> = data.default ?? {};
    const models: ModelInfo[] = [];
    for (const provider of data.providers ?? []) {
      for (const [modelId, model] of Object.entries(provider.models)) {
        const key = `${provider.id}/${modelId}`;
        models.push({
          key,
          label: model.name ?? modelId,
          provider: provider.name,
          isDefault: defaults[provider.id] === modelId,
        });
      }
    }
    return models;
  };

  const listAgents = async (): Promise<AgentInfo[]> => {
    const result = await retryWithBackoff(
      () => state.client.app.agents({ directory: defaultDir }),
      "app.agents",
    );

    if (result.error || !result.data) {
      console.error("[opencode] Failed to list agents:", result.error);
      return [];
    }

    return result.data
      .filter((a) => !a.hidden)
      .map((a) => ({
        name: a.name,
        description: a.description,
        mode: a.mode as "primary" | "subagent" | "all",
        native: a.native,
        hidden: a.hidden,
      }));
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
    needsNewSession: (wechatUserId: string) => {
      const existing = store.getActiveSessionId(wechatUserId);
      if (!existing) return true;
      return !validSessions.has(existing);
    },
    sendPrompt,
    listModels,
    listAgents,
    listSessions,
    switchSession,
    setWorkDir,
    setModel,
    setSystem,
    setAgent,
    getDefaultAgent: () => _detectedDefaultAgent,
    abort,
    undo,
    redo,
    shutdown: () => {
      stopHealthMonitor();
      if (managedServer) {
        state.server.close();
      } else {
        console.log("[opencode] Disconnected from external server (not closing)");
      }
    },
    isHealthy: async () => healthy && !reconnecting,
    getLastUsedModel: (wechatUserId: string) => lastUsedModel.get(wechatUserId),
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
    listPendingPermissions: async (wechatUserId: string) => {
      const result = await retryWithBackoff(
        () => state.client.permission.list({ directory: defaultDir }),
        "permission.list",
      );

      if (result.error || !result.data) {
        console.error("[opencode] listPendingPermissions failed:", result.error);
        return [];
      }

      const perms = result.data as Array<{ id: string; sessionID: string; permission: string; patterns: string[] }>;
      return perms.map((r) => ({
        id: r.id,
        sessionId: r.sessionID,
        permission: r.permission,
        patterns: r.patterns,
        tool: undefined,
      }));
    },
    approvePermission: async (wechatUserId: string, requestId: string, always = false) => {
      await retryWithBackoff(
        () => state.client.permission.reply({
          requestID: requestId,
          directory: defaultDir,
          reply: always ? "always" : "once",
        }),
        "permission.reply",
      );
      console.log(`[opencode] Approved permission ${requestId} for user ${wechatUserId.slice(0, 12)}...`);
    },
    denyPermission: async (wechatUserId: string, requestId: string) => {
      await retryWithBackoff(
        () => state.client.permission.reply({
          requestID: requestId,
          directory: defaultDir,
          reply: "reject",
        }),
        "permission.reply",
      );
      console.log(`[opencode] Denied permission ${requestId} for user ${wechatUserId.slice(0, 12)}...`);
    },
    getSessionInfo: async (wechatUserId: string) => {
      const result = await retryWithBackoff(
        () => state.client.session.list({ directory: defaultDir }),
        "session.list",
      );
      if (result.error || !result.data) {
        console.error("[opencode] session.list failed:", result.error);
        return [];
      }
      const sessions = result.data as Array<{ id: string; title?: string }>;
      return sessions.map((s) => ({ id: s.id, title: s.title ?? s.id }));
    },
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
