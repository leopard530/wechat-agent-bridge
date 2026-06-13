/**
 * WeChat media message builders (image, file, video).
 * Sends media via iLink sendMessage endpoint with CDN-uploaded references.
 * Standalone — no weixin-bot internal imports.
 */

import { randomUUID } from "node:crypto";
import type { UploadedFileInfo } from "./cdn/upload.js";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const ChannelVersion = "1.0.0";

interface SendOptions {
  baseUrl: string;
  token: string;
  toUserId: string;
  contextToken: string;
}

const MEDIA_SEND_RETRIES = 3;
const MEDIA_SEND_RETRY_DELAY_MS = 2_000;

async function apiPost(
  baseUrl: string,
  endpoint: string,
  body: unknown,
  token: string,
  timeoutMs = 15_000,
): Promise<void> {
  const url = new URL(endpoint, baseUrl.endsWith("/") ? baseUrl : baseUrl + "/");

  let lastError: unknown;

  for (let attempt = 1; attempt <= MEDIA_SEND_RETRIES; attempt++) {
    try {
      const res = await fetch(url.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          AuthorizationType: "ilink_bot_token",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const text = await res.text();
        // 4xx client errors are not retryable
        if (res.status >= 400 && res.status < 500) {
          throw new Error(`iLink ${endpoint} failed: ${res.status} ${text}`);
        }
        throw new Error(`iLink ${endpoint} server error: ${res.status} ${text}`);
      }
      return; // success
    } catch (err) {
      lastError = err;
      // Don't retry client errors (4xx)
      if (err instanceof Error && err.message.includes("failed:") && !err.message.includes("server error:")) {
        throw err;
      }
      if (attempt < MEDIA_SEND_RETRIES) {
        console.warn(`[media] ${endpoint} attempt ${attempt} failed, retrying in ${MEDIA_SEND_RETRY_DELAY_MS}ms:`, err instanceof Error ? err.message : String(err));
        await new Promise((r) => setTimeout(r, MEDIA_SEND_RETRY_DELAY_MS));
      }
    }
  }

  throw lastError ?? new Error(`iLink ${endpoint} failed after ${MEDIA_SEND_RETRIES} retries`);
}

async function sendMediaItem(
  opts: SendOptions,
  item: Record<string, unknown>,
  label: string,
): Promise<string> {
  const clientId = randomUUID();
  const body = {
    msg: {
      from_user_id: "",
      to_user_id: opts.toUserId,
      client_id: clientId,
      message_type: 2,
      message_state: 2,
      context_token: opts.contextToken,
      item_list: [item],
    },
    base_info: { channel_version: ChannelVersion },
  };
  await apiPost(opts.baseUrl, "/ilink/bot/sendmessage", body, opts.token);
  console.log(`[media] ${label}: sent to ${opts.toUserId.slice(0, 12)}...`);
  return clientId;
}

/**
 * Send an image to a WeChat user. The image must already be uploaded to CDN.
 */
export async function sendImage(params: {
  uploaded: UploadedFileInfo;
  toUserId: string;
  contextToken: string;
  token: string;
  baseUrl: string;
}): Promise<string> {
  const { uploaded, toUserId, contextToken, token, baseUrl } = params;

  const imageItem = {
    type: 2, // IMAGE
    image_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      mid_size: uploaded.fileSizeCiphertext,
    },
  };

  return sendMediaItem(
    { toUserId, contextToken, token, baseUrl },
    imageItem,
    "sendImage",
  );
}

/**
 * Send a file attachment to a WeChat user. The file must already be uploaded to CDN.
 */
export async function sendFile(params: {
  uploaded: UploadedFileInfo;
  fileName: string;
  toUserId: string;
  contextToken: string;
  token: string;
  baseUrl: string;
}): Promise<string> {
  const { uploaded, fileName, toUserId, contextToken, token, baseUrl } = params;

  const fileItem = {
    type: 4, // FILE
    file_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      file_name: fileName,
      len: String(uploaded.fileSize),
    },
  };

  return sendMediaItem(
    { toUserId, contextToken, token, baseUrl },
    fileItem,
    "sendFile",
  );
}
