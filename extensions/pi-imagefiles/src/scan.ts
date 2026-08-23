/**
 * Request payload transformation: find inline base64 images in a
 * DeepSeek vision request, upload them to the Files API, and replace
 * them with text + {"type":"file","file_id":...} parts.
 *
 * Budgets mirror dsh-llm-deepseek defaults:
 *   maxRequestFilesBytes   128 MiB   (file-referenced image bytes)
 *   maxImagesPerRequest    600
 *   imageOffloadByteQuantum 64 MiB
 *   imageOffloadCountQuantum 20
 * Over budget: oldest images become a placeholder text (dsh's exact copy),
 * so context stays bounded no matter how long the session runs.
 */

import { parseImageSize } from "./image-size.ts";
import { FilesApiCache, resolveApiKey } from "./files-api.ts";

export const MAX_REQUEST_FILES_BYTES = 128 * 1024 * 1024;
export const MAX_IMAGES_PER_REQUEST = 600;
const BYTE_QUANTUM = 64 * 1024 * 1024;
const COUNT_QUANTUM = 20;

export const OFFLOADED_IMAGE_TEXT =
  "[image omitted to keep the request within its image limit; older images are omitted first. If this image is still needed, read its file again when a path is available; otherwise ask the user to attach it again.]";

export const DEEPSEEK_VISION_MODEL_RE = /deepseek[^"]*vision/i;

/** DeepSeek official gateway (only this host has the Files API this extension relies on). */
export const DEEPSEEK_OFFICIAL_HOST = "api.deepseek.com";

/**
 * Eligibility: the request must target the official DeepSeek gateway with a
 * vision model. Third-party providers that re-export models with similar ids
 * (e.g. gateways/proxies) are deliberately left untouched — their endpoints
 * do not serve this extension's Files API, and injecting a {"type":"file"}
 * part into a request they do not understand could fail the whole call.
 */
export function isEligible(model: { id?: string; baseUrl?: string } | undefined, payloadModel: unknown): boolean {
  const id = model?.id ?? (typeof payloadModel === "string" ? payloadModel : undefined);
  if (typeof id !== "string" || !DEEPSEEK_VISION_MODEL_RE.test(id)) return false;
  if (model?.baseUrl === undefined) return false; // no model metadata: stay inert
  return model.baseUrl.includes(DEEPSEEK_OFFICIAL_HOST);
}

interface ImageRef {
  messageIndex: number;
  blockIndex: number;
  mimeType: string;
  data: string; // base64 payload (without data: prefix)
  bytes: number; // base64 byte length (wire size)
}

function imageUrlBlock(block: any): { mimeType: string; data: string } | undefined {
  if (block?.type !== "image_url") return undefined;
  const url: unknown = block.image_url?.url;
  if (typeof url !== "string" || !url.startsWith("data:")) return undefined;
  const comma = url.indexOf(",");
  if (comma < 0) return undefined;
  const header = url.slice(5, url.indexOf(";"));
  return { mimeType: header || "image/png", data: url.slice(comma + 1) };
}

/** Collect images in request order (oldest first). */
export function collectImages(payload: any): ImageRef[] {
  const refs: ImageRef[] = [];
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const content = messages[messageIndex]?.content;
    if (!Array.isArray(content)) continue;
    for (let blockIndex = 0; blockIndex < content.length; blockIndex++) {
      const info = imageUrlBlock(content[blockIndex]);
      if (info) refs.push({ messageIndex, blockIndex, ...info, bytes: info.data.length });
    }
  }
  return refs;
}

/**
 * Decide which oldest images to replace with placeholder text, dsh-style.
 * Returns the number of images to omit (drop), never the refs themselves so
 * callers can keep the keep-list order stable.
 */
