# Harness Director（AI 导演工作台）独立审查报告

> 审查方式：只读真实代码、数据模型、调用链、测试与构建结果；不采信 README / 注释 / 任务描述。
> 审查范围：`harness-desktop`（Tauri 2 + React + Node sidecar + Python worker）。
> 审查日期：本仓库当前 HEAD（`main`，含未提交的 Director 工作）。

---

## 1. 执行摘要

| 领域 | 结论 |
|---|---|
| Project → Shot → Take → Asset → Timeline → Render 层级 | **Verified**（types.mjs / generation.mjs / timeline.mjs 均真实存在并落库） |
| Scene 层 | **Partial**（仅 `story.scenes[]` + `shot.sceneId`，无独立 Scene 实体/存储） |
| Character/Location/Style Bible | **Verified**（`bible.characters/locations/visual`，stableId 引用进 Prompt） |
| Camera/Sound Bible | **Partial**（`direction.cameraLanguage/soundRules` 为规则数组，非 stableId 引用实体） |
| Generation Spec + SHA-256 generation_key | **Verified**（generation.mjs，测试覆盖哈希稳定性） |
| 缓存命中不重复调用 API | **Verified**（generation-server.test.mjs step 4：cacheHit=true 且 Take 数不变） |
| Dirty 分离（Generation vs Render） | **Verified**（update_shot→generation；字幕/时间线/配乐→render） |
| Take 多版本，重新生成不覆盖 | **Verified**（forceRegenerate 新建 Take，测试覆盖） |
| 任务状态机（11 态）+ SQLite 持久化 | **Verified**（generation_tasks 表 + 状态迁移测试） |
| 重启恢复 task_id 继续轮询 | **Verified**（引擎级 + 服务重启持久化测试） |
| 下载失败只重试下载 | **Verified（修复后）**：error_kind=download 区分 + retry_download 强制迁移 |
| Seedance 官方 SDK / 双通道隔离 | **Verified（代码级）**：worker.py 结构化参数、base_url 按 billing_mode、无回退 |
| Seedance 真实调用 | **Not tested**（本机无 SDK / ARK_API_KEY；仅 mock worker 覆盖生命周期） |
| FFmpeg 本地后期 | **Partial**：参数数组 + 原子 rename 已实现；**Not tested**（本机未装 ffmpeg） |
| 付费确认闸门 | **Verified（修复后）**：confirm_generation 强制 `confirmed:true`；双门禁 paid E2E |
| 并发/双击防重复提交 | **Partial（修复后）**：单进程内幂等；多进程同工作区无唯一约束（残余风险） |
| 凭证安全 | **Verified（开发路径）**：Key 仅进 worker env，日志脱敏；**Partial**：Keychain→Tauri 注入未接线 |
| 路径穿越 / 命令注入 / SSRF | **Verified**：FFmpeg 参数数组、assertInside、下载大小上限 |

**评分统计**：修复前 P0=0、P1=7、P2=4、P3=6；本轮已修复 P1=7、P2=2；剩余 P2=2、P3=6（见 §3）。

---

## 2. 需求追踪矩阵

