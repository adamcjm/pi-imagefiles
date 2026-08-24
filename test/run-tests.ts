/**
 * pi-imagefiles self-check: run with `bun run test/run-tests.ts`.
 * Covers payload scanning, dsh-style offload budgeting, replacement
 * format, upload-failure fallback, and image-size parsing. No network.
 */
import assert from "node:assert";
import { collectImages, offloadCount, processPayload, resolveMode, DEEPSEEK_VISION_MODEL_RE } from "../extensions/pi-imagefiles/src/scan.ts";
import { parseImageSize } from "../extensions/pi-imagefiles/src/image-size.ts";
import { FilesApiCache, FILE_EXPIRY_SECONDS } from "../extensions/pi-imagefiles/src/files-api.ts";

function pngBytes(w: number, h: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(16, w);
  dv.setUint32(20, h);
  return bytes;
}

function makePayload(images: string[], model = "deepseek-v4-flash-vision-exp") {
  const content: any[] = [{ type: "text", text: "look" }];
  for (const data of images) content.push({ type: "image_url", image_url: { url: `data:image/png;base64,${data}` } });
  return {
    model,
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "user", content },
      { role: "assistant", content: "ok" },
    ],
    stream: true,
  };
}

/** In-memory cache that "uploads" without network. */
class FakeCache extends FilesApiCache {
  uploaded: string[] = [];
  fail = false;
  constructor() {
    super("/tmp/pi-imagefiles-test-cache");
  }
  override async resolve(data: string, mimeType: string, bytes: number, _apiKey: string) {
    if (this.fail) return undefined;
    const id = `file-api-fake-${this.uploaded.length}`;
    this.uploaded.push(data);
    return { fileId: id, uploaded: true };
  }
}

// --- 1. model gate ---------------------------------------------------------
assert.ok(DEEPSEEK_VISION_MODEL_RE.test("deepseek-v4-flash-vision-exp"), "vision model matches");
assert.ok(!DEEPSEEK_VISION_MODEL_RE.test("deepseek-v4-pro"), "pro model does not match");
assert.ok(!DEEPSEEK_VISION_MODEL_RE.test("gpt-4o"), "other providers do not match");

// --- 1b. resolveMode --------------------------------------------------------
const official = { id: "deepseek-v4-flash-vision-exp", baseUrl: "https://api.deepseek.com" };
assert.equal(resolveMode(official, "deepseek-v4-flash-vision-exp"), "upload", "official deepseek vision model → upload");
// third-party gateway re-exporting the same model id (e.g. opencode zen/go)
const thirdParty = { id: "deepseek-v4-flash-vision-exp", baseUrl: "https://opencode.ai/zen/go/v1" };
assert.equal(resolveMode(thirdParty, "deepseek-v4-flash-vision-exp"), "offload-only", "third-party gateway → offload-only");
// official host, text model
assert.equal(resolveMode({ id: "deepseek-v4-pro", baseUrl: "https://api.deepseek.com" }, "deepseek-v4-pro"), "none", "official text model → none");
// no model metadata (ctx.model missing) but vision payload model: still trim
assert.equal(resolveMode(undefined, "deepseek-v4-flash-vision-exp"), "offload-only", "missing metadata → offload-only (safe trim)");
// non-deepseek model
assert.equal(resolveMode({ id: "gpt-4o", baseUrl: "https://api.openai.com/v1" }, "gpt-4o"), "none", "other providers → none");
console.log("ok resolveMode");

// --- 2. collectImages ------------------------------------------------------
const payload = makePayload(["AAA", "BBB"]);
const refs = collectImages(payload);
assert.equal(refs.length, 2, "finds two images");
assert.equal(refs[0].data, "AAA");
assert.equal(refs[1].messageIndex, 1);
assert.equal(refs[1].blockIndex, 2, "image block index after text block");
assert.equal(collectImages({ messages: [{ role: "assistant", content: "no images" }] }).length, 0);
console.log("ok collectImages");

// --- 3. offload budget (dsh semantics) ------------------------------------
const mb = 1024 * 1024;
// 150 MiB total vs 128 MiB budget -> remove in 64 MiB quanta: 2 oldest images
const bigRefs = [1, 2, 3].map((n) => ({ messageIndex: 0, blockIndex: n, mimeType: "image/png", data: "x", bytes: 50 * mb }));
assert.equal(offloadCount(bigRefs), 2, "150 MiB / 128 MiB budget drops 2 in 64 MiB quanta (dsh semantics)");
// 600 images budget
const manyRefs = Array.from({ length: 605 }, (_, i) => ({ messageIndex: 0, blockIndex: i, mimeType: "image/png", data: "x", bytes: 1000 }));
assert.equal(offloadCount(manyRefs), 20, "605 images / 600 budget drops 20 (count quantum)");
// under budget
const smallRefs = [{ messageIndex: 0, blockIndex: 1, mimeType: "image/png", data: "x", bytes: 1024 }];
assert.equal(offloadCount(smallRefs), 0, "under budget keeps everything");
console.log("ok offloadCount");

