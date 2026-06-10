import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface SessionRecord {
  opencodeSessionId: string;
  title: string;
  createdAt: string;
}

export interface SessionEntry {
  /** WeChat userId this entry belongs to */
  wechatUserId: string;
  /** All sessions for this user */
  sessions: SessionRecord[];
  /** Index into sessions[] of the currently active session */
  activeIndex: number;
  /** Working directory for this user */
  workDir: string;
  /** AI model in "provider/model" format */
  model?: string;
  /** Custom system prompt */
  system?: string;
  /** Agent name to use */
  agent?: string;
  /** Last activity timestamp */
  lastActive: string;
}

/**
 * Maps WeChat userId → SessionEntry (which contains N sessions).
 * State persisted to disk so sessions survive restarts.
 */
export class SessionStore {
  private map = new Map<string, SessionEntry>();
  private path: string;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(path: string) {
    this.path = path;
  }

  /** Load persisted sessions from disk. Auto-migrates old single-session format. */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, "utf-8");
      const entries: unknown[] = JSON.parse(raw);

      for (const e of entries) {
        if (!e || typeof e !== "object") continue;
        const obj = e as Record<string, unknown>;

        // Detect old single-session format and migrate
        if (
          typeof obj.opencodeSessionId === "string" &&
          !Array.isArray(obj.sessions)
        ) {
          const entry: SessionEntry = {
            wechatUserId: String(obj.wechatUserId ?? ""),
            sessions: [
              {
                opencodeSessionId: String(obj.opencodeSessionId),
                title: String(obj.title ?? obj.opencodeSessionId ?? "").slice(0, 30),
                createdAt: String(obj.lastActive ?? new Date().toISOString()),
              },
            ],
            activeIndex: 0,
            workDir: String(obj.workDir ?? ""),
            model: typeof obj.model === "string" ? obj.model : undefined,
            system: typeof obj.system === "string" ? obj.system : undefined,
            agent: typeof obj.agent === "string" ? obj.agent : undefined,
            lastActive: String(obj.lastActive ?? new Date().toISOString()),
          };
          this.map.set(entry.wechatUserId, entry);
        }
        // New multi-session format
        else if (Array.isArray(obj.sessions) && typeof obj.activeIndex === "number") {
          const entry: SessionEntry = {
            wechatUserId: String(obj.wechatUserId ?? ""),
            sessions: (obj.sessions as SessionRecord[]).map(
              (s) => ({
                opencodeSessionId: String(s.opencodeSessionId),
                title: String(s.title ?? s.opencodeSessionId).slice(0, 30),
                createdAt: String(s.createdAt ?? new Date().toISOString()),
              }),
            ),
            activeIndex: Number(obj.activeIndex),
            workDir: String(obj.workDir ?? ""),
            model: typeof obj.model === "string" ? obj.model : undefined,
            system: typeof obj.system === "string" ? obj.system : undefined,
            agent: typeof obj.agent === "string" ? obj.agent : undefined,
            lastActive: String(obj.lastActive ?? new Date().toISOString()),
          };
          this.map.set(entry.wechatUserId, entry);
        }
      }
    } catch {
      this.map.clear();
    }
  }

  // ── session ID access ──

  /** Get the active OpenCode session ID. Returns null if no session exists. */
  getActiveSessionId(wechatUserId: string): string | null {
    const entry = this.map.get(wechatUserId);
    if (!entry || entry.sessions.length === 0) return null;
    const idx = clamp(entry.activeIndex, 0, entry.sessions.length - 1);
    return entry.sessions[idx].opencodeSessionId;
  }

  /** Get the full entry for a user. Returns null if not found. */
  getEntry(wechatUserId: string): SessionEntry | null {
    return this.map.get(wechatUserId) ?? null;
  }

  /** Check if any session exists for this user. */
  has(wechatUserId: string): boolean {
    const entry = this.map.get(wechatUserId);
    return entry !== undefined && entry.sessions.length > 0;
  }

  /** Ensure an entry exists, creating one with defaults if not. */
  private ensureEntry(wechatUserId: string, workDir: string): SessionEntry {
    let entry = this.map.get(wechatUserId);
    if (!entry) {
      entry = {
        wechatUserId,
        sessions: [],
        activeIndex: 0,
        workDir,
        lastActive: new Date().toISOString(),
      };
      this.map.set(wechatUserId, entry);
    }
    return entry;
  }

  // ── session lifecycle ──

  /** Add a new session and make it active. Returns the new session record. */
  addSession(
    wechatUserId: string,
    opencodeSessionId: string,
    title: string,
    workDir: string,
  ): SessionRecord {
    const entry = this.ensureEntry(wechatUserId, workDir);
    const record: SessionRecord = {
      opencodeSessionId,
      title: title.slice(0, 30),
      createdAt: new Date().toISOString(),
    };
    entry.sessions.push(record);
    entry.activeIndex = entry.sessions.length - 1;
    entry.lastActive = record.createdAt;
    this.markDirty();
    return record;
  }

  /** List all sessions for a user. */
  listSessions(wechatUserId: string): SessionEntry | null {
    return this.getEntry(wechatUserId);
  }

  /** Switch to a different session by index. Returns false if out of range. */
  switchSession(wechatUserId: string, index: number): boolean {
    const entry = this.map.get(wechatUserId);
    if (!entry || index < 0 || index >= entry.sessions.length) return false;
    entry.activeIndex = index;
    entry.lastActive = new Date().toISOString();
    this.markDirty();
    return true;
  }

  // ── per-user settings ──

  /** Set the working directory for a user. Auto-creates entry if needed. */
  setWorkDir(wechatUserId: string, workDir: string, fallbackDir: string): void {
    const entry = this.ensureEntry(wechatUserId, workDir || fallbackDir);
    entry.workDir = workDir || fallbackDir;
    entry.lastActive = new Date().toISOString();
    this.markDirty();
  }

  /** Get the working directory for a user. Returns fallback if no entry. */
  getWorkDir(wechatUserId: string, fallback: string): string {
    return this.map.get(wechatUserId)?.workDir ?? fallback;
  }

  /** Set the AI model for a user. Auto-creates entry if needed. */
  setModel(wechatUserId: string, model: string, fallbackDir: string): void {
    const entry = this.ensureEntry(wechatUserId, fallbackDir);
    entry.model = model;
    entry.lastActive = new Date().toISOString();
    this.markDirty();
  }

  /** Get the AI model for a user. Returns undefined if not set. */
  getModel(wechatUserId: string): string | undefined {
    return this.map.get(wechatUserId)?.model;
  }

  /** Set the system prompt for a user. Auto-creates entry if needed. */
  setSystem(wechatUserId: string, system: string, fallbackDir: string): void {
    const entry = this.ensureEntry(wechatUserId, fallbackDir);
    entry.system = system || undefined;
    entry.lastActive = new Date().toISOString();
    this.markDirty();
  }

  /** Get the system prompt for a user. Returns undefined if not set. */
  getSystem(wechatUserId: string): string | undefined {
    return this.map.get(wechatUserId)?.system;
  }

  /** Set the agent for a user. Auto-creates entry if needed. */
  setAgent(wechatUserId: string, agent: string, fallbackDir: string): void {
    const entry = this.ensureEntry(wechatUserId, fallbackDir);
    entry.agent = agent || undefined;
    entry.lastActive = new Date().toISOString();
    this.markDirty();
  }

  /** Get the agent for a user. Returns undefined if not set. */
  getAgent(wechatUserId: string): string | undefined {
    return this.map.get(wechatUserId)?.agent;
  }

  /** Touch lastActive timestamp. */
  touch(wechatUserId: string): void {
    const entry = this.map.get(wechatUserId);
    if (entry) {
      entry.lastActive = new Date().toISOString();
      this.markDirty();
    }
  }

  // ── persistence ──

  /** Flush pending writes immediately. */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.writeNow();
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.writeNow();
    }, 500);
  }

  private async writeNow(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;

    const entries = [...this.map.values()];
    const dir = dirname(this.path);
    await mkdir(dir, { recursive: true });
    await writeFile(this.path, JSON.stringify(entries, null, 2), "utf-8");
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