| Requirement | Status | Evidence | Risk | Required Fix | Acceptance Test |
|---|---|---|---|---|---|
| Project→Shot→Take→Asset→Timeline→Render | Verified | types.mjs `newProject/newShot`；generation.mjs `newTake`；timeline.mjs | 低 | — | director.test.mjs |
| Shot 字段全量（叙事目的/景别/机位/焦段/运镜/灯光/色彩/连续性/台词/环境声/配乐/负面/时长/比例/分辨率） | Verified | types.mjs `newShot`（L~95-135） | 低 | — | — |
| 字段实际进入 Prompt/生成请求 | Verified | prompt-compiler.mjs `buildShotPacket` → compileGenerationPrompt → `buildGenerationSpec` | 低 | — | — |
| Scene 独立层 | Partial | 仅 `story.scenes[]` + `shot.sceneId` | 中 | 如需场景级操作再加实体 | — |
| Generation Spec 标准化 + SHA-256 | Verified | generation.mjs `standardizeGenerationSpec/generationKey` | 低 | — | generation.test.mjs「哈希稳定性」 |
| 相同 key + 文件存在 → 复用 | Verified | generation.mjs `lookupCache`（文件缺失视为未命中）；服务端 cacheToAsset | 低 | — | generation-server.test.mjs step4 |
| 相同请求不重复创建远程任务 | Verified | generation.mjs `createTask`（同 key 非终态复用）；`findInFlightTask` | 中（多进程） | 多进程唯一约束（见 P3） | generation.test.mjs「幂等」 |
| 网络重试只重查不重建 | Verified | 轮询 catch 只 touchPoll；createTask 幂等 | 低 | — | — |
| 下载失败只重试下载 | Verified（本轮修复） | error_kind=download；retry_download 仅重下载；downloadSeedanceResult force 迁移 | 高（修复前 retry_download 抛错） | ✅ 已修 | generation.test.mjs「下载失败区分」 |
| 修改字幕→Render dirty | Verified | director-server.mjs `/generate_captions` → `GEN.markRenderDirty` | 低 | — | generation-server.test.mjs step6 |
| 修改转场→Render dirty | **Missing** | timeline.mjs 有 `addTransition`，但无路由/UI 修改转场 | 中 | 需补转场编辑端点 | — |
| 修改音乐/音量→Render dirty | Partial | `/add_music` 已标 Render dirty；音量无路由 | 中 | 需补音量/转场编辑端点 | — |
| 修改 Prompt→仅该 Shot Generation dirty | Verified | `/update_shot` GEN_FIELDS 检测 | 低 | — | generation-server.test.mjs step5 |
| 重新生成产生新 Take | Verified | `forceRegenerate` 跳过缓存新建 Take（修复后任务可重建） | 高（修复前 createTask 误复用完成态） | ✅ 已修 | generation-server.test.mjs step4b |
| 下载后存本地 + 哈希校验 | Verified | downloadSeedanceResult → finalizeTake（fileHash/bytes 落库） | 低 | — | seedance.test.mjs（mock 下载） |
| URL 过期不丢已成功素材 | Verified | 成功后立即下载到项目资产目录；缓存按文件存在判定 | 低 | — | generation.test.mjs「文件缺失视为未命中」 |
| 重启恢复 task_id 继续轮询 | Verified | SQLite `listInFlight`；startPollLoop 恢复 | 低 | — | generation.test.mjs「recovery」 |
| 11 态状态机 | Verified | generation.mjs TASK_STATES/TASK_TRANSITIONS | 低 | — | generation.test.mjs「状态机」 |
| 双击/并发窗口只一个任务 | Partial | 单进程同步 SQLite 原子；`findInFlightTask` 复用 Take | 中（多进程） | 唯一约束（P3） | generation.test.mjs「findInFlightTask」 |
| 服务端付费闸门 | Verified（本轮修复） | confirm_generation 强制 `confirmed:true` | 高（修复前 Agent 可绕过） | ✅ 已修 | generation-server.test.mjs step2b |
| Seedance 官方 SDK + 结构化参数 | Verified | worker.py `create_task`（content/resolution/ratio/duration/…结构化） | 低 | — | — |
| Agent Plan / Platform 不静默回退 | Verified | worker.py `_client_for` 按 billing_mode 定 base_url；失败原样上报 | 低 | — | — |
| 模型 ID 可配置不写死 | Verified | `SEEDANCE_MODEL` env + seedanceCaps().model；worker 取 spec.model | 低 | — | — |
| 不向不支持模型发参数（capability validation） | **Partial** | `validateRequest` 已实现但**未接入调用链** | 中 | 接入 validateRequest | — |
| API Key 不进日志/DB/前端 | Verified | worker `_redact`；keychain.mjs；seedance.test.mjs「脱敏」 | 低 | — | seedance.test.mjs |
| 测试环境默认 Mock | Verified | seedance.test.mjs 用 mock_worker.py；paid-e2e 双门禁 | 低 | — | paid-e2e.test.mjs skip |
| FFmpeg 参数数组（无 shell 注入） | Verified | ffmpeg.mjs spawn(数组)；ffmpeg.test.mjs「恶意文件名」 | 低 | — | ffmpeg.test.mjs |
| FFmpeg 原子输出 | Verified（本轮修复） | runFfmpeg 临时文件 + rename | 中（修复前中断留半成品） | ✅ 已修 | ffmpeg.test.mjs（args 检查） |
| 路径穿越防护 | Verified | ffmpeg.mjs `assertInside`；store.resolveAssetPath | 低 | — | ffmpeg.test.mjs |
| 输出限制项目目录 | Verified | export/preview 均落在 `store.exportsDir/assetsDir` | 低 | — | — |
| 删除素材前确认 / 引用检查 | **Missing** | 无删除端点 | 中 | 需补删除+引用检查 | — |
| 连续性与尾帧参考 | Partial | 角色/场景 Bible 进 Prompt；return_last_frame 能力暴露；**尾帧→下一镜首帧链路未自动接线**（按需用户确认，合规但未实现全链路） | 中 | 需用户确认流程 | — |
| UI 明确按钮（编译/预览/生成/重生成/选 Take/锁定/渲染/导出） | Verified | DirectorWorkspace.tsx ShotInspector 动作区 | 低 | — | — |
| UI 显示额度消耗 | Verified | ConfirmModal（Provider/通道/模型/缓存/新生成数/费用+免责） | 低 | — | — |
| UI 状态完整（加载/空/失败/离线/恢复） | Partial | 有 error/空态；无全屏 loading/恢复态 | 中 | 补 loading/恢复 | — |

