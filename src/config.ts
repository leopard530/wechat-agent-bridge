import { config as dotenvConfig } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolve(__dirname, "..", ".env") });

function env(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined) return fallback;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}

export const config = {
  opencode: {
    host: env("OPENCODE_HOST", "127.0.0.1"),
    port: envInt("OPENCODE_PORT", 4096),
    model: process.env["OPENCODE_MODEL"],
  },

  wechat: {
    dataDir: resolve(env("WECHAT_DATA_DIR", "./data/wechat")),
  },

  store: {
    sessionPath: resolve(env("SESSION_STORE_PATH", "./data/sessions.json")),
    opencodeDir: resolve(env("OPENCODE_DIR", process.cwd())),
  },

  log: {
    level: env("LOG_LEVEL", "info"),
  },
} as const;

export type Config = typeof config;
