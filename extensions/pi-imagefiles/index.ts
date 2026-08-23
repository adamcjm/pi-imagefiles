/**
 * pi-imagefiles: DeepSeek vision image offload via the Files API.
 *
 * Before every provider request, inline base64 images are uploaded to
 * DeepSeek's /v1/files and replaced with text + {"type":"file","file_id":...}
 * parts — the exact strategy dsh uses. Request bodies stay tiny regardless
 * of how many screenshots a session accumulates, so the 50 MiB gateway
 * limit can never be hit. Only deepseek *vision* models are touched; all
 * other providers/models pass through untouched.
 *
 * Commands:
 *   /imagefiles             show cache status
 *   /imagefiles reset       drop cached file_id mappings (forces re-upload)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { FilesApiCache } from "./src/files-api.ts";
import { isEligible, processPayload } from "./src/scan.ts";

export default function (pi: ExtensionAPI) {
  const cache = new FilesApiCache(join(getAgentDir(), "data"));

  pi.on("before_provider_request", async (event, ctx) => {
    try {
      const payload = event.payload as any;
      if (!payload || typeof payload !== "object") return;
      // Official DeepSeek gateway + vision model only (see isEligible).
      if (!isEligible(ctx.model as { id?: string; baseUrl?: string } | undefined, payload.model)) return;
      const result = await processPayload(payload, cache);
      return result.payload;
    } catch (error) {
      // Never block a request because of an extension bug; fall back to the
      // original payload (base64 inlining, i.e. pre-extension behaviour).
      console.error(`[pi-imagefiles] failed to process payload: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
  });

  pi.registerCommand("imagefiles", {
    description: "Show or reset the pi-imagefiles cache",
    handler: async (args, ctx) => {
      const verb = args.trim().split(/\s+/)[0];
      if (verb === "reset") {
        await cache.resetFileIds();
        ctx.ui.notify("pi-imagefiles: cached file_id mappings cleared", "info");
        return;
      }
      const stats = cache.stats();
      const breaker = cache.breakerOpen ? " — circuit breaker OPEN (Files API failing; now inlining base64)" : "";
      ctx.ui.notify(
        `pi-imagefiles: ${stats.count} images cached, ${(stats.totalBytes / 1024 / 1024).toFixed(1)} MiB total${breaker}`,
        "info",
      );
    },
  });
}
