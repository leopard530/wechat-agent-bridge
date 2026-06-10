import { WeixinBot, type IncomingMessage } from "@pinixai/weixin-bot";
import { config } from "../config.js";
import { uploadToWeixinCdn, UploadMediaType, type UploadedFileInfo } from "../cdn/upload.js";
import { sendImage, sendFile } from "./media.js";

export type { IncomingMessage };

export interface WeChatService {
  /** Start the bot: login (QR if needed) and begin polling. */
  start(): Promise<void>;
  /** Stop the bot gracefully. */
  stop(): void;
  /** Register a handler for incoming messages. */
  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void;
  /** Reply to a message. */
  reply(msg: IncomingMessage, text: string): Promise<void>;
  /** Show "typing..." indicator. */
  sendTyping(userId: string): Promise<void>;
  /** Cancel "typing..." indicator. */
  stopTyping(userId: string): Promise<void>;

  /** Upload and send an image file to a user via WeChat. */
  sendImage(userId: string, filePath: string): Promise<void>;
  /** Upload and send a file attachment to a user via WeChat. */
  sendFile(userId: string, filePath: string, fileName?: string): Promise<void>;
}

/**
 * Split a long message into chunks suitable for WeChat (max ~2000 chars).
 * Splits at natural boundaries: paragraph breaks → line breaks → hard split.
 * Preserves code fence blocks (doesn't split inside ```).
 */
export function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Find split point: prefer double line break, then single line break
    let splitAt = -1;

    // Search backwards from maxLen for a paragraph break
    const searchWindow = remaining.slice(0, maxLen);
    const paraBreak = searchWindow.lastIndexOf("\n\n");
    if (paraBreak > maxLen * 0.3) {
      splitAt = paraBreak + 2; // include the \n\n in current chunk
    } else {
      // Try single line break
      const lineBreak = searchWindow.lastIndexOf("\n");
      if (lineBreak > maxLen * 0.3) {
        splitAt = lineBreak + 1;
      }
    }

    // If we're inside a code fence, extend to include the closing fence
    const fenceCount = (remaining.slice(0, splitAt > 0 ? splitAt : maxLen).match(/```/g) || []).length;
    if (fenceCount % 2 !== 0) {
      // Inside a code block — find the closing ```
      const closingFence = remaining.indexOf("```", splitAt > 0 ? splitAt : maxLen);
      if (closingFence !== -1 && closingFence < maxLen * 2) {
        splitAt = closingFence + 3;
      }
    }

    if (splitAt <= 0 || splitAt > maxLen) {
      // No good break found — hard split at maxLen
      splitAt = maxLen;
    }

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

export function createWeChatService(): WeChatService {
  const bot = new WeixinBot({
    tokenPath: config.wechat.dataDir + "/credentials.json",
  });

  // Track credentials and context tokens for media uploads
  let credentials: { token: string; baseUrl: string } | null = null;
  const contextTokens = new Map<string, string>();

  return {
    start: async () => {
      try {
        const result = await bot.login();
        if (result && typeof result === "object" && "token" in result) {
          credentials = {
            token: (result as { token: string }).token,
            baseUrl: (result as { baseUrl?: string }).baseUrl ?? "https://ilinkai.weixin.qq.com",
          };
        }
        await bot.run();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("QR") || msg.includes("scan") || msg.includes("login")) {
          console.error(
            "[wechat] Login failed. If the stored token has expired, delete the cache:\n" +
            `  rm -rf ${config.wechat.dataDir}\n` +
            "Then restart — a new QR code will be generated.",
          );
        }
        throw new Error(`WeChat login failed: ${msg}`);
      }
    },

    stop: () => bot.stop(),

    onMessage: (handler) => {
      bot.onMessage((msg) => {
        // Capture context token for media uploads
        if (msg._contextToken) {
          contextTokens.set(msg.userId, msg._contextToken);
        }
        // Fire and forget — don't block the message pipeline while waiting
        // for slow operations like session creation or AI responses.
        // Per-user concurrency is gated by the orchestrator's `active` Set.
        handler(msg).catch((err) => {
          console.error("[wechat] Handler error:", err);
        });
      });
    },

    reply: async (msg, text) => {
      const chunks = splitMessage(text, 1800);
      for (let i = 0; i < chunks.length; i++) {
        const prefix = chunks.length > 1 ? `[${i + 1}/${chunks.length}]\n` : "";
        await bot.reply(msg, prefix + chunks[i]);
      }
    },

    sendTyping: async (userId) => {
      await bot.sendTyping(userId);
    },

    stopTyping: async (userId) => {
      await bot.stopTyping(userId);
    },

    sendImage: async (userId, filePath) => {
      if (!credentials) throw new Error("Not logged in yet");
      const contextToken = contextTokens.get(userId);
      if (!contextToken) throw new Error(`No context token for user ${userId}. Send a message first.`);

      const uploaded = await uploadToWeixinCdn({
        filePath,
        toUserId: userId,
        baseUrl: credentials.baseUrl,
        token: credentials.token,
        mediaType: UploadMediaType.IMAGE,
        label: "sendImage",
      });

      await sendImage({
        uploaded,
        toUserId: userId,
        contextToken,
        token: credentials.token,
        baseUrl: credentials.baseUrl,
      });
    },

    sendFile: async (userId, filePath, fileName) => {
      if (!credentials) throw new Error("Not logged in yet");
      const contextToken = contextTokens.get(userId);
      if (!contextToken) throw new Error(`No context token for user ${userId}. Send a message first.`);

      const name = fileName ?? filePath.split(/[/\\]/).pop() ?? "file";

      const uploaded = await uploadToWeixinCdn({
        filePath,
        toUserId: userId,
        baseUrl: credentials.baseUrl,
        token: credentials.token,
        mediaType: UploadMediaType.FILE,
        label: "sendFile",
      });

      await sendFile({
        uploaded,
        fileName: name,
        toUserId: userId,
        contextToken,
        token: credentials.token,
        baseUrl: credentials.baseUrl,
      });
    },
  };
}
