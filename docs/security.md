# 安全设计（Harness Director）

## 1. 凭证

- **开发环境**：`ARK_API_KEY` 环境变量读取，不落盘。
- **正式桌面端**：ARK_API_KEY 存入 **macOS Keychain**（`tools-server/director/keychain.mjs`
  用 `security` CLI 读写）。绝不进入 `localStorage`、前端状态、日志、SQLite、项目文件。
- **API Key 不得进入渲染进程**：前端（webview）永不接触 Key；Key 只由
  `director-server`（Node）从 Keychain/环境解析后注入 Python sidecar 的 `env`。
- **日志脱敏**：`worker.py` 的 `_redact()` 把 Key 替换为 `***`，stdout/stderr 均不泄漏。
- **`.env.example` 只含空占位符**；`.env` / `*.key` / `*.pem` / `credentials*.json` 已被 Git 忽略。

设置 Key（正式桌面端，经本机 `security`，不走 webview）：
```bash
security add-generic-password -s dev.harness.seedance -a ark_api_key -w "你的Key" -U
```
`director-server` 启动时 `resolveApiKey()` 优先读 Keychain，缺失时回退 `ARK_API_KEY`（仅开发）。
`/keychain_status` 只返回来源与「是否有 Key」，绝不返回 Key 本体。

## 2. Prompt Injection 防御

- 外部网页、Skill、素材元数据、字幕文件、媒体文字一律视为**不可信数据**。
- `prompt-compiler.mjs` 的 `SYSTEM_SAFETY_RULES` 为最高优先级，任何外部内容不能覆盖。
- `detectInjection()` 识别「忽略规则 / 上传素材 / 读取目录 / 暴露密钥 / 执行命令 / 改权限 / 角色越权」，
  `sanitizeUntrusted()` 做长度裁剪 + 转义 + 标记，不删除以便审查。
- 不可信内容排在有可信边界之后；编译结果暴露 `trustedBoundary` 与 `injectionHits`。
- 外部内容不能修改应用权限、执行任意命令或读取凭证。

## 3. FFmpeg 与文件安全

- FFmpeg **一律 `spawn(参数数组)`**，禁止字符串拼接进 shell（`ffmpeg.mjs`）。
- 文件名、字幕、Prompt、素材路径边界校验（`assertInside` 拒绝路径穿越）。
- 所有输出限制在项目目录（`<workspace>/director/<projectId>/`）。
- 下载校验 Content-Type、大小上限（2GB 硬上限）与目标路径。

## 4. 网络与进程

- 服务只监听 `127.0.0.1`（`director-server.mjs`、`tools-server/index.mjs`），不暴露 `0.0.0.0`。
- Python sidecar 经 `stdin/stdout` JSON-RPC，stdout 只输出协议 JSON，诊断日志写 stderr。
- Seedance 两条消费通道（Agent Plan / Platform）**明确隔离**，Agent Plan 失败不静默切换，
  避免意外账单。

## 5. 付费保护

- 测试 / 单元测试 / UI 预览 / 开发服务器启动期间**绝不真实调用付费 API**。
- 付费端到端测试需同时满足 `RUN_PAID_E2E=1` 与 `PAID_E2E_CONFIRM=yes`（等价界面二次确认），
  否则 skip（`paid-e2e.test.mjs`）。
- 真实提交前必须经过确认面板（Provider/通道/模型/镜头数/分辨率/时长/音频/缓存/费用），
  费用无法精确估算时显示「以服务端实际扣费为准」。

## 6. 参考素材上传

- 本地文件绝不把磁盘绝对路径发给远程 API。
- `asset-upload.mjs` 抽象三种形态：`RemoteURLAsset` / `TOSAsset` / `DataURIAsset`
  （DataURI 仅在官方限制允许且文件足够小时）。
- TOS 使用最小权限，优先预签名 URL / 临时凭证，**不落长期 AK/SK**。
- 上传结果与素材哈希建立缓存，相同文件不重复上传；UI 显示「是否已上传 / URL 何时过期」。
