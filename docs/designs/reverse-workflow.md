# 设计：倒着走，从已有视频反推制作链（O2-KR2）

对应 OKR：O2 人的工作方式。状态：设计稿（2026-08-26），未实现。
目标：让"先有一段画面，再补设定"成为可行路径。市面上工具都是"写提示词 → 出视频"，
没有"给我一段已有的视频 → 反推出镜头表 → 继续制作"的入口。这是本产品最值得对外讲的差异化点。

## 1. 现状与差距

已有可复用的部件：

- 素材导入：`import_generated_clip`（导入资产并记录来源/许可）。
- 帧提取：`extract_last_frame`（FFmpeg 抽尾帧成资产）；`/asset` 支持 HTTP Range 播放。
- 镜头写入：`create_shot_list`（批量创建结构化镜头）、`update_shot`、`create_keyframe`。
- 生成链：compile → 确认面板 → confirm_generation（batchCap 硬上限）→ 队列。

差距（缺的就是"反向"这一段）：

- 没有"导入用户已有视频"的一等入口（import_generated_clip 语义是"生成结果"，不是"用户素材"）。
- 没有抽多帧（首/中/尾 + 按秒采样）的能力，只有尾帧。
- 没有"从视频反推镜头表"的工具，Agent 没有任何依据去分段。
- 分镜页/生成页空状态没有"从已有视频开始"的主操作。

## 2. 用户流程

1. 空项目（或任意阶段）点"从已有视频开始"，选本地 mp4/mov。
2. 导入为素材（kind=video_user，来源 user_import），FFmpeg probe 出时长/分辨率/帧率。
3. 按 3-5 秒间隔抽帧，存 frameDir + manifest，界面显示帧网格。
4. Agent 依据时长、帧序列、字幕/音轨信息（如有）反推分段：每段给 起止/景别/运镜/主体/叙事目的，产出"镜头草稿"（不写入正式 shots）。
5. 用户在界面编辑草稿（改时长/目的/顺序），确认后经 create_shot_list 写入正式镜头表。
6. 进入正常流程：生成（可用抽出的帧做首帧参考）→ 剪辑 → 导出。

全程无付费调用，导入/抽帧/反推都是本地或 Agent 文本工作。

## 3. 服务端契约（设计）

### import_user_video（新）

入参：projectId, path（本地绝对路径）, title?
行为：校验文件存在且为视频（ffprobe），写入资产（kind="video_user", source="user_import"），
记录 duration/width/height/codec，生成 frameDir。返回 assetId。
安全：只接受用户主动提供的路径，不扫目录；路径不做拼接遍历。

### sample_frames（新，或扩展 extract_last_frame）

入参：projectId, assetId, intervalSec?（默认 3），maxFrames?（默认 30）
行为：FFmpeg 按间隔抽帧到 frameDir，写 manifest.frames（复用现有帧清单结构）。
复用现有 /asset 播放与 ShotCard 首帧缩略图逻辑。

### reverse_storyboard（新工具，Agent 驱动）

入参：projectId, assetId, notes?
行为：不写正式数据。返回结构化草稿：{ segments: [{ start, end, shotSize, cameraMovement, subject, narrativePurpose }] }。
Agent 拿到草稿后展示给用户，用户确认/编辑后调 create_shot_list 写入。
实现上可以是纯 Agent 文本工作（读取 probe 信息 + 帧列表 + 用户说明），
也可以做成服务端 helper（帧时间戳 + 时长 → 分段建议）。第一版走纯 Agent，不加服务端状态。

### 阶段约束

反向流程不设阶段要求。任意阶段可导入与反推；草稿确认写入 create_shot_list 与正常流程一致。

## 4. 界面（设计）

- 分镜页空状态增加第二主操作："从已有视频开始"（主操作仍是"让 AI 拆分镜头"）。
- 导入后出现"反推"面板：帧网格（复用 d-shot-grid 样式）+ 时长/分辨率信息 + "让 Agent 反推镜头表"按钮。
- 草稿编辑：表格逐行改 起止/景别/运镜/主体/叙事目的，底部"写入镜头表"（create_shot_list）。
- 生成页提示：首帧参考可用（第一版不做自动注入，用户可在关键帧里手选）。

## 5. 边界与诚实边界

- 草稿不自动写入：反推结果只是建议，必须经用户确认才成为正式镜头，不覆盖已有镜头。
- 不做自动人脸/角色识别：反推只依据时长、帧序列、用户说明。识别角色是另一件事，超出本 O。
- 不做自动成片：反推镜头表后仍走正常生成（要花钱的部分照旧有确认面板）。
- 抽帧是本地 FFmpeg，免费；反推是 Agent 文本，免费；只有后续生成走付费通道。
- 缓存语义不变：prompt 相同即命中缓存，反向流程不影响 generation_key。

## 6. 验收（可执行测试）

1. import_user_video：导入真实 mp4（复用本地生成产物或用户文件）→ 资产存在、probe 信息正确。
2. sample_frames：interval=3s 抽帧数量 = ceil(duration/3)（上限内），帧文件存在且可经 /asset 播放。
3. reverse_storyboard：对已知 15s 视频返回 ≥2 段，每段 start/end 合法且覆盖全程。
4. 草稿确认写入 create_shot_list 后，shots 数量正确、可进入生成。
5. 全程无付费调用（mock worker 断言 create_task 未被调用）。

## 7. 分期

- 一期（本 O）：导入 + 抽帧 + 反推 + 草稿编辑写入，走通"先出画面"。
- 二期（不在本 O）：抽出的首帧自动注入生成 Spec 做首帧参考（需要用户确认，避免隐性改变 prompt 与缓存键）。
- 三期（不在本 O）：自动角色/场景识别。

## 8. 影响面

- 服务端：director-server.mjs 新增 2 个路由 + tools.mjs 新增 3 个工具 schema。
- 前端：分镜页空状态、反推面板（新组件）、草稿编辑表格。
- 不改：SQLite schema（复用 assets/frames 结构）、缓存、付费闸门。
