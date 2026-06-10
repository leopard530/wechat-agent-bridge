/**
 * CDN URL construction for Weixin CDN upload/download.
 * Copied from @tencent-weixin/openclaw-weixin (MIT).
 */

export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

export function buildCdnDownloadUrl(encryptedQueryParam: string): string {
  return `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

export function buildCdnUploadUrl(uploadParam: string, filekey: string): string {
  return `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}