---

## 3. 问题清单

### P0（0 个，修复前亦未发现）
未发现可直接重复扣费、泄露密钥或损坏数据的路径：`createTask`/`lookupCache` 幂等，Key 仅进 worker env 且脱敏，Spec 不含 Key。

### P1（7 个，本轮全部修复）

- **P1-01 下载失败后「重试下载」抛错不可用**
  - Evidence：`director-server.mjs` L390 `downloadSeedanceResult` 先 `engine.updateTask(status:"downloading")`（无 force）；任务因下载失败被 `failTake` 置为 `failed`（L341 force），`failed→downloading` 非法 → 抛「非法任务状态迁移」。
  - Impact：UI「重试下载」按钮不可用，下载失败后素材永久卡死。
  - Root Cause：下载子阶段迁移未允许 `failed(download)→downloading`。
  - Fix：下载阶段 `{force:true}`（已修，L390）。
  - Acceptance：`retry_download` 在 errorKind=download 时成功重下且不触发生成。

- **P1-02 双击/并发确认产生孤儿 Take**
  - Evidence：`confirm_generation`（director-server.mjs L931-938）无条件新建 Take；`createTask` 对同 key 返回 `reused:true` 时仍 push 新 Take，其 `taskId` 指向不存在的任务。
  - Impact：异步 Provider 下重复提交产生永远 `queued` 的孤儿 Take，用户困惑、状态混乱。
  - Root Cause：确认入口未先复用已有 in-flight 任务的 Take。
  - Fix：`engine.findInFlightTask(spec.key)` 命中则复用对应 Take（已修，L930-940）。
  - Acceptance：对同一镜头连续两次 confirm（任务未完成），Take 数不增。

- **P1-03 forceRegenerate 无法真正新建任务**
  - Evidence：`createTask`（generation.mjs L334-336）终态排除只有 `failed/cancelled/locked`，漏掉 `ready_for_review` → 完成态任务被误复用，新 Take 的 taskId 不存在 → `finalizeTake` 后 `updateTask` 抛「任务不存在」。
  - Impact：「重新生成新 Take」在已有结果后不可用。
  - Root Cause：任务完成态未纳入排除集。
  - Fix：排除集加入 `ready_for_review/selected`（已修）。
  - Acceptance：forceRegenerate 在缓存命中后仍创建新任务新 Take（测试 step4b）。

- **P1-04 同步 Provider（local-stub）任务状态遗留 `queued`**
  - Evidence：`confirm_generation` L946 置 `queued` 后同步完成，但未更新引擎任务 → `listInFlight` 长期返回已完成任务。
  - Impact：轮询/队列视图显示错误状态。
  - Root Cause：同步路径缺少任务完成态写入。
  - Fix：`finalizeTake` 后 `updateTask(ready_for_review, force)`（已修，L973）。
  - Acceptance：local-stub 完成后任务状态为 ready_for_review。

