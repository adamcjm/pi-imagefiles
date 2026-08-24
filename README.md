# pi-imagefiles

**Adapted for DeepSeek vision models** — `deepseek-v4-flash-vision-exp` (and any `deepseek*vision*` model id). Uploads images to the **DeepSeek Files API** and references them by `file_id` in vision requests; third-party DeepSeek vision gateways get the same safety net via request trimming.

## The problem it solves

Pi sends every screenshot as inline `data:image/...;base64,...` in the provider request. **DeepSeek's API gateway rejects requests larger than 50 MB** (`413 Request Entity Too Large` — measured at 50,000,000 bytes: 47.9 MB passes, 48.0 MB fails). A long vision session — tens of screenshots at up to 4.5 MB of base64 each — eventually exceeds that limit, and the session can never continue.

`pi-imagefiles` removes that ceiling:

- **Official DeepSeek gateway** (`api.deepseek.com`): images are uploaded to the Files API and referenced by `file_id` — ~200 bytes on the wire per image instead of ~4.5 MB, so request size barely grows no matter how many images a session accumulates.
- **Third-party DeepSeek vision gateways** (e.g. opencode zen/go, which re-export `deepseek-v4-flash-vision-exp` but have **no Files API** — verified `GET/POST /v1/files` → 404 — and enforce the same upstream ~50 MB limit): the extension trims the *oldest* images once the budget is exceeded, so the request never crosses the gateway limit.

## How it works

Same pipeline and budgets as `dsh` (deepseek-harness):

1. **Recognize** — request mode is chosen by model id + baseUrl (see matrix below). Anything else passes through untouched.
2. **Upload** (official only) — images are uploaded to `POST /v1/files` (`purpose=user_data`), then each image block becomes `[{"type":"text","text":"Image <sha8>; image/png WxHpx."},{"type":"file","file_id":"file-api-..."}]` — the wire format the DeepSeek chat-completions API accepts.
3. **Cache** (official only) — content-addressed by sha256 in `~/.pi/agent/data/pi-imagefiles-cache.json`; the same image uploads once and is reused across requests and sessions. Files live **7 days** (dsh's default), refreshed 1 hour before expiry.
4. **Budget / offload** (all modes) — dsh defaults: **128 MiB** of image bytes and **600 images** per request; over budget the *oldest* images are replaced with a placeholder text that carries the **parsed image facts** (mime type, dimensions from the PNG/JPEG/WebP/GIF header, sha256), in deterministic quanta (64 MiB / 20 images). The model already saw and understood those images earlier in the conversation, so it can rely on that understanding.
5. **Fallback** (official only) — if the Files API fails, that image stays inline base64. After 5 consecutive upload failures a circuit breaker inlines everything for an hour so a broken Files API cannot slow down every request.
6. **Liveness check** (official only) — cached `file_id` mappings are re-verified against the Files API (at most every 5 minutes per file). A mapping whose file was deleted server-side (`file_id does not exist or is not created under your account` → 400) is dropped and the image re-uploaded transparently, so a stale reference can never wedge a session. Network/5xx verification errors are treated as inconclusive and never delete a valid mapping.

## Mode matrix

| Request target | Model id | Mode | Upload + file_id | Offload trimming |
|---|---|---|---|---|
| `api.deepseek.com` | `deepseek-v4-flash-vision-exp` / `deepseek*vision*` | `upload` | ✅ | ✅ |
| Third-party gateway (e.g. `opencode.ai/zen/go/v1`) | `deepseek*vision*` | `offload-only` | ❌ (no Files API) | ✅ |
| Any other provider | anything | `none` | ❌ | ❌ |

Verified against the live API: uploading a 5.6 MB screenshot and referencing it by `file_id` returns a correct model answer, and that image costs ~200 bytes on the wire. For opencode zen/go, 2.4 MB→38.5 MB bodies pass but 48.1 MB fails with the upstream 413 — the same wall the offload trims avoid.

## Install

```bash
# from npm
pi install pi-imagefiles

# or local dev link
ln -s ~/pi/dev/pi-imagefiles/extensions/pi-imagefiles ~/.pi/agent/extensions/pi-imagefiles
```

`pi-imagefiles` needs the DeepSeek API key: it reads `~/.pi/agent/auth.json` (`deepseek`) like pi does, falling back to the `DEEPSEEK_API_KEY` environment variable.

## Usage

Nothing to do — the hook is active automatically for DeepSeek vision models.

| Command | Effect |
|---|---|
| `/imagefiles` | Show cache stats (uploaded images, total bytes) |
| `/imagefiles reset` | Drop cached `file_id` mappings (forces re-upload) |

## Policies (dsh parity)

| Setting | Default |
|---|---|
| `purpose` | `user_data` |
| File lifetime / refresh margin | 7 days / 1 h |
| Max image bytes per request | 128 MiB |
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
- Images uploaded through this extension are deleted from the cache only by `/imagefiles reset`; the Files API side expires them after 7 days.
- Non-DeepSeek providers are never touched — if you use another vision provider, the extension stays inert.

## License

MIT
