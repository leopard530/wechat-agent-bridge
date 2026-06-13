/**
 * Feishu (Lark) channel adapter.
 * Implements ChannelService using @larksuiteoapi/node-sdk's createLarkChannel (WebSocket).
 *
 * Proxy env vars (HTTP_PROXY etc.) are cleared during ALL Feishu SDK calls because
 * they route directly to open.feishu.cn — the proxy breaks HTTPS with "plain HTTP
 * request was sent to HTTPS port". OpenCode's HTTP client needs the proxy for
 * model API calls, so we restore env vars after each Feishu operation.
 */
import type { ChannelService, IncomingMessage } from "../types.js";
import { config } from "../../config.js";
import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import type { LarkChannel } from "@larksuiteoapi/node-sdk";

const chatIdByUser = new Map<string, string>();

type SavedProxy = {
  NO_PROXY: string | undefined;
  no_proxy: string | undefined;
  HTTP_PROXY: string | undefined;
  HTTPS_PROXY: string | undefined;
  http_proxy: string | undefined;
  https_proxy: string | undefined;
};

function saveAndClearProxy(): SavedProxy {
  const saved: SavedProxy = {
    NO_PROXY: process.env.NO_PROXY,
    no_proxy: process.env.no_proxy,
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    http_proxy: process.env.http_proxy,
    https_proxy: process.env.https_proxy,
  };
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.http_proxy;
  delete process.env.https_proxy;
  process.env.NO_PROXY = "*";
  process.env.no_proxy = "*";
  return saved;
}

function restoreProxy(saved: SavedProxy): void {
  if (saved.HTTP_PROXY !== undefined) process.env.HTTP_PROXY = saved.HTTP_PROXY;
  else delete process.env.HTTP_PROXY;
  if (saved.HTTPS_PROXY !== undefined) process.env.HTTPS_PROXY = saved.HTTPS_PROXY;
  else delete process.env.HTTPS_PROXY;
  if (saved.http_proxy !== undefined) process.env.http_proxy = saved.http_proxy;
  else delete process.env.http_proxy;
  if (saved.https_proxy !== undefined) process.env.https_proxy = saved.https_proxy;
  else delete process.env.https_proxy;
  if (saved.NO_PROXY !== undefined) process.env.NO_PROXY = saved.NO_PROXY;
  else delete process.env.NO_PROXY;
  if (saved.no_proxy !== undefined) process.env.no_proxy = saved.no_proxy;
  else delete process.env.no_proxy;
}

async function withoutProxy<T>(fn: () => Promise<T>): Promise<T> {
  const saved = saveAndClearProxy();
  try {
    return await fn();
  } finally {
    restoreProxy(saved);
  }
}

export function createFeishuChannel(): ChannelService {
  let larkChannel: LarkChannel | null = null;
  let handler: ((msg: IncomingMessage) => Promise<void>) | null = null;

  function wireHandler(): void {
    if (!larkChannel || !handler) return;
    larkChannel.on("message", async (msg: NormalizedMessage) => {
      chatIdByUser.set(msg.senderId, msg.chatId);
      await handler!({
        userId: msg.senderId,
        text: msg.content,
        channel: "feishu",
        raw: msg,
      });
    });
    larkChannel.on("error", (err) => {
      console.error("[feishu] Channel error:", err.message);
    });
  }

  return {
    name: "feishu",

    async start() {
      await withoutProxy(async () => {
        const mod = await import("@larksuiteoapi/node-sdk");
        larkChannel = mod.createLarkChannel({
          appId: config.channels.feishu.appId,
          appSecret: config.channels.feishu.appSecret,
          domain: mod.Domain.Feishu,
          transport: "websocket",
          policy: { requireMention: false, dmMode: "open" },
        });

        wireHandler();

        console.log("[feishu] Connecting via WebSocket...");
        await larkChannel.connect();
        console.log("[feishu] Connected. Bot ready.");
      });
    },

    stop() {
      larkChannel?.disconnect().catch(() => {});
    },

    onMessage(h: (msg: IncomingMessage) => Promise<void>) {
      handler = h;
    },

    async reply(_msg: IncomingMessage, text: string) {
      if (!larkChannel) throw new Error("[feishu] Channel not started");
      const raw = _msg.raw as NormalizedMessage;
      await withoutProxy(() => larkChannel!.send(raw.chatId, { text }, { replyTo: raw.messageId }));
    },

    sendTyping: async () => {},

    stopTyping: async () => {},

    async sendFile(userId: string, filePath: string, fileName?: string) {
      if (!larkChannel) throw new Error("[feishu] Channel not started");
      const chatId = chatIdByUser.get(userId);
      if (!chatId) throw new Error(`[feishu] No chatId found for user ${userId}`);

      const name = fileName ?? filePath.split(/[/\\]/).pop() ?? "file";
      const { readFile } = await import("node:fs/promises");
      const buffer = await readFile(filePath);
      await withoutProxy(() => larkChannel!.send(chatId, { file: { source: buffer, fileName: name } }));
    },

    async sendImage(userId: string, filePath: string) {
      if (!larkChannel) throw new Error("[feishu] Channel not started");
      const chatId = chatIdByUser.get(userId);
      if (!chatId) throw new Error(`[feishu] No chatId found for user ${userId}`);

      const { readFile } = await import("node:fs/promises");
      const buffer = await readFile(filePath);
      await withoutProxy(() => larkChannel!.send(chatId, { image: { source: buffer } }));
    },
  };
}