- **P1-05 并发限制对异步任务失效（默认 1 未生效）**
  - Evidence：轮询循环 L426 用 `(p.generationTasks||[]).filter(isRunningTask).length`，而新引擎任务不在 `p.generationTasks` 且状态是 `generating` 非 `running` → 恒为 0。
  - Impact：Seedance 并发不受 1–3 限制，可能同时提交多个任务。
  - Root Cause：并发计数源错位。
  - Fix：改用 `engine.listInFlight().filter(status==="generating").length`（已修）。
  - Acceptance：两个 queued 异步任务在并发=1 时只提交一个。

- **P1-06 旧端点 `submit_video_generation` 对 seedance 静默降级 local-stub**
  - Evidence：director-server.mjs L665 `getProvider("seedance")` 回退 local-stub（providers.mjs `getProvider` 兜底）。
  - Impact：Agent 走旧端点时用户以为生成 Seedance 视频，实际得到占位帧。
  - Root Cause：Provider 名无校验 + 兜底。
  - Fix：旧端点显式拒绝 `seedance/ark` 并指向生成引擎（已修，L668-670）。
  - Acceptance：旧端点传 seedance 返回 `use_generation_engine`。

- **P1-07 付费闸门缺失（confirm_generation 无确认即提交）**
  - Evidence：confirm_generation 原无条件执行（L893 起），Agent 工具目录含该工具。
  - Impact：Agent（auto 模式）可绕过确认面板直接付费生成。
  - Root Cause：确认只存在 UI 层。
  - Fix：服务端强制 `b.confirmed === true`（已修，L895-897）+ 前端确认面板带 `confirmed:true`（DirectorWorkspace.tsx）。
  - Acceptance：不带 confirmed 返回 `confirmation_required`（测试 step2b）。

### P2（4 个，已修 2，剩 2）

- **P2-01 轮询退避未生效（固定 3s）** ✅ 已修：轮询循环按 `pollIntervalMs` 跳过未到期任务（director-server.mjs L437-439）。
- **P2-02 FFmpeg 输出非原子** ✅ 已修：`runFfmpeg` 临时文件 + 成功 rename，失败删除临时文件（ffmpeg.mjs）。
- **P2-03 capability validation 未接入调用链**
  - Evidence：seedance/provider.mjs `validateRequest` 无任何调用点（grep 无引用）。
  - Impact：不支持的模型/参数可能被提交到服务端才报错。
  - Fix 方案（未执行，涉及提交流程）：`confirm_generation`/`buildGenerationSpec` 前调用 `provider.validateRequest(spec)`，warnings 并入确认面板。
- **P2-04 旧端点 `submit_video_generation` 不写 generation 缓存**
  - Evidence：legacy 路径不调用 `engine.recordCache`。
  - Impact：新旧两条路径缓存不一致，同一请求可能分别产生调用。
  - Fix 方案（未执行，涉及旧链路重构）：legacy 路径改用生成引擎或至少 recordCache。

### P3（6 个，记录不改）

- P3-01 多进程同工作区并发时 `generation_tasks(generation_key)` 无唯一约束（单进程内同步原子，风险低）。
- P3-02 项目 JSON `store.saveProject` 无锁：轮询循环与 HTTP 编辑并发可能丢更新（单进程、低概率）。
- P3-03 `getProvider` 对未知 Provider 名兜底 local-stub（防 typo 静默降级，仅旧端点已拒绝 seedance/ark）。
- P3-04 转场/音量无编辑路由与 UI（数据模型有，操作路径缺）。
- P3-05 删除素材/删除本地文件端点缺失（含「删除前确认」与引用检查）。
- P3-06 尾帧→下一镜首帧自动接线未实现（需用户确认流程；当前仅能力暴露）。
- P3-07 Keychain→Tauri 启动注入未接线（当前开发走 ARK_API_KEY env；`keychain.mjs` 已就绪）。
- P3-08 seedance 能力矩阵在 director-server 硬编码（seedanceCaps），未从 worker `capabilities` RPC 实取。