// --- 4. processPayload replacement ----------------------------------------
const fake = new FakeCache();
const imgData = Buffer.from(pngBytes(2000, 1000)).toString("base64");
const result = await processPayload(makePayload([imgData]), fake, { mode: "upload", apiKey: "sk-test" });
assert.ok(result.payload !== payload, "payload replaced");
const userMsg = result.payload.messages[1];
assert.equal(userMsg.content.length, 3, "text + handle-text + file");
assert.equal(userMsg.content[1].type, "text", "handle text first");
assert.match(userMsg.content[1].text, /^Image [0-9a-f]{8}; image\/png 2000x1000px\.$/, "handle carries dims");
assert.equal(userMsg.content[2].type, "file", "file part second");
assert.match(userMsg.content[2].file_id, /^file-api-fake-0$/, "file_id from upload");
assert.equal(result.uploaded, 1);
assert.equal(result.omitted, 0);
console.log("ok replacement:", JSON.stringify(userMsg.content.slice(1, 3)));

// --- 5. offload replacement in stream -------------------------------------
const bigFake = new FakeCache();
const lots = Array.from({ length: 620 }, () => Buffer.from(pngBytes(1, 1)).toString("base64"));
const bigResult = await processPayload(makePayload(lots), bigFake, { mode: "upload", apiKey: "sk-test" });
const bigUser = bigResult.payload.messages[1];
const textBlocks = bigUser.content.filter((b: any) => b.type === "text");
const fileBlocks = bigUser.content.filter((b: any) => b.type === "file");
assert.ok(textBlocks.some((b: any) => b.text.startsWith("[image omitted")), "oldest images become the dsh placeholder");
assert.ok(fileBlocks.length <= 600, "file parts within image budget");
console.log(`ok offload: ${textBlocks.length} texts, ${fileBlocks.length} files`);

// --- 5b. offload placeholder carries parsed image facts --------------------
const offloaded = textBlocks.find((b: any) => b.text.startsWith("[image omitted"));
assert.ok(offloaded, "offload placeholder present");
assert.match(offloaded.text, /image\/png 1x1px \(sha256 [0-9a-f]{8}\)/, "placeholder carries mime + dims + sha256");
console.log("ok offload placeholder:", offloaded.text.slice(0, 90) + "...");

// --- 5c. offload-only mode (third-party gateway, e.g. opencode zen/go) ----
const thirdFake = new FakeCache();
const thirdPayload = makePayload(Array.from({ length: 620 }, () => Buffer.from(pngBytes(1, 1)).toString("base64")));
const thirdResult = await processPayload(thirdPayload, thirdFake, { mode: "offload-only" });
assert.equal(thirdResult.uploaded, 0, "offload-only: no uploads");
assert.equal(thirdFake.uploaded.length, 0, "offload-only: cache never touched");
const thirdUser = thirdResult.payload.messages[1];
assert.equal(thirdUser.content.filter((b: any) => b.type === "file").length, 0, "offload-only: no file parts injected");
assert.equal(thirdUser.content.filter((b: any) => b.type === "image_url").length + thirdUser.content.filter((b: any) => b.type === "text").length, 620 + 1, "offload-only: kept images stay inline");
assert.ok(thirdResult.omitted >= 20, "offload-only still trims oldest images");
console.log(`ok offload-only: omitted=${thirdResult.omitted}, uploaded=0`);

// --- 6. upload failure keeps base64 ----------------------------------------
const failFake = new FakeCache();
failFake.fail = true;
const failResult = await processPayload(makePayload([imgData]), failFake, { mode: "upload", apiKey: "sk-test" });
assert.equal(failResult.failed, 1, "no fileId when upload fails");
assert.equal(failResult.payload.messages[1].content[1].type, "image_url", "base64 kept on failure");
console.log("ok fallback");

// --- 7. image-size parsing -------------------------------------------------
assert.deepEqual(parseImageSize(pngBytes(1920, 1080)), { width: 1920, height: 1080 }, "PNG dims");
assert.equal(parseImageSize(new Uint8Array([1, 2, 3])), undefined, "garbage");
// JPEG with SOF0
const jpeg = new Uint8Array(40);
jpeg.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
const sof = new DataView(jpeg.buffer);
sof.setUint8(20, 0xff); sof.setUint8(21, 0xc0); // SOF0
sof.setUint16(22, 17); // segment length
sof.setUint16(25, 240); // height
sof.setUint16(27, 320); // width
assert.deepEqual(parseImageSize(jpeg), { width: 320, height: 240 }, "JPEG dims");
console.log("ok parseImageSize");

// --- 8. cache expiry -------------------------------------------------------
assert.equal(FILE_EXPIRY_SECONDS, 7 * 24 * 3600, "expiry is 7 days");
console.log("ok cache constants");

console.log("\nALL TESTS PASSED");

