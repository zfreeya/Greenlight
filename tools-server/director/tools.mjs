/* ============================================================================
 * Harness Director — 结构化工具 Schema（单一事实来源）
 *
 * 供 /catalog 暴露给前端 Agent（OpenAI function schema）与 UI。
 * 工具返回结构化结果，不把供应商原始 JSON 默认展示给用户。
 * ==========================================================================*/

const S = (description) => ({ type: "string", description });
const N = (description) => ({ type: "number", description });
const B = (description) => ({ type: "boolean", description });
const OBJ = (description) => ({ type: "object", description });
const ARR = (description, items) => ({ type: "array", description, items });

export const TOOLS = [
  { name: "get_director_project", description: "读取当前 Director 项目完整状态（阶段/Bible/镜头/资产/时间线/队列）。", parameters: { type: "object", properties: { projectId: S("项目 ID") }, required: ["projectId"] } },
  { name: "create_director_project", description: "创建或初始化 Director 项目（标题、类型、受众、平台、时长、宽高比、目的、核心信息、观看后行动、预算、截止时间等）。", parameters: { type: "object", properties: { projectId: S("项目 ID"), title: S("标题"), format: S("项目类型，见 catalog"), targetAudience: S("目标受众"), targetPlatform: S("目标平台"), targetDuration: N("目标时长秒"), aspectRatio: S("宽高比"), purpose: S("目的"), coreMessage: S("核心信息"), desiredAction: S("观看后行动"), budgetLimit: N("预算上限，0=不限"), deadline: S("截止时间") }, required: ["projectId"] } },
  { name: "set_project_phase", description: "推进/回退项目阶段（校验阶段依赖与确认闸门）。", parameters: { type: "object", properties: { projectId: S("项目 ID"), phase: S("目标阶段"), force: B("是否跳过闸门（默认 false）") }, required: ["projectId", "phase"] } },
  { name: "confirm_gate", description: "记录用户对某确认闸门（Creative Brief/剧本/导演/节奏/分镜/关键帧/批量生成/粗剪/导出）的确认。", parameters: { type: "object", properties: { projectId: S("项目 ID"), gate: S("闸门名"), auto: B("是否自动模式") }, required: ["projectId", "gate"] } },
  { name: "import_script", description: "导入已有剧本原文（保留事实；后续 analyze_script 做结构化）。", parameters: { type: "object", properties: { projectId: S("项目 ID"), script: S("剧本原文"), format: S("text|markdown|pdf|url") }, required: ["projectId", "script"] } },
  { name: "analyze_script", description: "写入结构化故事（logline/梗概/人物/结构/场景/剧本）。", parameters: { type: "object", properties: { projectId: S("项目 ID"), story: OBJ("结构化 story 对象") }, required: ["projectId", "story"] } },
  { name: "update_project_bible", description: "更新项目 Bible（story/characters/locations/visual/continuity），逐项含 stableId 与版本。", parameters: { type: "object", properties: { projectId: S("项目 ID"), bible: OBJ("要更新的 bible 分区"), section: S("story|characters|locations|visual|continuity"), reason: S("修改原因") }, required: ["projectId", "bible"] } },
  { name: "create_director_treatment", description: "写入导演定调（至少两个有实质差异的方向，各含观众感受/镜头距离/运动/构图/色彩光线/剪辑/声音/风险/成本）。", parameters: { type: "object", properties: { projectId: S("项目 ID"), treatments: ARR("方向数组", OBJ("treatment")), selected: N("选中的方向索引") }, required: ["projectId", "treatments"] } },
  { name: "create_rhythm_plan", description: "写入节奏计划（逐场情节/情绪强度、时长、镜头密度、景别重心、转场、镜头组、信息释放、呼吸点、高潮铺垫 + 总时长校验）。", parameters: { type: "object", properties: { projectId: S("项目 ID"), rhythmPlan: OBJ("节奏计划") }, required: ["projectId", "rhythmPlan"] } },
  { name: "create_shot_groups", description: "创建镜头组。", parameters: { type: "object", properties: { projectId: S("项目 ID"), groups: ARR("镜头组", OBJ("group")) }, required: ["projectId", "groups"] } },
  { name: "create_shot_list", description: "批量创建结构化镜头（Blocking 先于摄影机设计；每镜有叙事目的与起止状态）。", parameters: { type: "object", properties: { projectId: S("项目 ID"), shots: ARR("镜头数组", OBJ("shot")) }, required: ["projectId", "shots"] } },
  { name: "update_shot", description: "更新单个镜头（状态迁移受状态机约束）。", parameters: { type: "object", properties: { projectId: S("项目 ID"), shotId: S("镜头 ID"), patch: OBJ("要更新的字段"), status: S("目标状态（可选）"), reason: S("修改原因") }, required: ["projectId", "shotId", "patch"] } },
  { name: "create_storyboard", description: "写入分镜板（文本分镜/构图说明/草图路径）。", parameters: { type: "object", properties: { projectId: S("项目 ID"), storyboard: ARR("分镜条目", OBJ("board")) }, required: ["projectId", "storyboard"] } },
  { name: "create_keyframe", description: "写入关键帧（首帧/尾帧/角色/场景/道具/风格参考/mask/构图草图）与关键帧 Prompt（与运动 Prompt 分开）。", parameters: { type: "object", properties: { projectId: S("项目 ID"), shotId: S("镜头 ID"), keyframes: OBJ("关键帧"), keyframePrompt: S("关键帧 Prompt") }, required: ["projectId", "shotId"] } },
  { name: "compile_generation_prompt", description: "按可信优先级组装生成 Prompt（含注入防御）；关键帧与运动 Prompt 分开。", parameters: { type: "object", properties: { projectId: S("项目 ID"), shotId: S("镜头 ID"), provider: S("Provider 名"), stageSkill: S("阶段 Skill 名") }, required: ["projectId", "shotId"] } },
  { name: "estimate_generation_cost", description: "预估单个镜头生成成本。", parameters: { type: "object", properties: { projectId: S("项目 ID"), shotId: S("镜头 ID"), provider: S("Provider 名") }, required: ["projectId", "shotId"] } },
  { name: "submit_video_generation", description: "提交视频生成。首次调用（不带 confirmed）返回付费确认面板（费用/通道/缓存），不会真正提交；必须先把费用展示给用户并获得明确同意后，再带 confirmed=true 重新调用才会真正进入队列（相同请求命中缓存不重复计费）。", parameters: { type: "object", properties: { projectId: S("项目 ID"), shotId: S("镜头 ID"), provider: S("Provider：seedance"), model: S("模型 ID"), billing_mode: S("agent_plan|platform"), confirmed: B("用户已同意费用（true 才真正提交）") }, required: ["projectId", "shotId"] } },
  { name: "poll_video_generation", description: "轮询生成任务状态。", parameters: { type: "object", properties: { projectId: S("项目 ID"), taskId: S("任务 ID") }, required: ["projectId", "taskId"] } },
  { name: "cancel_generation", description: "取消生成任务。", parameters: { type: "object", properties: { projectId: S("项目 ID"), taskId: S("任务 ID") }, required: ["projectId", "taskId"] } },
  { name: "import_generated_clip", description: "把生成结果导入为资产并记录来源/许可/授权/提示词/种子/输入资产。", parameters: { type: "object", properties: { projectId: S("项目 ID"), asset: OBJ("资产记录") }, required: ["projectId", "asset"] } },
  { name: "run_clip_qc", description: "对生成片段做五维 QC（技术/人物/空间/运动/叙事），输出 pass/repair/regenerate/redesign/reject。", parameters: { type: "object", properties: { projectId: S("项目 ID"), shotId: S("镜头 ID"), assetId: S("资产 ID") }, required: ["projectId", "shotId", "assetId"] } },
  { name: "compare_clip_versions", description: "比较两个片段版本。", parameters: { type: "object", properties: { projectId: S("项目 ID"), assetIdA: S("资产 A"), assetIdB: S("资产 B") }, required: ["projectId", "assetIdA", "assetIdB"] } },
  { name: "place_clip_on_timeline", description: "把通过 QC 的片段放到非破坏性时间线。", parameters: { type: "object", properties: { projectId: S("项目 ID"), shotId: S("镜头 ID"), assetId: S("资产 ID"), start: N("起始秒"), trackId: S("轨道 ID") }, required: ["projectId", "shotId", "assetId"] } },
  { name: "create_voiceover", description: "创建旁白/对白语音资产（角色/授权/语言/语速/情绪/文本/时间码/版本）。", parameters: { type: "object", properties: { projectId: S("项目 ID"), voiceover: OBJ("语音资产") }, required: ["projectId", "voiceover"] } },
  { name: "add_music", description: "添加音乐/音效到音频轨（含音量/淡入淡出）。", parameters: { type: "object", properties: { projectId: S("项目 ID"), assetId: S("音频资产"), kind: S("music|sfx|ambience|narration"), start: N("起始秒"), volume: N("音量"), trackId: S("轨道") }, required: ["projectId", "assetId"] } },
  { name: "generate_captions", description: "生成字幕并做时间轴对齐。", parameters: { type: "object", properties: { projectId: S("项目 ID"), captions: ARR("字幕", OBJ("cap")) }, required: ["projectId", "captions"] } },
  { name: "render_preview", description: "渲染预览（把时间线编译到 FFmpeg）。", parameters: { type: "object", properties: { projectId: S("项目 ID") }, required: ["projectId"] } },
  { name: "render_final", description: "渲染最终 MP4（时间线→FFmpeg；版权清单随导出）。", parameters: { type: "object", properties: { projectId: S("项目 ID") }, required: ["projectId"] } },
  { name: "export_project_archive", description: "导出项目归档（分镜表/Bible/素材清单/版权清单）。", parameters: { type: "object", properties: { projectId: S("项目 ID") }, required: ["projectId"] } },
  { name: "list_skills", description: "列出 Director Skills 与当前阶段路由。", parameters: { type: "object", properties: { projectId: S("项目 ID（可选）") } } },
  { name: "list_providers", description: "列出可用生成 Provider 与能力。", parameters: { type: "object", properties: {} } },
  { name: "list_generation_queue", description: "列出生成队列（状态/进度/成本/重试/错误）。", parameters: { type: "object", properties: { projectId: S("项目 ID") }, required: ["projectId"] } },
  { name: "queue_control", description: "生成队列控制：暂停/继续/调整优先级/设并发/设预算上限。set_budget 是金额（仅记录，平台不回传扣费数据无法执行）；set_paid_cap 是付费新生成条数上限（真实执行：达到后新生成会被拒绝，local-stub 免费不占额度）。", parameters: { type: "object", properties: { projectId: S("项目 ID"), action: S("pause|resume|set_concurrency|set_budget|set_paid_cap|reprioritize"), value: N("可选数值"), taskId: S("重排序任务 ID") }, required: ["projectId", "action"] } },

  /* ---- 生成引擎：Spec / 缓存 / Take / 确认（付费保护） ---- */
  { name: "compile_generation_spec", description: "为镜头标准化 Generation Spec 并计算 generation_key，做缓存命中检查，返回确认面板数据（Provider/通道/模型/分辨率/时长/音频/缓存/费用）。绝不调用生成 API。", parameters: { type: "object", properties: { projectId: S("项目 ID"), shotId: S("镜头 ID"), provider: S("Provider"), model: S("模型 ID"), billing_mode: S("agent_plan|platform"), resolution: S("分辨率"), ratio: S("宽高比"), duration: N("单镜头时长"), generate_audio: B("是否生成音频"), watermark: B("水印"), return_last_frame: B("返回尾帧") }, required: ["projectId", "shotId"] } },
  { name: "confirm_generation", description: "付费提交确认：在 compile_generation_spec 返回确认面板且用户明确同意费用后调用（必须 confirmed:true）。命中缓存则复用不调用 API；未命中才创建新 Take 并进入队列。可传 shotIds 数组批量提交；batchCap 可限制本次最多「新生成」条数（达到上限后剩余镜头本次不提交，不产生新调用）。", parameters: { type: "object", properties: { projectId: S("项目 ID"), shotId: S("镜头 ID"), shotIds: ARR("批量镜头 ID 数组", S("镜头 ID")), provider: S("Provider：seedance"), model: S("模型 ID"), billing_mode: S("agent_plan|platform"), batchCap: N("可选：本次最多新生成条数（缓存命中不占上限）"), confirmed: B("必须为 true") }, required: ["projectId"] } },
  { name: "generate_shot", description: "生成当前镜头：先编译 Spec 返回确认面板；confirmed=true 才真正提交。", parameters: { type: "object", properties: { projectId: S("项目 ID"), shotId: S("镜头 ID"), provider: S("Provider"), model: S("模型"), billing_mode: S("通道"), confirmed: B("是否已确认（默认 false）") }, required: ["projectId", "shotId"] } },
  { name: "generate_selected_shots", description: "批量生成：不带 confirmed 时只读预览（返回每镜缓存命中/新生成/校验与汇总，不创建任务）；用户同意后带 confirmed=true 才真正提交。shotIds 可精确指定；batchCap 限制本次最多新生成条数，达到上限后剩余镜头本次不提交。", parameters: { type: "object", properties: { projectId: S("项目 ID"), shotIds: ARR("镜头 ID 数组（缺省取全部可生成镜头）", S("镜头 ID")), provider: S("Provider：seedance"), model: S("模型"), billing_mode: S("agent_plan|platform"), batchCap: N("可选：本次最多新生成条数"), confirmed: B("是否已确认（默认 false）") }, required: ["projectId"] } },
  { name: "set_project_model", description: "设置项目的 Seedance 模型 ID（写入 production.modelVersions[0]，后续生成默认使用；可被显式 model 参数覆盖）。模型未配置时生成会因『未收录模型能力』被拒绝，属预期失败关闭。", parameters: { type: "object", properties: { projectId: S("项目 ID"), model: S("Seedance 模型 ID，如 doubao-seedance-1-0-pro-250528") }, required: ["projectId", "model"] } },
  { name: "run_continuity_check", description: "连续性检查 v0：按时间线顺序（时间线为空时按镜头 index）取已通过 Take，用本地 FFmpeg 抽相邻镜头（A 末帧 vs B 首帧）并对比色彩统计（亮度/RGB 均值/亮度直方图），输出差异清单并写 CSV。结果绑定被检查的 Take 版本（takeIdA/takeIdB）。只做颜色级对比，阈值待真实数据校准。", parameters: { type: "object", properties: { projectId: S("项目 ID") }, required: ["projectId"] } },
  { name: "create_shot_list_from_template", description: "用产品类 4 镜头模板创建镜头表（特写/桌面/手持/促销结尾），仅限空项目；同时把产品建为角色卡（一致性锚点，characterId 返回）。对应 07 保温杯第一单的分镜模板。", parameters: { type: "object", properties: { projectId: S("项目 ID"), template: S("模板名，当前仅 product_4shot"), product: S("产品名，缺省用项目标题") }, required: ["projectId"] } },
  { name: "order_summary", description: "订单记账：汇总项目镜头/Take/任务（含重试次数、预计与实际成本、时间），写 CSV 到导出目录。前 5 单必须逐单记账校准成本。", parameters: { type: "object", properties: { projectId: S("项目 ID") }, required: ["projectId"] } },
  { name: "select_take", description: "选择某镜头当前的 Take。", parameters: { type: "object", properties: { projectId: S("项目 ID"), shotId: S("镜头 ID"), takeId: S("Take ID") }, required: ["projectId", "shotId", "takeId"] } },
  { name: "lock_take", description: "锁定某镜头当前的 Take（不再重新生成）。", parameters: { type: "object", properties: { projectId: S("项目 ID"), shotId: S("镜头 ID"), takeId: S("Take ID") }, required: ["projectId", "shotId", "takeId"] } },
  { name: "list_takes", description: "列出某镜头所有 Take 与当前选中项。", parameters: { type: "object", properties: { projectId: S("项目 ID"), shotId: S("镜头 ID") }, required: ["projectId", "shotId"] } },
  { name: "retry_download", description: "仅下载失败时可重试下载（不重新生成）。", parameters: { type: "object", properties: { projectId: S("项目 ID"), shotId: S("镜头 ID"), takeId: S("Take ID") }, required: ["projectId", "shotId", "takeId"] } },

  /* ---- FFmpeg 本地后期 ---- */
  { name: "ffmpeg_status", description: "检测 FFmpeg/ffprobe 并返回安装计划。", parameters: { type: "object", properties: {} } },
  { name: "ffmpeg_install_plan", description: "返回 FFmpeg 安装计划（Homebrew/架构/镜像）。", parameters: { type: "object", properties: {} } },
  { name: "probe_asset", description: "探测资产时长/FPS/尺寸/编码/音频信息。", parameters: { type: "object", properties: { projectId: S("项目 ID"), assetId: S("资产 ID") }, required: ["projectId", "assetId"] } },
  { name: "make_proxy", description: "生成低码率代理视频（本地预览，不调用生成 API）。", parameters: { type: "object", properties: { projectId: S("项目 ID"), assetId: S("资产 ID"), width: N("宽"), fps: N("帧率") }, required: ["projectId", "assetId"] } },
  { name: "make_thumbnail", description: "抽取封面/缩略图。", parameters: { type: "object", properties: { projectId: S("项目 ID"), assetId: S("资产 ID"), atSec: N("时间秒") }, required: ["projectId", "assetId"] } },
  { name: "export_final", description: "用 FFmpeg 导出最终 MP4（H.264/AAC/yuv420p/faststart/48kHz，可选多宽高比）。", parameters: { type: "object", properties: { projectId: S("项目 ID"), crf: N("CRF"), aspectRatios: ARR("宽高比数组", S("如 9:16")) }, required: ["projectId"] } },

  /* ---- 参考素材上传 ---- */
  { name: "prepare_reference_upload", description: "为本地参考素材准备远程引用（RemoteURL/TOS/DataURI，哈希缓存不重复上传）。", parameters: { type: "object", properties: { projectId: S("项目 ID"), assetId: S("资产 ID"), kind: S("remote_url|tos|data_uri"), role: S("参考角色"), remoteUrl: S("远程 URL") }, required: ["projectId", "assetId"] } },
  { name: "asset_upload_status", description: "查询素材上传状态（是否已上传/URL 是否过期）。", parameters: { type: "object", properties: { projectId: S("项目 ID"), assetId: S("资产 ID") }, required: ["projectId", "assetId"] } },

  /* ---- 产品闭环：时间线编辑 / RenderJob / 尾帧衔接 / 删除保护 / Scene ---- */
  { name: "update_clip", description: "编辑时间线 clip（trim/音量/mute/fade）→ 只标记 Render dirty，不触发生成。", parameters: { type: "object", properties: { projectId: S("项目 ID"), clipId: S("clip ID"), start: N("起始秒"), end: N("结束秒"), volume: N("音量 0-1"), mute: B("静音"), fadeIn: N("淡入秒"), fadeOut: N("淡出秒") }, required: ["projectId", "clipId"] } },
  { name: "reorder_clips", description: "按 shotIds 重排时间线镜头顺序 → 只标记 Render dirty。", parameters: { type: "object", properties: { projectId: S("项目 ID"), shotIds: ARR("镜头 ID 顺序", S("镜头 ID")) }, required: ["projectId", "shotIds"] } },
  { name: "add_transition", description: "添加转场 → 只标记 Render dirty。", parameters: { type: "object", properties: { projectId: S("项目 ID"), fromClipId: S("起始 clip"), toClipId: S("结束 clip"), type: S("crossfade|cut|fade") }, required: ["projectId", "fromClipId", "toClipId"] } },
  { name: "set_audio_clip", description: "音乐/环境声音量与 mute → 只标记 Render dirty。", parameters: { type: "object", properties: { projectId: S("项目 ID"), clipId: S("音频 clip ID"), volume: N("音量"), mute: B("静音") }, required: ["projectId", "clipId"] } },
  { name: "create_render_job", description: "创建并执行 RenderJob（FFmpeg 导出，只处理本地素材，不触发 Seedance），记录渲染历史。", parameters: { type: "object", properties: { projectId: S("项目 ID"), crf: N("CRF"), outputProfile: S("输出配置") }, required: ["projectId"] } },
  { name: "list_render_jobs", description: "列出项目渲染历史与状态/错误。", parameters: { type: "object", properties: { projectId: S("项目 ID") }, required: ["projectId"] } },
  { name: "extract_last_frame", description: "从选中 Take 提取尾帧为独立 Asset（记录来源 Take）。", parameters: { type: "object", properties: { projectId: S("项目 ID"), shotId: S("镜头 ID"), takeId: S("Take ID") }, required: ["projectId", "shotId"] } },
  { name: "use_as_first_frame", description: "把尾帧 Asset 设为下一镜头首帧参考 → 改变 generation key，绝不自动生成。", parameters: { type: "object", properties: { projectId: S("项目 ID"), shotId: S("镜头 ID"), frameAssetId: S("尾帧资产 ID") }, required: ["projectId", "shotId", "frameAssetId"] } },
  { name: "delete_asset", description: "删除资产（被引用时拒绝并返回引用列表；未引用时需 trash:true 移入 Trash 可恢复）。", parameters: { type: "object", properties: { projectId: S("项目 ID"), assetId: S("资产 ID"), trash: B("确认移入 Trash") }, required: ["projectId", "assetId"] } },
  { name: "create_scene", description: "创建 Scene 实体（正式化场景）。", parameters: { type: "object", properties: { projectId: S("项目 ID"), scene: OBJ("场景字段") }, required: ["projectId"] } },
  { name: "update_scene", description: "更新 Scene。", parameters: { type: "object", properties: { projectId: S("项目 ID"), sceneId: S("场景 ID"), patch: OBJ("字段") }, required: ["projectId", "sceneId"] } },
  { name: "create_camera_bible", description: "创建 Camera Bible 条目（stableId 引用，含镜头/焦段/运镜/构图/限制）。", parameters: { type: "object", properties: { projectId: S("项目 ID"), entry: OBJ("camera bible 条目") }, required: ["projectId"] } },
  { name: "create_sound_bible", description: "创建 Sound Bible 条目（stableId 引用，含环境声/对白/音乐/响度策略）。", parameters: { type: "object", properties: { projectId: S("项目 ID"), entry: OBJ("sound bible 条目") }, required: ["projectId"] } },

  /* ---- 反向工作流（O2-KR2）：从已有视频反推镜头表，先出画面再补设定 ---- */
  { name: "import_user_video", description: "导入用户已有视频（本地绝对路径）为资产：ffprobe 校验是视频，复制进项目资产目录，返回时长/分辨率/帧率。只接受用户主动提供的路径，不扫目录。全程本地，不调用付费通道。", parameters: { type: "object", properties: { projectId: S("项目 ID"), path: S("本地视频文件绝对路径"), title: S("可选标题，缺省用文件名") }, required: ["projectId", "path"] } },
  { name: "sample_frames", description: "对已导入的用户视频按固定间隔抽帧（FFmpeg 本地），写 manifest.frames。抽帧免费；帧列表供 Agent 反推镜头表与用户预览。", parameters: { type: "object", properties: { projectId: S("项目 ID"), assetId: S("视频资产 ID"), intervalSec: N("抽帧间隔秒，默认 3"), maxFrames: N("最多帧数，默认 30") }, required: ["projectId", "assetId"] } },
  { name: "reverse_storyboard", description: "反推镜头草稿：读取已导入+已抽帧的视频信息（时长/帧序列），返回结构化素材供 Agent 分段（segments: start/end/景别/运镜/主体/叙事目的）。草稿不写入项目，必须经用户确认后由 create_shot_list 写入正式镜头表。全程免费。", parameters: { type: "object", properties: { projectId: S("项目 ID"), assetId: S("视频资产 ID"), notes: S("用户对分段的补充说明（可选）") }, required: ["projectId", "assetId"] } },
];

export function toolCatalog() {
  return TOOLS.map((t) => ({ type: "function", function: t }));
}