---

## 4. 真实调用图（当前实现，非理想架构）

```
DirectorWorkspace.tsx（UI）
  └─ directorAction() fetch → director-server.mjs 路由
       ├─ /project, /catalog, /list_providers …… GET/POST
       ├─ /compile_generation_spec
       │    └─ buildGenerationSpec → compileGenerationPrompt(prompt-compiler.mjs)
       │         → GEN.standardizeGenerationSpec → generation_key(SHA-256)
       │         → engine.lookupCache (SQLite generation.db)   ← 缓存
       ├─ /confirm_generation（需 confirmed:true）
       │    ├─ 缓存命中 → cacheToAsset → 复用 Take（零 API）
       │    ├─ in-flight 同 key → 复用已有 Take（零新增）
       │    └─ 新建 Take + engine.createTask（幂等）
       │         ├─ local-stub：同步 submitGeneration → finalizeTake → recordCache
       │         └─ seedance：置 queued → 后台轮询循环接手
       ├─ 后台轮询循环（setInterval 3s + 退避）
       │    ├─ submitSeedanceTask → seedance.submitGeneration
       │    ├─ pollSeedanceTask → seedance.pollGeneration（只读查询，重试不重建）
       │    └─ downloadSeedanceResult → seedance.downloadResult → 项目资产目录
       │         → finalizeTake → engine.recordCache（下载即缓存）
       ├─ /make_proxy /make_thumbnail /probe_asset /export_final
       │    └─ ffmpeg.mjs spawn(参数数组)（只处理本地素材）
       └─ /export_project_archive → 归档文件

SeedanceWorkerProvider（Node）→ JSON-RPC stdin/stdout
       └─ worker.py → volcenginesdkarkruntime.Ark
            ├─ create_task(content/resolution/ratio/duration/generate_audio/watermark/return_last_frame)
            ├─ get_task / list_tasks / delete
            └─ download_result（校验 Content-Type/大小，存 SHA-256）
```

缺失层（明确标注）：**「Scene 实体」「转场/音量编辑」「素材删除」「尾帧链式参考」「多进程任务锁」** 未实现。

---

## 5. 数据状态图

```
DirectorProject（JSON project.json，store.mjs）
├── shots[]: Shot
│   ├── takes[]: Take {takeId, index, status(11态), generationKey, spec, provider, model,
│   │                taskId→GEN-xxx, assetId→AST-xxx, fileHash, fileSize, width/height/duration,
│   │                error, errorKind(generation|download), retries, downloadAttempts}
│   ├── selectedTakeId → Take
│   ├── clipAssetId → Asset（= 选中 Take 的 assetId，向后兼容）
│   ├── generationTaskId → 任务
│   ├── dirty.generation（Generation dirty）
│   ├── locked / status
│   └── keyframes / compiledPrompt / qc / repairHistory
├── assets[]: Asset {assetId, path(相对 assets/), fileHash, frameDir, manifest, source, license, consent}
├── timeline: { videoTracks[].clips[]{clipId, shotId, assetId/versionRef, start, end, fade…},
│              audioTracks[], captions[], transitions[], global{width,height,fps} }
├── generationTasks[]（legacy 镜像，仅旧路径）
└── renderDirty {flag, reason}（Render dirty）

SQLite generation.db（generation.mjs）
├── generation_cache  {generation_key PK, asset_path, file_hash, width, height, duration, codec, source_task_id}
└── generation_tasks  {task_id PK, project_id, shot_id, take_id, generation_key(idx), provider, model,
                       billing_mode, base_url, status, provider_job_id, retries, download_attempts,
                       last_poll_at, error, error_kind}
```

关系要点：Take 是 Shot 与「任务+资产」的粘合点；`selectedTakeId` 决定 `clipAssetId`；
Timeline clip 通过 `assetId/versionRef` 引用 Asset；Render Job = 时间线 → FFmpeg 导出（无独立持久化对象，每次即时渲染）。

---

## 6. 费用触发矩阵