export function offloadCount(refs: ImageRef[], maxBytes = MAX_REQUEST_FILES_BYTES, maxImages = MAX_IMAGES_PER_REQUEST): number {
  const totalBytes = refs.reduce((sum, r) => sum + r.bytes, 0);
  const excessCount = Math.max(0, refs.length - maxImages);
  const excessBytes = Math.max(0, totalBytes - maxBytes);
  if (excessCount === 0 && excessBytes === 0) return 0;
  const removeCount = Math.ceil(excessCount / COUNT_QUANTUM) * COUNT_QUANTUM;
  const removeBytes = Math.ceil(excessBytes / BYTE_QUANTUM) * BYTE_QUANTUM;
  let count = 0;
  let removedBytes = 0;
  for (const ref of refs) {
    if (count >= removeCount && removedBytes >= removeBytes) break;
    removedBytes += ref.bytes;
    count += 1;
  }
  return count;
}

function handleText(sha8: string, mimeType: string, size?: { width: number; height: number }): string {
  const dims = size ? ` ${size.width}x${size.height}px` : "";
  return `Image ${sha8}; ${mimeType}${dims}.`;
}

/**
 * Transform one request payload. Returns the payload to send (possibly the
 * same object when nothing changed), plus a small stats record.
 */
export async function processPayload(
  payload: any,
  cache: FilesApiCache,
  apiKey?: string,
): Promise<{ payload: any; uploaded: number; omitted: number; failed: number }> {
  const refs = collectImages(payload);
  if (refs.length === 0) return { payload, uploaded: 0, omitted: 0, failed: 0 };

  const omit = offloadCount(refs);
  const omitted = omit;
  const key = apiKey ?? resolveApiKey();

  const resolved = new Map<number, { kind: "file"; fileId: string } | { kind: "base64" }>();
  let uploaded = 0;
  let failed = 0;

  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i];
    if (i < omit) {
      resolved.set(i, { kind: "base64" }); // placeholder replaces it below
      continue;
    }
    if (!key) {
      failed += 1;
      resolved.set(i, { kind: "base64" });
      continue;
    }
    const outcome = await cache.resolve(ref.data, ref.mimeType, ref.bytes, key);
    if (outcome) {
      if (outcome.uploaded) uploaded += 1;
      resolved.set(i, { kind: "file", fileId: outcome.fileId });
    } else {
      failed += 1;
      resolved.set(i, { kind: "base64" });
    }
  }

  // Everything already resolved: nothing to replace.
  if (resolved.size === 0) return { payload, uploaded, omitted, failed };

  const messages = payload.messages;
  const nextMessages = messages.map((message: any, messageIndex: number) => {
    const content = Array.isArray(message?.content) ? message.content : null;
    // Skip messages this request does not touch.
    const touching = refs.some((r) => r.messageIndex === messageIndex);
    if (!content || !touching) return message;
    const nextContent: any[] = [];
    for (let blockIndex = 0; blockIndex < content.length; blockIndex++) {
      const refIndex = refs.findIndex((r) => r.messageIndex === messageIndex && r.blockIndex === blockIndex);
      if (refIndex < 0) {
        nextContent.push(content[blockIndex]);
        continue;
      }
      const outcome = resolved.get(refIndex);
      const ref = refs[refIndex];
      if (!outcome || outcome.kind === "base64") {
        if (refIndex < omit) {
          nextContent.push({ type: "text", text: OFFLOADED_IMAGE_TEXT });
        } else {
          nextContent.push(content[blockIndex]); // upload failed: keep base64
        }
        continue;
      }
      const size = parseImageSize(Buffer.from(ref.data, "base64"));
      nextContent.push({
        type: "text",
        text: handleText(FilesApiCache.digest(ref.data).slice(0, 8), ref.mimeType, size),
      });
      nextContent.push({ type: "file", file_id: outcome.fileId });
    }
    return { ...message, content: nextContent };
  });

  return { payload: { ...payload, messages: nextMessages }, uploaded, omitted, failed };
}

export { FilesApiCache };
