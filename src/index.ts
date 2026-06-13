import { createOpenCodeService } from "./opencode/client.js";
import { createWeChatChannel } from "./channels/wechat/adapter.js";
import { createFeishuChannel } from "./channels/feishu/adapter.js";
import { startBridge } from "./bridge/orchestrator.js";
import { SessionStore } from "./store/session-store.js";
import { config } from "./config.js";
import type { ChannelService } from "./channels/types.js";

/** Parse --channel flag: "wechat", "feishu", or "all" (default). */
function parseChannelArg(): string {
  const idx = process.argv.indexOf("--channel");
  if (idx === -1) return "all";
  const val = process.argv[idx + 1];
  if (!val || val.startsWith("--")) return "all";
  return val.toLowerCase();
}

async function main(): Promise<void> {
  const channelArg = parseChannelArg();
  console.log(`[main] Starting agent bridge (channels: ${channelArg})...`);

  // Load persisted session mappings
  const store = new SessionStore(config.store.sessionPath);
  await store.load();

  // Start OpenCode server (shared across all channels)
  const opencode = await createOpenCodeService(store);

  // Build channel list
  const channels: ChannelService[] = [];

  if (channelArg === "wechat" || channelArg === "all") {
    channels.push(createWeChatChannel());
  }
  if (channelArg === "feishu" || channelArg === "all") {
    if (!config.channels.feishu.appId || !config.channels.feishu.appSecret) {
      console.warn("[main] ⚠️  Feishu not configured (FEISHU_APP_ID / FEISHU_APP_SECRET missing), skipping.");
    } else {
      channels.push(createFeishuChannel());
    }
  }

  if (channels.length === 0) {
    console.error("[main] No channels configured. Set env vars for at least one channel.");
    process.exit(1);
  }

  // Start each channel with its own bridge instance
  for (const channel of channels) {
    await startBridge({ channel, opencode, store });
    console.log(`[main] Bridge ready for channel: ${channel.name}`);
  }

  // Start all channels in parallel (each may block in its own event loop)
  await Promise.all(channels.map((ch) => ch.start()));
  for (const channel of channels) {
    console.log(`[main] Channel started: ${channel.name}`);
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("[main] Fatal error:", msg);

  if (msg.includes("WeChat login failed") || msg.includes("QR") || msg.includes("login")) {
    console.error(
      "\n[main] ⚠️  WeChat login issue detected.\n" +
      "To force a re-login with QR code, delete the credentials cache:\n" +
      "  Remove-Item -Recurse -Force data\\wechat\\\n" +
      "Then restart the bridge.",
    );
  }

  if (msg.includes("ECONNREFUSED") || msg.includes("OpenCode")) {
    console.error(
      "\n[main] ⚠️  Cannot connect to OpenCode.\n" +
      "Make sure OpenCode is running and accessible at the configured address.\n" +
      `Default: http://${process.env["OPENCODE_HOST"] ?? "127.0.0.1"}:${process.env["OPENCODE_PORT"] ?? "4096"}`,
    );
  }

  process.exit(1);
});