| 用户操作 | 触发类型 |
|---|---|
| 修改项目名称 / 打开项目 / 自动保存 / 切换预览比例 | No external call |
| 调整镜头顺序 / 修改转场 | No external call（转场无路由，仅数据模型） |
| 修改字幕 / 修改音乐 / 修改时间线 | Local FFmpeg only（Render dirty） |
| 编辑提示词（update_shot） | No external call（仅 Generation dirty） |
| 编译 Prompt | No external call |
| 普通预览（make_proxy / 缩略图） | Local FFmpeg only |
| 生成镜头（确认前） | No external call（返回确认面板） |
| 确认生成（confirm_generation，命中缓存） | No external call（复用） |
| 确认生成（confirm_generation，未命中） | **Paid Seedance generation** |
| 重新生成新 Take（确认后） | **Paid Seedance generation** |
| 生成选中镜头 / 批量生成（确认后） | **Paid Seedance generation** |
| 轮询任务（poll） | Seedance read-only query |
| 取消任务（cancel） | Seedance delete（read-only 管理） |
| 渲染预览 / 导出成片 / 导出归档 | Local FFmpeg only / No external call |

---

## 7. 修复记录（本轮）

| 文件 | 修复 | 原因 | 验证 |
|---|---|---|---|
| `tools-server/director/generation.mjs` | `createTask` 终态排除加入 `ready_for_review/selected`；新增 `findInFlightTask()` | P1-03 / P1-02 | generation.test.mjs「findInFlightTask」「幂等」 |
| `tools-server/director-server.mjs` | `downloadSeedanceResult` 下载阶段 force 迁移；`confirm_generation` 强制 `confirmed:true` + in-flight 复用 + 同步完成置 `ready_for_review`；轮询并发闸门改引擎计数 + 退避；旧端点拒绝 seedance/ark | P1-01/02/04/05/06/07、P2-01 | generation-server.test.mjs（确认闸门/缓存/forceRegenerate/重启） |
| `tools-server/director/ffmpeg.mjs` | `runFfmpeg` 临时文件 + 原子 rename | P2-02 | ffmpeg.test.mjs |
| `src/DirectorWorkspace.tsx` | 确认面板提交带 `confirmed:true` | P1-07 配套 | tsc |
| `tools-server/director/generation.test.mjs` | 新增 findInFlightTask 测试 | P1-02 配套 | — |
| `tools-server/director/generation-server.test.mjs` | 新增确认闸门断言 + 所有 confirm 带 confirmed | P1-07 配套 | — |

修复后测试：director 45 tests（44 pass + 1 paid skip）；skill 13 pass；`tsc --noEmit` 0 错；`vite build` 成功。

---

## 8. 剩余风险（无法在本环境验证的事项）

1. **真实 Seedance 付费链路未验证**：本机无 `volcengine-python-sdk[ark]`、无 `ARK_API_KEY`。只验证了 mock worker 的完整生命周期（成功/失败/取消/超时）与 worker 无 SDK 时的诚实报错。首次真实付费前需按 `docs/security.md` 配置 SDK 与 Key，并接受 paid-e2e 双门禁。
2. **真实 FFmpeg 导出未验证**：本机未安装 ffmpeg。已验证参数数组构造、恶意文件名注入防护、未安装时诚实返回；`brew install ffmpeg` 后需人工跑 `export_final` 验证 MP4（含音画/时长检查）。
3. **TOS 真实上传未验证**：需运行时注入 `TOS_PRESIGNED_URL` 或临时凭证；当前路径诚实返回「未配置」。
4. **多进程并发同工作区**：`generation_tasks` 无唯一约束，跨进程 SELECT-then-INSERT 有理论竞态（单进程内同步原子）。正式版单实例部署风险低。
5. **Keychain→Tauri 启动注入未接线**：`keychain.mjs` 可用，但 `src-tauri/src/lib.rs` 未改（避免破坏既有打包），当前开发走 `ARK_API_KEY` env。
6. **capability validation 未接入**：`validateRequest` 未在提交链中调用（P2-03）。

---

## 9. 第二轮（发布收口）修复记录

