/**
 * Integration check against the real DeepSeek Files API (needs a valid key
 * in ~/.pi/agent/auth.json). Uses an ISOLATED cache directory, so test
 * uploads never pollute the user's real cache — the failure mode that once
 * wedged a session with a deleted file_id is explicitly covered here.
 *
 *   PI_IMAGEFILES_CACHE_DIR=/tmp/pi-imagefiles-it bun run test/integration.ts
 *
 * Steps: upload → DELETE server-side file (simulating the stale-file 400) →
 * resolve again → stale mapping dropped + transparent re-upload.
 */
import { FilesApiCache } from "../extensions/pi-imagefiles/src/files-api.ts";
import { readFileSync, existsSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { join } from "node:path";

const HOME = process.env.HOME ?? "/Users/adam";
const authPath = join(HOME, ".pi", "agent", "auth.json");
if (!existsSync(authPath)) {
  console.error("integration test needs ~/.pi/agent/auth.json");
  process.exit(1);
}
const KEY = JSON.parse(readFileSync(authPath, "utf8")).deepseek.key;
const dir = process.env.PI_IMAGEFILES_CACHE_DIR ?? "/tmp/pi-imagefiles-integration-cache";
await fsp.rm(dir, { recursive: true, force: true });

const imgPath = process.argv[2];
if (!existsSync(imgPath ?? "")) {
  console.error("usage: bun run test/integration.ts <png-path>");
  process.exit(1);
}
const imgB64 = readFileSync(imgPath).toString("base64");
const cache = new FilesApiCache(dir);
await cache.load();

// 1. first upload
const r1 = await cache.resolve(imgB64, "image/png", imgB64.length, KEY);
console.log("1. first resolve:", r1?.fileId, "| uploaded:", r1?.uploaded);
if (!r1) throw new Error("first upload failed");

// 2. simulate server-side deletion (the stale-file 400 scenario)
const del = await fetch(`https://api.deepseek.com/v1/files/${encodeURIComponent(r1.fileId)}`, {
  method: "DELETE",
  headers: { Authorization: `Bearer ${KEY}` },
});
console.log("2. DELETE server-side file:", del.status);

// 3. force re-verification, reload, resolve again
const cachePath = join(dir, "pi-imagefiles-cache.json");
const data = JSON.parse(await fsp.readFile(cachePath, "utf8"));
for (const e of Object.values(data.files) as any[]) e.lastVerifiedAt = 0;
await fsp.writeFile(cachePath, JSON.stringify(data));
const cache2 = new FilesApiCache(dir);
await cache2.load();

const r2 = await cache2.resolve(imgB64, "image/png", imgB64.length, KEY);
console.log("4. resolve after deletion:", r2?.fileId, "| uploaded:", r2?.uploaded, "| new id:", r2?.fileId !== r1.fileId);
if (!r2 || r2.fileId === r1.fileId) throw new Error("stale file_id was not re-uploaded");

// 5. cleanup: delete the re-uploaded file AND the isolated cache dir
await fetch(`https://api.deepseek.com/v1/files/${encodeURIComponent(r2.fileId)}`, {
  method: "DELETE",
  headers: { Authorization: `Bearer ${KEY}` },
});
await fsp.rm(dir, { recursive: true, force: true });

console.log("\nINTEGRATION PASSED (isolated cache, no user-cache pollution)");
