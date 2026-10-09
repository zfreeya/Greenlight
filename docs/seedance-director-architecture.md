# Seedance Director 架构

Harness Director（AI 导演工作台）在 `harness-desktop` 内的架构。目标不是「输入提示词出视频」，
而是一套可持续创作、不会因每次小改动都重复调用付费视频模型的导演生产系统。

## 1. 创作层级

```
Project → Scene → Shot → Take → Asset → Timeline → Render
```

- **Project**：`tools-server/director/types.mjs` 的 `newProject()`，含 Creative Brief / Story /
  Direction / Rhythm / Bible（Character/Location/Visual/Continuity）/ Shots / Assets / Timeline。
- **Shot**：结构化镜头（叙事目的、主体/动作/场景/时间、景别/构图/机位/焦段、运镜、光线色彩、
  连续性约束、台词/环境声/音乐、负面约束、时长/比例/分辨率、参考素材、当前选中 Take、锁定状态、
  是否需要重新生成）。
- **Take**：一个 Shot 的多次生成结果。重新生成永远创建新 Take，不覆盖旧结果。
- **Asset**：素材（含来源/许可/肖像授权/生成元数据/文件哈希）。
- **Timeline**：非破坏性时间线（`timeline.mjs`），可编译到 FFmpeg。
- **Render**：FFmpeg 本地后期（代理/缩略图/拼接/混音/字幕/转场/导出）。

## 2. 进程拓扑

```
┌───────────────────────────────────────────────────────────────────┐
│ Tauri 2 桌面壳（Rust）                                             │
│   src-tauri/src/lib.rs：launchd 拉起 Node 服务；注入 Keychain Key  │
├───────────────────────────────────────────────────────────────────┤
│ 渲染进程（React + Vite + TS，src/）                                │
│   只做编排与 UI；绝不经手 ARK_API_KEY                               │
│   ├─ harness.tsx：Agent 工具循环（tool_calls → execTool）          │
│   ├─ director.ts：类型 + HTTP 客户端 + 工具 Schema                  │
│   └─ DirectorWorkspace.tsx：导演工作台 UI                          │
├───────────────────────────────────────────────────────────────────┤
│ director-server.mjs（Node，127.0.0.1:8456）                       │
│   数据/工具/生成引擎的单一事实来源                                   │
│   ├─ director/types.mjs / store.mjs（JSON 项目快照 + journal）     │
│   ├─ director/generation.mjs（SQLite：缓存 + 任务生命周期 + 幂等）   │
│   ├─ director/prompt-compiler.mjs（导演 Prompt 编译 + 注入防御）    │
│   ├─ director/asset-upload.mjs（参考素材上传抽象 + 哈希缓存）        │
│   ├─ director/ffmpeg.mjs（FFmpeg 后期，参数数组执行）               │
│   └─ director/seedance/provider.mjs（Python sidecar 适配器）        │
├───────────────────────────────────────────────────────────────────┤
│ Seedance Python sidecar（JSON-RPC stdin/stdout）                   │
│   director/seedance/worker.py                                     │
│   - 官方 SDK volcenginesdkarkruntime.Ark                           │
│   - 结构化参数（content/resolution/ratio/duration/generate_audio/  │
│     watermark/return_last_frame），绝不拼 CLI 字符串                │
│   - stdout 只输出协议 JSON；日志写 stderr；Key 脱敏                  │
└───────────────────────────────────────────────────────────────────┘
```

## 3. 生成引擎（防重复计费核心）

`tools-server/director/generation.mjs`：

1. **Generation Spec 标准化**：`standardizeGenerationSpec()` 把一次请求规范为
   `{provider, billing_mode, base_url, model, prompt, negative_prompt, reference_asset_hashes,
   resolution, ratio, duration, generate_audio, watermark, return_last_frame, seed, extra}`。
2. **generation_key**：对规范 JSON 做确定性序列化（对象键排序）后求 SHA-256。
3. **缓存去重**：相同 key 且本地文件存在 → 直接复用，不调用 API（`GenerationEngine.lookupCache`）。
4. **Dirty 分离**：`markGenerationDirty(shot)`（Prompt/参考变化）与 `markRenderDirty(project)`
   （时间线/字幕/配乐/转场变化）互不干扰。