| 文件 | 修复 | 验证 |
|---|---|---|
| `seedance/worker.py` | 能力矩阵按模型族（1.x/2.0/2.0-fast）以 Python 为单一事实来源；新增 `get_capabilities` / `validate_generation_request` RPC；`create_task` 防御纵深先校验 | reliability.test.mjs（真实 worker 校验） |
| `seedance/provider.mjs` | `getModelCapabilities` / `validateGenerationRequest`（异步，Node 只缓存）；`envStatus` 诊断 | seedance.test.mjs |
| `providers.mjs` | `getProvider` 未知名称抛错（失败关闭，不再回退 local-stub） | reliability.test.mjs |
| `generation.mjs` | `createTask` 用 `BEGIN IMMEDIATE` 事务；非终态 `(project_id, generation_key)` 唯一部分索引；冲突返回既有任务 | reliability.test.mjs（双连接） |
| `store.mjs` | `saveProject` 乐观锁（`_rev` 检测过期写入抛 concurrency）；`restoreVersion` 以当前磁盘版本为基线 | reliability.test.mjs（过期写入拒绝） |
| `director-server.mjs` | `previewGeneration`（只读）与 `enqueueShotForGeneration`（真实提交）分离；确认闸门 `confirmed:true`；能力校验在预览/提交两处执行；`commitProject` 乐观锁重试（轮询/下载/导出路径）；legacy `submit_video_generation` 收敛到生成引擎；**修复 referenceAssets 字段名丢失（generation key 从未包含参考哈希的严重缺陷）**；新增时间线编辑/RenderJob/尾帧衔接/Asset 删除保护/Scene/Camera·Sound Bible 路由 | generation-server / reliability / product-closure / security-scan |
| `types.mjs` | Scene 实体、Camera/Sound Bible（stableId）、RenderJob 工厂 + 迁移 | product-closure.test.mjs |
| `ffmpeg.mjs` | 原子输出（临时文件 + rename，失败不覆盖旧成片） | ffmpeg-real.test.mjs（装 ffmpeg 后） |
| `paid-e2e.test.mjs` | 门禁改为 `RUN_PAID_E2E=1` + `CONFIRM_PAID_SEEDANCE=YES`；一次 create + 二次同 Spec 命中缓存断言 | 默认 skip |

新增测试文件：`reliability.test.mjs`（7）、`security-scan.test.mjs`（2）、`product-closure.test.mjs`（5）、`ffmpeg-real.test.mjs`（2，装 ffmpeg 后执行）。

---

## 10. 第二轮后期修复（FFmpeg 实测暴露）

| 问题 | 修复 | 证据 |
|---|---|---|
| generation key 从未包含参考素材哈希（`standardizeGenerationSpec` 读 `referenceAssets`，调用方传了 `reference_asset_hashes`） | `buildGenerationSpec` 改传 `referenceAssets` | product-closure「尾帧衔接改 key」测试 |
| FFmpeg filter graph 空段（`[0:v],trim=...`） | pad 直接接首滤镜（ffmpeg.mjs + 旧 render.mjs） | ffmpeg-real 实测 |
| 原子输出临时文件扩展名破坏封装识别 | tmp 保留原扩展名 | ffmpeg-real 实测 |
| 导出只有视频无 AAC 音频 | `inputHasAudio` 探测 + atrim/amix → `[outa]`，48kHz | ffmpeg-real 实测（ffprobe 验证 AAC/48k） |
| `/render_preview`、`/render_final` 未 await `renderTimeline`（ffmpeg 安装前不暴露） | 改为 async + await | integration.test.mjs |
| 环境结果：`brew install ffmpeg` 官方源首轮 HTTP/2 下载失败，`HOMEBREW_CURL_ARGS="--http1.1"` 临时降级重试成功（未改 Homebrew 源） | — | ffmpeg 9.0.1 已装 |
| Tauri 构建证据 | `cargo check` + `cargo build`（debug）均通过（30s） | — |

---

## 11. 真实付费验证记录（2026-08，用户显式授权）

