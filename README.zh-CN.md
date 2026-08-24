# pi-imagefiles

[English](https://github.com/adamcjm/pi-imagefiles/blob/main/README.md) · **中文**

**适配 DeepSeek 视觉模型** —— `deepseek-v4-flash-vision-exp`（及任何 `deepseek*vision*` 命名的模型）。将图片上传到 **DeepSeek Files API** 并在视觉请求中以 `file_id` 引用；第三方 DeepSeek 视觉网关则通过请求裁剪获得同样的安全网。

## 解决的问题

Pi 会把每张截图以 `data:image/...;base64,...` 内联进 provider 请求。**DeepSeek 的 API 网关拒绝超过 50 MB 的请求**（`413 Request Entity Too Large` —— 实测阈值为 50,000,000 字节：47.9 MB 通过，48.0 MB 失败）。一个长时间运行的视觉会话（几十张截图、每张 base64 最多 4.5 MB）最终会超过该上限，会话再也无法继续。

`pi-imagefiles` 移除了这个天花板：

- **DeepSeek 官方网关**（`api.deepseek.com`）：图片上传到 Files API，以 `file_id` 引用 —— 每张图片在线路上仅约 200 字节（内联时约 4.5 MB），会话积累多少图片请求体都几乎不增长。
- **三方 DeepSeek 视觉网关**（如 opencode zen/go —— 它转出 `deepseek-v4-flash-vision-exp` 模型，但**没有 Files API**（实测 `GET/POST /v1/files` → 404），并且透传上游约 50 MB 的同一限制）：扩展在预算超限时裁剪*最旧*的图片，保证请求永不越线。

## 工作原理

与 `dsh`（deepseek-harness）一致的流程和预算：

1. **识别** —— 根据模型 id + baseUrl 选择处理模式（见下方矩阵）；其他请求原样通过。
2. **上传**（仅官方）—— 图片上传到 `POST /v1/files`（`purpose=user_data`），随后每个图片块替换为 `[{"type":"text","text":"Image <sha8>; image/png WxHpx."},{"type":"file","file_id":"file-api-..."}]` —— 正是 DeepSeek chat-completions API 接受的线格式。
3. **缓存**（仅官方）—— 以 sha256 内容寻址存于 `~/.pi/agent/data/pi-imagefiles-cache.json`；同一张图只上传一次，跨请求、跨会话复用。文件有效期 **7 天**（dsh 默认值），过期前 1 小时自动重新上传。
4. **预算 / 卸载**（所有模式）—— dsh 默认值：每请求 **128 MiB** 图片字节、**600 张**上限；超预算时*最旧*的图片替换为带**解析图片信息**的占位文本（mime 类型、从 PNG/JPEG/WebP/GIF 头部解析的尺寸、sha256），按确定性量子（64 MiB / 20 张）裁剪。这些图片模型此前已在会话中看到并理解过，可依赖该理解。
5. **回退**（仅官方）—— Files API 失败时该图片保留 base64 内联（与原行为一致）；连续 5 次上传失败后熔断 1 小时（全部内联），避免 Files API 故障拖慢每个请求。
6. **存活校验**（仅官方）—— 缓存中的 `file_id` 映射会周期性向 Files API 复核（每个文件至多每 5 分钟一次）。若文件已在服务端被删除（`file_id does not exist or is not created under your account` → 400），映射会被丢弃并**透明地重新上传**，过期引用永远不会卡死会话。网络/5xx 校验错误视为不确定，绝不误删有效映射。

## 模式矩阵

| 请求目标 | 模型 id | 模式 | 上传 + file_id | 卸载裁剪 |
|---|---|---|---|---|
| `api.deepseek.com` | `deepseek-v4-flash-vision-exp` / `deepseek*vision*` | `upload` | ✅ | ✅ |
| 三方网关（如 `opencode.ai/zen/go/v1`） | `deepseek*vision*` | `offload-only` | ❌（无 Files API） | ✅ |
| 任何其他 provider | 其他 | `none` | ❌ | ❌ |

已对线上 API 验证：上传 5.6 MB 截图并以 `file_id` 引用，模型能正确识别图片内容，该图在线路上仅约 200 字节。对于 opencode zen/go：2.4 MB→38.5 MB 的请求体通过，48.1 MB 被上游 413 拒绝——正是卸载裁剪要避开的同一堵墙。

## 安装

```bash
# 从 npm 安装
pi install pi-imagefiles

# 或本地开发软链
ln -s ~/pi/dev/pi-imagefiles/extensions/pi-imagefiles ~/.pi/agent/extensions/pi-imagefiles
```

`pi-imagefiles` 需要 DeepSeek API key：像 pi 一样读取 `~/.pi/agent/auth.json`（`deepseek`），没有则回退到 `DEEPSEEK_API_KEY` 环境变量。

## 使用

无需任何配置 —— 对 DeepSeek 视觉模型自动生效。

| 命令 | 作用 |
|---|---|
| `/imagefiles` | 查看缓存统计（已上传图片数、总字节） |
| `/imagefiles reset` | 清空缓存的 `file_id` 映射（强制重新上传） |

## 策略参数（与 dsh 对齐）

| 设置 | 默认值 |
|---|---|
| `purpose` | `user_data` |
| 文件有效期 / 刷新余量 | 7 天 / 1 小时 |
| 每请求图片字节上限 | 128 MiB |
| 每请求图片数量上限 | 600 |
| 卸载字节 / 数量量子 | 64 MiB / 20 |
| 上传超时 / 重试 | 30 秒 / 1 次 |
| 熔断 | 5 次失败 → 暂停 1 小时 |

## 开发

```bash
bun run test/run-tests.ts   # 单元自检，无需网络
PI_IMAGEFILES_CACHE_DIR=/tmp/pi-imagefiles-it bun run test/integration.ts <png>  # 真实 API
```

集成测试使用**隔离缓存目录**（`PI_IMAGEFILES_CACHE_DIR`），测试上传绝不污染用户真实缓存；测试文件事后从服务端删除。切勿对真实缓存运行集成测试——文件在服务端被删而会话仍引用它，正是本扩展要防的过期 `file_id` 400。

## 说明

- 图片句柄文本包含图片尺寸（从 PNG/JPEG/WebP/GIF 头部解析），帮助模型理解坐标映射。
- `offload-only` 模式不触碰网络：不上传、不写缓存，纯粹是对请求体的确定性裁剪。
- 通过本扩展上传的图片仅由 `/imagefiles reset` 从缓存删除；Files API 侧 7 天后自动过期。
- 非 DeepSeek 的 provider 绝不触碰 —— 使用其他视觉 provider 时本扩展保持惰性。

## 许可证

MIT
