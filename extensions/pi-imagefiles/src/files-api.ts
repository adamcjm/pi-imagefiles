/**
 * DeepSeek Files API client + content-addressed cache.
 *
 * Mirrors dsh's strategy (dsh-llm-deepseek):
 *   - upload images to POST /v1/files with purpose=user_data, reference them
 *     in chat requests as {"type":"file","file_id":"file-api-..."}
 *   - files live 30 days (the docs' maximum expires_after), refresh 1h
 *     before expiry — long enough that uploads stay rare, short enough
 *     that the 25 GiB / 10,000-file account quota cannot fill up
 *   - cache keyed by sha256 so the same image uploads once per session
 *   - upload failures fall back to base64 inlining (the pre-extension
 *     behaviour) and trip a circuit breaker so a broken Files API cannot
 *     slow down every request
 */

import { createHash } from "node:crypto";
import { promises as fsp, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const FILE_EXPIRY_SECONDS = 30 * 24 * 3600; // 30 days, docs' maximum expires_after
// docs: expires_after[seconds] ∈ [3600, 2592000]; omit = permanent, which
// would let the 25 GiB / 10,000-file quota fill up forever.
export const FILE_REFRESH_MARGIN_SECONDS = 3600; // re-upload 1h before expiry
const UPLOAD_TIMEOUT_MS = 30_000;
const UPLOAD_RETRIES = 1;
const CIRCUIT_BREAKER_FAILURES = 5;
const CIRCUIT_BREAKER_COOLDOWN_MS = 60 * 60 * 1000;
const VERIFY_INTERVAL_MS = 5 * 60 * 1000; // re-check a file_id at most every 5 min
const VERIFY_TIMEOUT_MS = 15_000;

export interface CacheEntry {
  fileId: string;
  bytes: number;
  mimeType: string;
  uploadedAt: number;
  /** Last time the file_id was confirmed to exist server-side. */
  lastVerifiedAt?: number;
}

interface CacheFile {
  version: 1;
  files: Record<string, CacheEntry>; // sha256 -> entry
}

const CACHE_FILENAME = "pi-imagefiles-cache.json";

/** Environment override for the cache directory (used by tests to keep the
 *  user's real cache untouched — the user cache must never reference
 *  files uploaded by test runs). */
export const CACHE_DIR_ENV = "PI_IMAGEFILES_CACHE_DIR";

/** Resolve the cache directory: explicit > env override > agent data dir. */
export function resolveCacheDir(explicit?: string): string {
  if (explicit) return explicit;
  const env = process.env[CACHE_DIR_ENV];
  if (env) return env;
  return join(getAgentDir(), "data");
}

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
  form.append("expires_after[anchor]", "created_at");
  form.append("expires_after[seconds]", String(FILE_EXPIRY_SECONDS));
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

/**
 * True when the file_id still exists server-side. 400/404 mean "does not
 * exist or is not created under your account" → false. Network errors and
 * 5xx are inconclusive and treated as alive (never delete a valid mapping
 * because of a transient verification failure).
 */
async function fileIdExists(fileId: string, apiKey: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.deepseek.com/v1/files/${encodeURIComponent(fileId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (res.status === 200) return true;
    if (res.status === 400 || res.status === 404) return false;
    return true; // 401/403/5xx/network: inconclusive, keep the mapping
  } catch {
    return true; // timeout/network error: inconclusive, keep the mapping
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
    const base = resolveCacheDir(this.cacheDir);
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
   *
   * Cached mappings are periodically re-verified against the Files API (at
   * most every VERIFY_INTERVAL_MS per file). A mapping whose file_id was
   * deleted server-side is dropped and the image re-uploaded transparently —
   * this is what prevents the "file_ids do not exist" 400 from repeating.
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
      const verified = await this.verifyIfStale(cached, apiKey);
      if (verified) {
        this.noteUploadResult(true);
        return { fileId: cached.fileId, uploaded: false };
      }
      // file_id vanished server-side: drop the mapping and re-upload below
      delete this.data.files[digest];
      await this.save();
      console.error(`[pi-imagefiles] cached file_id ${cached.fileId} no longer exists server-side; re-uploading`);
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

  /** Verify a fresh mapping at most once per VERIFY_INTERVAL_MS. */
  private async verifyIfStale(entry: CacheEntry, apiKey: string): Promise<boolean> {
    const last = entry.lastVerifiedAt ?? 0;
    if (Date.now() - last < VERIFY_INTERVAL_MS) return true;
    const ok = await fileIdExists(entry.fileId, apiKey);
    if (ok) {
      entry.lastVerifiedAt = Date.now();
      await this.save();
    }
    return ok;
  }

  private async doUpload(digest: string, data: string, mimeType: string, bytes: number, apiKey: string): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= UPLOAD_RETRIES; attempt++) {
      try {
        const fileId = await upload(Buffer.from(data, "base64"), mimeType, apiKey);
        this.data.files[digest] = { fileId, bytes, mimeType, uploadedAt: Date.now(), lastVerifiedAt: Date.now() };
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