| 项 | 真实结果 |
|---|---|
| 通道：Agent Plan（doubao-seedance-1-0-pro-250528） | 服务端 404 `UnsupportedModel`：「该模型不支持 agent plan 特性」→ 错误原样透传、take 标记 `failed(error_kind=generation)`、**未静默切换通道** ✅ |
| 通道：Platform（/api/v3） | 创建成功 → `succeeded` → 真实下载 MP4 → Take `ready_for_review` ✅ |
| 真实响应结构 | `content: {"video_url": "https://...mp4?X-Tos-..."}`（字符串，非 list[item]）；URL 1 天过期 → 印证「成功即下载」 |
| 修复 | `_extract_result_url` 支持真实 dict 结构；矩阵记录 seedance-1.0 仅 Platform（agent_plan 提前 warning，不阻断） |
| 付费 E2E（platform，5s/480p，一次 create） | **PASS：一次真实 create，第二次同 Spec 命中缓存（无第二次远程任务）** |
| 回归 | director 60 pass + 1 付费 skip；skill 13 pass；tsc/build ✅ |

---

## 12. 导演工作台 UI 重构（三层工作区，2026-08）

**原页面问题（真实）**：多列纵向压缩主工作区；Agent 对话窄列导致中文竖排；顶部技术标签平铺；底部时间线/输入/提示重叠；空状态无主操作；无阶段感。

**新信息架构**：
- 第一层：全局侧栏（240px，可收起 64px；品牌/新建/搜索/最近项目/阶段/Agent 在线态）
- 第二层：导演工作区（主区 ≥760px；项目头栏 + 工作流导航 策划/剧本/分镜/生成/剪辑/审片/导出 + 项目状态 Popover 收纳技术参数）
- 第三层：上下文检查器（320px，可拖动 260–440、可收起；仅选中对象显示）
- 底部：Agent 抽屉（默认紧凑输入栏，展开 ≤420px / 最大化；Escape 关闭；执行模式；快捷指令；费用确认面板保留）

**验收（程序化测量，3 尺寸）**：无竖排中文 / 无横向溢出 / 面板无重叠 / Inspector 按选中显示 / Timeline 仅剪辑页 / Agent 抽屉 ≥360px / 侧栏 240→64 / 分镜卡片 3 张。截图：`docs/reviews/screenshots/director-{shots,plan}-{2480x1600,1920x1080,1440x900}.png`。

**组件拆分**：`src/director/{design,AppShell=DirectorWorkspace,ProjectHeader,WorkflowNavigation,ProjectStatusPopover,ContextInspector,AgentDrawer,EmptyState,ShotCard,GenerationQueue,PreviewPlayer,TimelinePanel,RenderJobPanel,phases}.tsx`。

---

## 13. Agent 视角 Provider 可见性缺陷（真实用户上报，已修复）

**现象**：实际使用中 Agent 报告「火山方舟通道不可用」：`list_providers` 中 ark available:false、无 arkcli、项目目录 grep 不到配置、compile 返回 blocked。

**根因（已复现）**：`seedanceCaps()` 改为返回 Promise 后，`list_providers` 与 `/catalog` 仍同步调用 → Agent 视角 seedance 被序列化为空对象（实测 `providers: ['local-stub','ark',None]`），只能看到 legacy ark（arkcli 未装 → available:false），于是误判通道不可用。Agent 用 bash 在项目目录探测配置也是误导（SDK 内嵌、Key 在 Keychain、由 director-server 提供，不在工作区）。

**修复**：
1. `list_providers` / `catalog` 异步 await seedance 能力；不可用的 `ark` 从可见列表隐藏。
2. `provider=ark` 在 preview 与 enqueue 两处拒绝，返回 `use_seedance` 指引。
3. 通道标签仅 local-stub 显示「本地占位」，否则按 billing_mode 显示。
4. DIRECTOR_SYSTEM 增加规则：视频生成必须用 provider=seedance，判断可用性看 list_providers 的 available，不在项目目录 grep、不依赖本机 python；绝不用 local-stub 假装生成。

**验证**（实测）：`list_providers` → local-stub + seedance(available:True)；`compile provider=ark` → `use_seedance`；`compile provider=seedance` → Platform、校验通过。回归 60 pass + 1 付费 skip。
