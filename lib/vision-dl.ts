/**
 * Telegram photo download — IN-MEMORY ONLY (P2T1 / P2T3, safety rule 4).
 *
 * Downloads the photo via getFile + fetch and returns the bytes as a
 * Uint8Array. No node:fs imports, no temp files, no disk writes anywhere in
 * this path; the bytes are held only for the duration of one request cycle
 * (vision call + candidate reply) and then eligible for GC. This is
 * asserted statically by tests/pii-hygiene.test.ts (zero fs usage in
 * lib/, app/, handlers/), which is the project's PII lint rule.
 */

export const TG_FILE_MAX_BYTES = 8 * 1024 * 1024;

export interface FetchedPhoto {
  bytes: Uint8Array;
  mime: string;
}

export class PhotoDownloadError extends Error {}

function mimeFromFileName(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "image/jpeg"; // Telegram photos are jpeg by default
}

/**
 * Fetch a Telegram photo into memory.
 *
 * @param botToken Bot token (only to build the file-download URL).
 * @param fileId   Photo file_id from the message (caller picks the largest
 *                 size — the best OCR surface).
 */
export async function fetchPhotoBytes(
  botToken: string,
  fileId: string,
): Promise<FetchedPhoto> {
  if (!botToken || !fileId) {
    throw new PhotoDownloadError("bot token or file id missing");
  }
  const infoRes = await fetch(
    `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`,
  );
  const info = (await infoRes.json().catch(() => null)) as
    | { ok?: boolean; result?: { file_name?: string; file_path?: string }; description?: string }
    | null;
  if (!infoRes.ok || !info?.ok || !info.result?.file_path) {
    // Bot API error text contains no image bytes; safe to surface.
    throw new PhotoDownloadError(info?.description ?? `getFile HTTP ${infoRes.status}`);
  }
  const url = `https://api.telegram.org/file/bot${botToken}/${info.result.file_path}`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new PhotoDownloadError(`photo download network error: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new PhotoDownloadError(`photo download HTTP ${res.status}`);
  }
  const contentLength = Number(res.headers.get("content-length") ?? 0);
  if (contentLength > TG_FILE_MAX_BYTES) {
    throw new PhotoDownloadError(`photo exceeds ${TG_FILE_MAX_BYTES} byte cap`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > TG_FILE_MAX_BYTES) {
    throw new PhotoDownloadError(`photo exceeds ${TG_FILE_MAX_BYTES} byte cap`);
  }
  return { bytes, mime: mimeFromFileName(info.result.file_name ?? "") };
}
