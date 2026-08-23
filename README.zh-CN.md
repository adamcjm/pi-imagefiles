# pi-imagefiles

将图片上传到 **DeepSeek Files API**，在视觉请求中以 `file_id` 引用，使请求体保持极小。这是 `dsh` 使用的同款策略，以 pi 扩展的形式实现。

## 为什么需要它

Pi 会把每张截图以 `data:image/...;base64,...` 内联进 provider 请求。DeepSeek 的 API 网关拒绝超过 50 MB 的请求（`413 Request Entity Too Large`）——一个长时间运行的视觉会话（几十张截图、每张 base64 最多 4.5 MB）会撞上这个上限，会话再也无法继续。

`pi-imagefiles` 将每张内联图片替换为一段简短文本句柄 + `{"type": "file", "file_id": "..."}` 引用块（每张约 200 字节，而非约 4.5 MB），因此无论会话积累了多少图片，请求体几乎不增长。

## 工作原理

与 `dsh`（deepseek-harness）完全一致的流程和预算：

1. **上传** —— 每次 provider 请求前，图片上传到 `POST /v1/files`（`purpose=user_data`）。仅作用于 **DeepSeek 视觉模型**（`deepseek-v4-flash-vision-exp` 及任何 `deepseek*vision*` 模型 id）；其他 provider/模型完全不受影响。
2. **引用** —— 每个图片块替换为 `[{"type":"text","text":"Image <sha8>; image/png WxHpx."},{"type":"file","file_id":"file-api-..."}]`，这正是 DeepSeek chat-completions API 接受的线格式。
3. **缓存** —— 以 sha256 内容寻址，存于 `~/.pi/agent/data/pi-imagefiles-cache.json`；同一张图只上传一次，跨请求、跨会话复用。文件有效期 **7 天**（dsh 默认值），过期前 1 小时自动重新上传。
4. **预算 / 卸载** —— 采用 dsh 默认值：每请求 **128 MiB** 文件引用图片字节、**600 张** 图片上限；超预算时*最旧*的图片替换为占位文本（`[image omitted to keep the request within its image limit; older images are omitted first...]`），以确定性的量子（64 MiB / 20 张）裁剪。
5. **回退** —— Files API 失败时该图片保留 base64 内联（与原行为一致）；连续 5 次上传失败后熔断 1 小时（全部内联），避免 Files API 故障拖慢每个请求。

已对线上 API 验证：上传 5.6 MB 截图并以 `file_id` 引用，模型能正确识别图片内容，且该图在请求体中仅占约 200 字节（内联时约 7.5 MB）。

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
| 每请求文件引用字节上限 | 128 MiB |
| 每请求图片数量上限 | 600 |
| 卸载字节 / 数量量子 | 64 MiB / 20 |
| 上传超时 / 重试 | 30 秒 / 1 次 |
| 熔断 | 5 次失败 → 暂停 1 小时 |

## 开发

```bash
bun run test/run-tests.ts   # 单元自检，无需网络
```

集成验证（真实 API）：上传截图，用转换后的 payload 调用 `chat/completions`。

## 说明

- 图片句柄文本包含图片尺寸（从 PNG/JPEG/WebP/GIF 头部解析），帮助模型理解坐标映射。
- 通过本扩展上传的图片仅由 `/imagefiles reset` 从缓存删除；Files API 侧 7 天后自动过期。
- 非 DeepSeek 的 provider 绝不触碰 —— 使用其他视觉 provider 时本扩展保持惰性。

## 许可证

MIT
