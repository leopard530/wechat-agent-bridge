/**
 * CDN upload pipeline: file → AES-128-ECB encrypt → POST to Weixin CDN.
 * Adapted from @tencent-weixin/openclaw-weixin (MIT).
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";

import { encryptAesEcb, aesEcbPaddedSize } from "./aes-ecb.js";
import { buildCdnUploadUrl } from "./cdn-url.js";

const UPLOAD_MAX_RETRIES = 3;

export const UploadMediaType = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
} as const;
export type UploadMediaType = (typeof UploadMediaType)[keyof typeof UploadMediaType];

export interface UploadedFileInfo {
  filekey: string;
  downloadEncryptedQueryParam: string;
  aeskey: string;
  fileSize: number;
  fileSizeCiphertext: number;
}

/** POST ciphertext to CDN, retrying on server errors. */
async function uploadBufferToCdn(params: {
  buf: Buffer;
  cdnUrl: string;
  aeskey: Buffer;
  label: string;
}): Promise<string> {
  const { buf, cdnUrl, aeskey, label } = params;
  const ciphertext = encryptAesEcb(buf, aeskey);

  let lastError: unknown;
  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(cdnUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
      });

      if (res.status >= 400 && res.status < 500) {
        const errMsg = res.headers.get("x-error-message") ?? (await res.text());
        throw new Error(`CDN client error ${res.status}: ${errMsg}`);
      }
      if (res.status !== 200) {
        throw new Error(`CDN server error ${res.status}`);
      }

      const downloadParam = res.headers.get("x-encrypted-param");
      if (!downloadParam) {
        throw new Error("CDN response missing x-encrypted-param header");
      }
      return downloadParam;
    } catch (err) {
      lastError = err;
      if (err instanceof Error && err.message.includes("client error")) throw err;
      if (attempt >= UPLOAD_MAX_RETRIES) throw err;
      console.warn(`[cdn] upload attempt ${attempt} failed, retrying...`);
    }
  }
  throw lastError ?? new Error("CDN upload failed");
}

/** Get a pre-signed CDN upload URL from iLink API. */
export interface GetUploadUrlParams {
  baseUrl: string;
  token: string;
  filekey: string;
  mediaType: UploadMediaType;
  toUserId: string;
  rawSize: number;
  rawMd5: string;
  fileSize: number;
  aeskey: string;
}

export interface GetUploadUrlResponse {
  upload_full_url?: string;
  upload_param?: string;
}

export async function getUploadUrl(params: GetUploadUrlParams): Promise<GetUploadUrlResponse> {
  const { baseUrl, token, ...body } = params;
  const url = new URL("ilink/bot/getuploadurl", baseUrl.endsWith("/") ? baseUrl : baseUrl + "/");

  let lastError: unknown;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          AuthorizationType: "ilink_bot_token",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          filekey: body.filekey,
          media_type: body.mediaType,
          to_user_id: body.toUserId,
          rawsize: body.rawSize,
          rawfilemd5: body.rawMd5,
          filesize: body.fileSize,
          no_need_thumb: true,
          aeskey: body.aeskey,
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`getUploadUrl failed: ${res.status} ${text}`);
      }
      const rawText = await res.text();
      console.log(`[cdn] getUploadUrl raw response:`, rawText.slice(0, 500));
      return JSON.parse(rawText) as GetUploadUrlResponse;
    } catch (err) {
      lastError = err;
      if (attempt < 3) {
        const wait = 1_000 * attempt;
        console.warn(`[cdn] getUploadUrl attempt ${attempt} failed, retrying in ${wait}ms:`, err instanceof Error ? err.message : String(err));
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  throw lastError ?? new Error("getUploadUrl failed after 3 retries");
}

/**
 * Full upload pipeline: read file → getUploadUrl → encrypt → PUT CDN → return info.
 */
export async function uploadToWeixinCdn(params: {
  filePath: string;
  toUserId: string;
  baseUrl: string;
  token: string;
  mediaType: UploadMediaType;
  label: string;
}): Promise<UploadedFileInfo> {
  const { filePath, toUserId, baseUrl, token, mediaType, label } = params;

  const plaintext = await fs.readFile(filePath);
  const rawSize = plaintext.length;
  const rawMd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const fileSize = aesEcbPaddedSize(rawSize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);

  console.log(`[cdn] ${label}: file=${filePath} rawSize=${rawSize} fileSize=${fileSize}`);

  const uploadResp = await getUploadUrl({
    baseUrl,
    token,
    filekey,
    mediaType,
    toUserId,
    rawSize,
    rawMd5: rawMd5,
    fileSize,
    aeskey: aeskey.toString("hex"),
  });

  console.log(
    `[cdn] getUploadUrl response: upload_full_url=${uploadResp.upload_full_url?.slice(0, 80)}... upload_param=${uploadResp.upload_param?.slice(0, 40)}...`,
  );

  const cdnUrl =
    uploadResp.upload_full_url?.trim() ||
    buildCdnUploadUrl(uploadResp.upload_param!, filekey);

  if (!cdnUrl) {
    throw new Error(`${label}: getUploadUrl returned no upload URL\n` +
      `upload_full_url: ${uploadResp.upload_full_url ?? "(none)"}\n` +
      `upload_param: ${uploadResp.upload_param ?? "(none)"}`);
  }

  console.log(`[cdn] CDN upload URL: ${cdnUrl.slice(0, 120)}...`);

  const downloadEncryptedQueryParam = await uploadBufferToCdn({
    buf: plaintext,
    cdnUrl,
    aeskey,
    label: `${label}[${filekey}]`,
  });

  console.log(`[cdn] ${label}: upload success`);

  return {
    filekey,
    downloadEncryptedQueryParam,
    aeskey: aeskey.toString("hex"),
    fileSize: rawSize,
    fileSizeCiphertext: fileSize,
  };
}
