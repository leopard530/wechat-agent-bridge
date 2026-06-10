import { createOpenCodeService } from "./opencode/client.js";
import { createWeChatService } from "./wechat/bot.js";
import { startBridge } from "./bridge/orchestrator.js";
import { SessionStore } from "./store/session-store.js";
import { config } from "./config.js";

async function main(): Promise<void> {
  console.log("[main] Starting WeChat-OpenCode Bridge...");

  // Load persisted session mappings
  const store = new SessionStore(config.store.sessionPath);
  await store.load();

  // Start OpenCode server
  const opencode = await createOpenCodeService(store);

  // Start WeChat bot (will prompt QR login on first run)
  const wechat = createWeChatService();

  // Connect them
  await startBridge({ wechat, opencode, store });

  // Start WeChat polling
  await wechat.start();
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