5. **幂等**：`GenerationEngine.createTask` 对同 generation_key 的非终态任务复用，网络重试不重复下单。
6. **重启恢复**：任务与缓存落 SQLite（`node:sqlite`），`listInFlight` 恢复未完成任务继续轮询。

## 4. 任务状态机与轮询

见 [`generation-state-machine.md`](./generation-state-machine.md)。

- 全局并发默认 1，可调到 1–3（`queue_control` 的 `set_concurrency`）。
- 轮询初始 3s，指数退避 + ±20% 抖动（`pollIntervalMs`）。
- 网络异常只重试查询，不重新创建任务；下载失败只重试下载，绝不重新生成。

## 5. Seedance Provider 与消费通道

- 两条明确隔离的通道（`SEEDANCE_CHANNELS`）：
  - `agent_plan` → `https://ark.cn-beijing.volces.com/api/plan/v3`
  - `platform` → `https://ark.cn-beijing.volces.com/api/v3`
- **Agent Plan 失败绝不静默切换到 Platform**；界面始终显示当前通道。
- 模型 ID 不写死：设置页配置，`SEEDANCE_MODEL` 环境变量 / 设置注入。
- 若服务端返回「不支持 Agent Plan」，界面解释为套餐/模型兼容性问题，不自动换付费通道。

## 6. FFmpeg 本地后期

见 `tools-server/director/ffmpeg.mjs`：
代理视频、封面缩略图、探测（时长/FPS/尺寸/编码/音频）、镜头拼接、统一分辨率/帧率/像素格式/采样率、
转场、字幕烧录/外挂、背景音乐混音、响度、淡入淡出、黑场、多宽高比导出、最终 MP4
（H.264 + AAC + yuv420p + faststart + 48kHz + 可配 CRF）。

**安全底线**：FFmpeg 一律 `spawn(参数数组)`，禁止字符串拼接进 shell；文件名/字幕/路径边界校验；
输出限制在项目目录。

## 7. 数据存储

| 数据 | 存储 | 说明 |
|---|---|---|
| 项目快照 | JSON（`<workspace>/director/<id>/project.json`） | 原子写 + journal + 检查点 |
| 生成缓存 | SQLite（`generation.db`） | generation_key → 结果 |
| 任务生命周期 | SQLite（`generation.db`） | task_id/generation_key/重试/轮询时间/错误类型 |
| 上传缓存 | SQLite（`uploads.db`） | 素材哈希 → URL/过期 |
| API Key | macOS Keychain（正式）/ `ARK_API_KEY`（开发） | 绝不入 SQLite/JSON/前端/日志 |

## 8. 模块化布局（2026-08-29 重构后）

`director-server.mjs` 已从单体拆为「组合根 + 域路由 + 共享上下文」，并打包为
npm 模块 `harness-director`（tools-server/director/）：

```
tools-server/director-server.mjs    薄 CLI：解析参数 → createDirectorServer → start
tools-server/director/
├── server.mjs                      组合根：依赖装配 + HTTP + 静态 + 轮询循环
├── server-context.mjs              共享上下文工厂（依赖注入，所有路由只依赖 ctx）
├── routes/
│   ├── project.mjs                 项目/故事/Bible/镜头/场景域路由
│   ├── generation.mjs              生成引擎/缓存/Take/付费闸门/队列/QC 域路由
│   ├── render.mjs                  时间线/FFmpeg/导出/渲染历史域路由
│   ├── business.mjs                连续性检查/产品模板/订单记账/反向工作流/资产域路由
│   └── index.mjs                   域路由集合入口
├── index.mjs                       包入口（createDirectorServer + 全部库模块）
├── package.json                    name: harness-director（npm pack → .tgz）
├── types.mjs / store.mjs / generation.mjs / ffmpeg.mjs / prompt-compiler.mjs
├── qc.mjs / timeline.mjs / render.mjs / tools.mjs / providers.mjs / skills.mjs
├── asset-upload.mjs / keychain.mjs / third-party.mjs
└── seedance/                       Python sidecar（provider.mjs + worker.py + mock_worker.py）
```

打包产物：`tools-server/director/harness-director-0.1.0.tgz`（28 文件，不含测试）。
独立安装冒烟验证通过：`npm install <tarball>` 后 `createDirectorServer / T / FF` 均可导入。

## 9. 启动

见仓库 `README.md` 的「Director 工作台」章节。
