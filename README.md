# pi-imagefiles

Upload images to the **DeepSeek Files API** and reference them by `file_id` in vision requests, keeping provider request bodies tiny. The same strategy `dsh` uses, built as a pi extension.

## Why

Pi sends every screenshot as inline `data:image/...;base64,...` in the provider request. DeepSeek's API gateway rejects requests larger than 50 MB (`413 Request Entity Too Large`), and a long vision session — tens of screenshots at up to 4.5 MB of base64 each — hits that limit and the session can never continue.

`pi-imagefiles` replaces each inline image with a short text handle plus a `{"type": "file", "file_id": "..."}` part (an extra ~200 bytes per image instead of ~4.5 MB), so request size barely grows no matter how many images a session accumulates.

## How it works

Identical pipeline and budgets to `dsh` (deepseek-harness):

1. **Upload** — before each provider request, images are uploaded to `POST /v1/files` (`purpose=user_data`). Only **DeepSeek vision models** (`deepseek-v4-flash-vision-exp` and any `deepseek*vision*` model id) are touched; every other provider/model passes through untouched.
2. **Reference** — each image block becomes `[{"type":"text","text":"Image <sha8>; image/png WxHpx."},{"type":"file","file_id":"file-api-..."}]`, exactly the wire format the DeepSeek chat-completions API accepts.
3. **Cache** — content-addressed by sha256 in `~/.pi/agent/data/pi-imagefiles-cache.json`; the same image uploads once and is reused across requests and sessions. Files live **7 days** (dsh's default), refreshed 1 hour before expiry.
4. **Budget / offload** — the dsh defaults: **128 MiB** of file-referenced image bytes and **600 images** per request; over budget the *oldest* images are replaced with a placeholder text (`[image omitted to keep the request within its image limit; older images are omitted first...]`), in deterministic quanta (64 MiB / 20 images).
5. **Fallback** — if the Files API fails, that image stays inline base64 (pre-extension behaviour). After 5 consecutive upload failures a circuit breaker inlines everything for an hour, so a broken Files API cannot slow down every request.

Verified against the live API: uploading a 5.6 MB screenshot and referencing it by `file_id` returns a correct model answer, and the request body for that image is ~200 bytes instead of 7.5 MB.

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
| Max file-referenced bytes per request | 128 MiB |
| Max images per request | 600 |
| Offload byte / count quantum | 64 MiB / 20 |
| Upload timeout / retries | 30 s / 1 |
| Circuit breaker | 5 failures → 1 h backoff |

## Development

```bash
bun run test/run-tests.ts   # unit self-check, no network
```

Integration check (real API): upload a screenshot, call `chat/completions` with the transformed payload.

## Notes

- The image handle text carries the image's dimensions (parsed from PNG/JPEG/WebP/GIF headers) so the model understands the coordinate mapping.
- Images uploaded through this extension are deleted from the cache only by `/imagefiles reset`; the Files API side expires them after 7 days.
- Non-DeepSeek providers are never touched — if you use another vision provider, the extension stays inert.

## License

MIT
