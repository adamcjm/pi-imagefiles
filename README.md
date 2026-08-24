# pi-imagefiles

**English** · [中文](https://github.com/adamcjm/pi-imagefiles/blob/main/README.zh-CN.md)

**Adapted for DeepSeek vision models** — `deepseek-v4-flash-vision-exp` (and any `deepseek*vision*` model id). Uploads images to the **DeepSeek Files API** and references them by `file_id` in vision requests; third-party DeepSeek vision gateways get the same safety net via request trimming.

## The problem it solves

Pi sends every screenshot as inline `data:image/...;base64,...` in the provider request. **DeepSeek's API gateway rejects requests larger than 48 MiB** (50,331,648 bytes — `413 Request Entity Too Large`; measured: 47.9 MiB passes, 48.0 MiB fails). A long vision session — tens of screenshots at up to 4.5 MB of base64 each — eventually exceeds that limit, and the session can never continue.

`pi-imagefiles` removes that ceiling:

- **Official DeepSeek gateway** (`api.deepseek.com`): images are uploaded to the Files API and referenced by `file_id` — ~200 bytes on the wire per image instead of ~4.5 MB, so request size barely grows no matter how many images a session accumulates.
- **Third-party DeepSeek vision gateways** (e.g. opencode zen/go, which re-export `deepseek-v4-flash-vision-exp` but have **no Files API** — `GET /v1/files` → 404 — and **do not accept your `file_id`**: they call the upstream DeepSeek gateway with *their own* API key, and file_ids are bound to the key that uploaded them, so the upstream answers `file_ids do not exist or are not created under your account`; verified live, base64 images do pass through): the extension trims the *oldest* images once the inline budget is exceeded, so the request never crosses the upstream 48 MiB limit.

## How it works

Same pipeline as `dsh` (deepseek-harness); budgets calibrated against the official docs:

1. **Recognize** — request mode is chosen by model id + baseUrl (see matrix below). Anything else passes through untouched.
2. **Upload** (official only) — images are uploaded to `POST /v1/files` (`purpose=user_data`), then each image block becomes `[{"type":"text","text":"Image <sha8>; image/png WxHpx."},{"type":"file","file_id":"file-api-..."}]` — the wire format the DeepSeek chat-completions API accepts.
3. **Cache** (official only) — content-addressed by sha256 in `~/.pi/agent/data/pi-imagefiles-cache.json`; the same image uploads once and is reused across requests and sessions. Files are uploaded with `expires_after=30 days` (the docs' maximum), refreshed 1 hour before expiry — long enough that uploads stay rare, short enough that the 25 GiB / 10,000-file account quota cannot fill up.
4. **Budget / offload** (all modes) — **128 MiB** of image bytes and **600 images** per request in `upload` mode (docs cap requests containing `file_id`s at 200 MiB), **40 MiB** of inline bytes in `offload-only` mode (images stay base64 there, so the 48 MiB request-body limit is what matters); over budget the *oldest* images are replaced with a placeholder text that carries the **parsed image facts** (mime type, dimensions from the PNG/JPEG/WebP/GIF header, sha256), in deterministic quanta (64 MiB / 20 images). The model already saw and understood those images earlier in the conversation, so it can rely on that understanding.
5. **Fallback** (official only) — if the Files API fails, that image stays inline base64. After 5 consecutive upload failures a circuit breaker inlines everything for an hour so a broken Files API cannot slow down every request.
6. **Liveness check** (official only) — cached `file_id` mappings are re-verified against the Files API (at most every 5 minutes per file). A mapping whose file was deleted server-side (`file_id does not exist or is not created under your account` → 400) is dropped and the image re-uploaded transparently, so a stale reference can never wedge a session. Network/5xx verification errors are treated as inconclusive and never delete a valid mapping.

## Mode matrix

| Request target | Model id | Mode | Upload + file_id | Offload trimming |
|---|---|---|---|---|
| `api.deepseek.com` | `deepseek-v4-flash-vision-exp` / `deepseek*vision*` | `upload` | ✅ | ✅ |
| Third-party gateway (e.g. `opencode.ai/zen/go/v1`) | `deepseek*vision*` | `offload-only` | ❌ (no Files API) | ✅ |
| Any other provider | anything | `none` | ❌ | ❌ |

Verified against the live API: uploading a 5.6 MB screenshot and referencing it by `file_id` returns a correct model answer, and that image costs ~200 bytes on the wire. For opencode zen/go: base64 images work and 2.4 MB→38.5 MB bodies pass, but 48.1 MB fails with the upstream 413 — the same wall the offload trims avoid; `file_id` references are rejected upstream (`not created under your account`) because the gateway forwards with its own key.

## Install

```bash
pi install pi-imagefiles
```

`pi-imagefiles` needs the DeepSeek API key: it reads `~/.pi/agent/auth.json` (`deepseek`) like pi does, falling back to the `DEEPSEEK_API_KEY` environment variable.

## Usage

Nothing to do — the hook is active automatically for DeepSeek vision models.

| Command | Effect |
|---|---|
| `/imagefiles` | Show cache stats (uploaded images, total bytes) |
| `/imagefiles reset` | Drop cached `file_id` mappings (forces re-upload) |

## Policies

| Setting | Default |
|---|---|
| `purpose` | `user_data` |
| File lifetime / refresh margin | 30 days / 1 h |
| Max image bytes per request (upload mode) | 128 MiB |
| Max inline bytes per request (offload-only mode) | 40 MiB |
| Max images per request | 600 |
| Offload byte / count quantum | 64 MiB / 20 |
| Upload timeout / retries | 30 s / 1 |
| Circuit breaker | 5 failures → 1 h backoff |

## Development

```bash
bun run test/run-tests.ts   # unit self-check, no network
PI_IMAGEFILES_CACHE_DIR=/tmp/pi-imagefiles-it bun run test/integration.ts <png>  # real API
```

Integration runs use an **isolated cache directory** (`PI_IMAGEFILES_CACHE_DIR`)
so test uploads never pollute the user's real cache — and test files are
deleted server-side afterwards. Never run integration tests against the real
cache: a file deleted server-side while the session still references it is
exactly the stale `file_id` 400 this extension protects against.

## Notes

- The image handle text carries the image's dimensions (parsed from PNG/JPEG/WebP/GIF headers) so the model understands the coordinate mapping.
- `offload-only` mode never touches the network: no uploads, no cache writes, purely a deterministic trim of the request body.
- Images uploaded through this extension are deleted from the cache only by `/imagefiles reset`; the Files API side expires them after 30 days.
- Non-DeepSeek providers are never touched — if you use another vision provider, the extension stays inert.

## License

MIT
