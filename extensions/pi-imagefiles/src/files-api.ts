/**
 * DeepSeek Files API client + content-addressed cache.
 *
 * Mirrors dsh's strategy (dsh-llm-deepseek):
 *   - upload images to POST /v1/files with purpose=user_data, reference them
 *     in chat requests as {"type":"file","file_id":"file-api-..."}
 *   - files live 7 days (deepseek-harness default), refresh 1h before expiry
 *   - cache keyed by sha256 so the same image uploads once per session
 *   - upload failures fall back to base64 inlining (the pre-extension
 *     behaviour) and trip a circuit breaker so a broken Files API cannot
 *     slow down every request
 */

import { createHash } from "node:crypto";
import { promises as fsp, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const FILE_EXPIRY_SECONDS = 10080 * 60; // 7 days, dsh default
export const FILE_REFRESH_MARGIN_SECONDS = 3600; // re-upload 1h before expiry
const UPLOAD_TIMEOUT_MS = 30_000;
const UPLOAD_RETRIES = 1;
const CIRCUIT_BREAKER_FAILURES = 5;
const CIRCUIT_BREAKER_COOLDOWN_MS = 60 * 60 * 1000;

export interface CacheEntry {
  fileId: string;
  bytes: number;
  mimeType: string;
  uploadedAt: number;
}

interface CacheFile {
  version: 1;
  files: Record<string, CacheEntry>; // sha256 -> entry
}

const CACHE_FILENAME = "pi-imagefiles-cache.json";

/** API key resolution: pi's auth.json first, then DEEPSEEK_API_KEY env. */
export function resolveApiKey(): string | undefined {
  try {
    const authPath = join(getAgentDir(), "auth.json");
    const auth = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, any>;
    const provider = auth["deepseek"];
    if (provider?.type === "api_key" && typeof provider.key === "string" && provider.key.length > 0) {
      return provider.key;
    }
    if (!provider) console.error(`[pi-imagefiles] auth.json has no \"deepseek\" entry (path=${authPath}, keys=${Object.keys(auth).join(",")})`);
  } catch (error) {
    console.error(`[pi-imagefiles] resolveApiKey failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const env = process.env["DEEPSEEK_API_KEY"];
  return env && env.length > 0 ? env : undefined;
}

async function upload(bytes: Uint8Array, mimeType: string, apiKey: string): Promise<string> {
  const form = new FormData();
  form.append("purpose", "user_data");
  form.append("file", new Blob([bytes as BlobPart], { type: mimeType }), "image");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.deepseek.com/v1/files", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Files API upload failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    const json = (await res.json()) as { id?: string };
    if (!json.id) throw new Error("Files API upload returned no id");
    return json.id;
  } finally {
    clearTimeout(timer);
  }
}

export class FilesApiCache {
  private data: CacheFile = { version: 1, files: {} };
  private loaded = false;
  private inflight = new Map<string, Promise<string>>();
  private failures = 0;
  private breakerDisabledUntil = 0;

  constructor(private cacheDir?: string) {}

  private get cachePath(): string {
    const base = this.cacheDir ?? join(getAgentDir(), "data");
    return join(base, CACHE_FILENAME);
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await fsp.readFile(this.cachePath, "utf8");
      const parsed = JSON.parse(raw) as CacheFile;
      if (parsed?.version === 1 && parsed.files) this.data = parsed;
    } catch {
      // missing or corrupt cache: start fresh
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    const tmp = `${this.cachePath}.tmp`;
    await fsp.mkdir(dirname(this.cachePath), { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify(this.data), "utf8");
    await fsp.rename(tmp, this.cachePath);
  }

  /** Circuit breaker: after repeated upload failures back off for an hour. */
  get breakerOpen(): boolean {
    return this.failures >= CIRCUIT_BREAKER_FAILURES && Date.now() < this.breakerDisabledUntil;
  }

  private noteUploadResult(ok: boolean): void {
    if (ok) {
      this.failures = 0;
      return;
    }
    this.failures += 1;
    if (this.failures >= CIRCUIT_BREAKER_FAILURES) {
      this.breakerDisabledUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
    }
  }

  /** sha256 of the base64 data field (the wire image payload). */
  static digest(data: string): string {
    return createHash("sha256").update(Buffer.from(data, "utf8")).digest("hex");
  }

  private isFresh(entry: CacheEntry): boolean {
    return Date.now() - entry.uploadedAt < (FILE_EXPIRY_SECONDS - FILE_REFRESH_MARGIN_SECONDS) * 1000;
  }

  /**
   * Resolve one image to a file_id. Returns undefined when the image was
   * uploaded before but expired (no usable file), or when uploads fail.
   */
  async resolve(
    data: string,
    mimeType: string,
    bytes: number,
    apiKey: string,
  ): Promise<{ fileId: string; uploaded: boolean } | undefined> {
    if (this.breakerOpen) return undefined;
    const digest = FilesApiCache.digest(data);
    await this.load();
    const cached = this.data.files[digest];
    if (cached && this.isFresh(cached)) {
      this.noteUploadResult(true);
      return { fileId: cached.fileId, uploaded: false };
    }
    const pending = this.inflight.get(digest);
    if (pending) {
      try {
        const fileId = await pending;
        return { fileId, uploaded: false };
      } catch {
        return undefined;
      }
    }
    const task = this.doUpload(digest, data, mimeType, bytes, apiKey);
    this.inflight.set(digest, task);
    try {
      const fileId = await task;
      return { fileId, uploaded: true };
    } catch {
      return undefined;
    } finally {
      this.inflight.delete(digest);
    }
  }

  private async doUpload(digest: string, data: string, mimeType: string, bytes: number, apiKey: string): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= UPLOAD_RETRIES; attempt++) {
      try {
        const fileId = await upload(Buffer.from(data, "base64"), mimeType, apiKey);
        this.data.files[digest] = { fileId, bytes, mimeType, uploadedAt: Date.now() };
        await this.save();
        this.noteUploadResult(true);
        return fileId;
      } catch (error) {
        lastError = error;
        console.error(`[pi-imagefiles] upload attempt ${attempt + 1} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.noteUploadResult(false);
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /** Drop all cached uploads (used by /imagefiles reset). */
  async resetFileIds(): Promise<void> {
    await this.load();
    this.data = { version: 1, files: {} };
    await this.save();
  }

  stats(): { count: number; totalBytes: number } {
    const files = Object.values(this.data.files);
    return {
      count: files.length,
      totalBytes: files.reduce((sum, f) => sum + (f.bytes ?? 0), 0),
    };
  }
}
