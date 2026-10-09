/* ============================================================================
 * Harness Director — 前端类型 + 客户端 + 工具 Schema
 *
 * 服务端（tools-server/director-server.mjs）是数据与工具逻辑的单一事实来源；
 * 本文件提供前端 UI 渲染所需类型、HTTP 客户端，以及 Agent 工具 Schema
 * （与服务端 tools.mjs 一致；运行时优先从 /catalog 拉取，静态列为兜底）。
 * ==========================================================================*/

/* ---------------- 类型（与服务端 JSON 对齐，供 UI 渲染） ---------------- */
export interface DirectorProject {
  projectId: string;
  title: string;
  format: string;
  targetAudience: string;
  targetPlatform: string;
  targetDuration: number;
  aspectRatio: string;
  fps: number;
  resolution: string;
  language: string;
  purpose: string;
  coreMessage: string;
  desiredAction: string;
  productionMode: string;
  budgetLimit: number;
  deadline: string;
  phase: string;
  completedPhases: string[];
  story: Record<string, unknown> & { characters?: unknown[]; scenes?: unknown[] };
  direction: Record<string, unknown>;
  production: { providers?: unknown[]; actualCost?: number; concurrencyLimit?: number; modelVersions?: unknown[]; budgetLimit?: number; paidGenerationCap?: number; paidSubmissions?: number };
  bible: {
    storyBible?: Record<string, unknown>;
    characters: DirectorCharacter[];
    locations: DirectorLocation[];
    visual: { texture?: string; color?: string[]; light?: string[]; motifs?: string[]; forbidden?: string[]; stableId?: string };
    continuity: DirectorContinuity[];
  };
  creativeBrief: Record<string, unknown> | null;
  directorTreatments: DirectorTreatment[];
  selectedTreatment: number | null;
  rhythmPlan: { scenes?: unknown[]; totalDuration?: number; durationCheck?: unknown } | null;
  shotGroups: unknown[];
  storyboard: unknown[];
  shots: DirectorShot[];
  assets: DirectorAsset[];
  generationTasks: DirectorTask[];
  timeline: DirectorTimeline;
  voiceovers?: unknown[];
  confirmations: Record<string, { at: number; auto?: boolean }>;
  issues: unknown[];
  thirdParty: unknown[];
  importedScript?: { text: string; format: string };
  queuePaused?: boolean;
  renderDirty?: { flag?: boolean; reason?: string; at?: number };
  scenes?: DirectorScene[];
  renderJobs?: DirectorRenderJob[];
  trash?: { assetId: string; trashedAt: number; path?: string; reason?: string }[];
  continuityChecks?: { at?: number; pairs?: ContinuityPair[]; csvPath?: string; orderBasis?: "timeline" | "shot_index" };
  createdAt: number;
  updatedAt: number;
  version: number;
}

/** 连续性检查 v0：相邻镜头色彩差异（A 末帧 vs B 首帧），绑定被检查的 Take 版本 */
export interface ContinuityPair {
  shotIdA: string; shotIdB: string;
  takeIdA?: string | null; takeIdB?: string | null;
  lumaDiff?: number; rgbDiff?: number; histDiff?: number;
  verdict: "ok" | "warn" | "error"; error?: string;
}

export interface DirectorScene {
  sceneId: string; title: string; narrativePurpose?: string; timeOfDay?: string;
  locationRefs?: string[]; characterRefs?: string[]; mood?: string; color?: string;
  soundDesign?: string; continuityNotes?: string; shotIds?: string[];
  createdAt?: number; updatedAt?: number;
}

export interface DirectorRenderJob {
  renderJobId: string; projectId?: string; timelineRevision?: number; outputProfile?: string;
  ffmpegArgsSummary?: string; inputAssets?: string[]; status: string; progress?: number;
  outputPath?: string; error?: string | null; createdAt?: number; startedAt?: number; finishedAt?: number;
}

export interface DirectorCharacter { characterId: string; stableId: string; name: string; age?: number; bodyType?: string; face?: string; hair?: string; outfit?: string; accessories?: string; posture?: string; gestures?: string; voice?: string; referenceImages?: string[]; immutableTraits?: string[]; }
export interface DirectorLocation { locationId: string; stableId: string; name: string; layout?: string; timeOfDay?: string; weather?: string; lightSources?: string[]; color?: string; fixedProps?: string[]; referenceImages?: string[]; }
export interface DirectorContinuity { stableId: string; shotId: string; characterPositions?: unknown; prevShotEndState?: string; nextShotStartState?: string; [k: string]: unknown; }

export interface DirectorTreatment { name?: string; audienceFeeling?: string; cameraDistance?: string; cameraMovement?: string; composition?: string; colorLight?: string; editing?: string; sound?: string; risk?: string; cost?: string; executableFeatures?: string[]; [k: string]: unknown; }

export interface DirectorShot {
  shotId: string; sceneId: string; shotGroupId: string; index: number; status: string;
  narrativePurpose: string; duration: number; shotSize: string; angle: string; lens: string;
  cameraPosition: string; cameraMovement: string; subject: string; startState: string;
  primaryAction: string; endState: string; performance?: string; composition?: string;
  lighting?: string; color?: string; environment?: string; props?: string[]; dialogue?: string;
  sfx?: string; music?: string; transition?: string; continuityAnchors?: string[];
  generationRisk?: string; generationMethod?: string; estimatedCost?: number;
  keyframes?: { firstFrame?: string; lastFrame?: string; characterRef?: string[]; sceneRef?: string[]; seed?: number | null; [k: string]: unknown };
  keyframePrompt?: string; motionPrompt?: string; compiledPrompt?: { finalPrompt?: string; sections?: unknown[]; injectionHits?: unknown[] } | null;
  generationTaskId?: string; clipAssetId?: string; qc?: { verdict: string; issues?: { dim: string; sev: string; msg: string }[]; summary?: { errors: number; warns: number; unavailable: number } } | null;
  repairHistory?: unknown[];
  takes?: DirectorTake[]; selectedTakeId?: string; locked?: boolean;
  dirty?: { generation?: boolean; generationReason?: string; generationAt?: number };
}

export interface DirectorTake {
  takeId: string; shotId: string; index: number; status: string;
  generationKey: string; spec?: Record<string, unknown> | null;
  provider: string; model: string; taskId: string; assetId: string;
  fileHash?: string; fileSize?: number | null; width?: number | null; height?: number | null;
  duration?: number | null; codec?: string; sourceTaskId?: string;
  error?: string | null; errorKind?: string | null;
  retries?: number; downloadAttempts?: number;
  createdAt?: number; updatedAt?: number;
}

export interface GenerationConfirmation {
  provider: string; billingMode: string | null; baseUrl: string | null; model: string;
  shotCount: number; resolution: string; ratio: string; duration: number;
  generateAudio: boolean; watermark: boolean; returnLastFrame: boolean;
  cacheHit: boolean; newGenerationCount: number;
  cost: { currency?: string; amount?: number | null; range?: string; note?: string };
  costDisclaimer: string; channelLabel: string;
}

/* 批量生成预览（generate_selected_shots 只读分支） */
export interface BatchPreviewItem {
  shotId: string; generationKey?: string | null;
  cacheHit: boolean; inflight?: boolean; newGen: boolean; duration?: number | null;
  blocked?: boolean; validation?: { ok?: boolean; errors?: unknown[] } | null;
}
export interface GenerationBatchPreview {
  ok: boolean; pending?: boolean; shotIds: string[];
  items: BatchPreviewItem[];
  newGenerationCount: number; cacheHitCount: number;
  batchCap: number | null; costDisclaimer?: string;
}

export interface DirectorAsset {
  assetId: string; kind: string; status: string; path: string; source: string; creator?: string;
  license?: string; commercialUse?: boolean; attribution?: string; consent?: string; model?: string;
  prompt?: string; seed?: number | null; generationTime?: number; inputAssets?: string[];
  modificationHistory?: unknown[]; duration?: number; width?: number; height?: number;
  title?: string; codec?: string; probe?: { fps?: number | null; audioCodec?: string | null; sampleRate?: number | null };
  frameDir?: string; manifest?: { provider?: string; frames?: { file: string; atSec?: number }[]; duration?: number; fps?: number };
}

/** 反向工作流：反推镜头草稿的素材信息（reverse_storyboard 返回） */
export interface ReverseStoryboardData {
  ok: boolean; assetId: string; title?: string;
  duration?: number | null; width?: number | null; height?: number | null; fps?: number | null;
  frames?: { file: string; atSec?: number }[]; hasFrames?: boolean; hint?: string;
}

export interface DirectorTask {
  taskId: string; shotId: string; provider: string; model: string; status: string; progress: number;
  estimatedCost: number; actualCost: number; retries: number; error: string | null; outputAssetId: string;
  queuedAt?: number; submittedAt?: number; startedAt?: number; finishedAt?: number;
  generationKey?: string; errorKind?: string; takeId?: string;
}

export interface DirectorTimeline {
  videoTracks: { id: string; clips: DirectorClip[] }[];
  audioTracks: { id: string; clips: unknown[] }[];
  captions: unknown[];
  markers: unknown[];
  transitions: unknown[];
  global: { width?: number; height?: number; fps?: number };
}
export interface DirectorClip { clipId: string; shotId: string; assetId: string; start: number; end: number; duration: number; label?: string; volume?: number; fadeIn?: number; fadeOut?: number; }

/* ---------------- 目录 / 常量 ---------------- */
export interface DirectorCatalog {
  projectPhases: string[]; shotStates: string[]; taskStates: string[]; assetStates: string[];
  formats: string[]; platforms: string[]; aspectRatios: Record<string, { w: number; h: number }>;
  gates: string[]; gateForPhase: Record<string, string | null>;
  skills: { name: string; phase: string; confirmation: boolean }[];
  tools: unknown[];
  providers: { name: string; displayName?: string; honest?: string }[];
  thirdParty: unknown[];
}

export const DIRECTOR_TOOL_NAMES = [
  "get_director_project", "create_director_project", "set_project_phase", "confirm_gate",
  "import_script", "analyze_script", "update_project_bible", "create_director_treatment",
  "create_rhythm_plan", "create_shot_groups", "create_shot_list", "update_shot",
  "create_storyboard", "create_keyframe", "compile_generation_prompt", "estimate_generation_cost",
  "submit_video_generation", "poll_video_generation", "cancel_generation", "import_generated_clip",
  "run_clip_qc", "compare_clip_versions", "place_clip_on_timeline", "create_voiceover",
  "add_music", "generate_captions", "render_preview", "render_final", "export_project_archive",
  "list_skills", "list_providers", "list_generation_queue", "queue_control",
  "compile_generation_spec", "confirm_generation", "generate_shot", "generate_selected_shots",
  "select_take", "lock_take", "list_takes", "retry_download",
  "ffmpeg_status", "ffmpeg_install_plan", "probe_asset", "make_proxy", "make_thumbnail", "export_final",
  "prepare_reference_upload", "asset_upload_status", "set_project_model",
  "run_continuity_check", "create_shot_list_from_template", "order_summary",
  "update_clip", "reorder_clips", "add_transition", "set_audio_clip",
  "create_render_job", "list_render_jobs", "extract_last_frame", "use_as_first_frame",
  "delete_asset", "create_scene", "update_scene", "create_camera_bible", "create_sound_bible",
  "import_user_video", "sample_frames", "reverse_storyboard",
];

const S = (description: string) => ({ type: "string", description });
const N = (description: string) => ({ type: "number", description });

/* 静态兜底工具 Schema（与服务端 tools.mjs 一致；运行时优先 /catalog） */
export const STATIC_DIRECTOR_TOOLS: unknown[] = [
  { type: "function", function: { name: "get_director_project", description: "读取当前 Director 项目完整状态。", parameters: { type: "object", properties: { projectId: S("项目 ID") }, required: ["projectId"] } } },
  { type: "function", function: { name: "create_director_project", description: "创建/初始化 Director 项目（标题、类型、受众、平台、时长、宽高比、目的、核心信息、观看后行动、预算、截止时间）。", parameters: { type: "object", properties: { projectId: S("项目 ID"), title: S("标题"), format: S("类型"), targetAudience: S("受众"), targetPlatform: S("平台"), targetDuration: N("时长秒"), aspectRatio: S("宽高比"), purpose: S("目的"), coreMessage: S("核心信息"), desiredAction: S("观看后行动"), budgetLimit: N("预算上限"), deadline: S("截止时间") }, required: ["projectId"] } } },
  { type: "function", function: { name: "set_project_phase", description: "推进项目阶段（校验阶段依赖与确认闸门）。", parameters: { type: "object", properties: { projectId: S("项目 ID"), phase: S("目标阶段"), force: { type: "boolean" } }, required: ["projectId", "phase"] } } },
  { type: "function", function: { name: "confirm_gate", description: "记录用户对确认闸门的确认。", parameters: { type: "object", properties: { projectId: S("项目 ID"), gate: S("闸门名"), auto: { type: "boolean" } }, required: ["projectId", "gate"] } } },
  { type: "function", function: { name: "import_script", description: "导入已有剧本原文。", parameters: { type: "object", properties: { projectId: S("项目 ID"), script: S("剧本原文"), format: S("text|markdown|pdf|url") }, required: ["projectId", "script"] } } },
  { type: "function", function: { name: "analyze_script", description: "写入结构化故事（logline/梗概/人物/结构/场景）。", parameters: { type: "object", properties: { projectId: S("项目 ID"), story: { type: "object" } }, required: ["projectId", "story"] } } },
  { type: "function", function: { name: "update_project_bible", description: "更新项目 Bible（story/characters/locations/visual/continuity）。", parameters: { type: "object", properties: { projectId: S("项目 ID"), bible: { type: "object" }, section: S("story|characters|locations|visual|continuity"), reason: S("原因") }, required: ["projectId", "bible"] } } },
  { type: "function", function: { name: "create_director_treatment", description: "写入导演定调（至少两个有实质差异的方向）。", parameters: { type: "object", properties: { projectId: S("项目 ID"), treatments: { type: "array" }, selected: N("选中索引") }, required: ["projectId", "treatments"] } } },
  { type: "function", function: { name: "create_rhythm_plan", description: "写入节奏计划（逐场强度/时长/镜头密度 + 总时长校验）。", parameters: { type: "object", properties: { projectId: S("项目 ID"), rhythmPlan: { type: "object" } }, required: ["projectId", "rhythmPlan"] } } },
  { type: "function", function: { name: "create_shot_groups", description: "创建镜头组。", parameters: { type: "object", properties: { projectId: S("项目 ID"), groups: { type: "array" } }, required: ["projectId", "groups"] } } },
  { type: "function", function: { name: "create_shot_list", description: "批量创建结构化镜头（Blocking 先于摄影机设计）。", parameters: { type: "object", properties: { projectId: S("项目 ID"), shots: { type: "array", description: "镜头数组" } }, required: ["projectId", "shots"] } } },
  { type: "function", function: { name: "update_shot", description: "更新单个镜头（状态迁移受状态机约束）。", parameters: { type: "object", properties: { projectId: S("项目 ID"), shotId: S("镜头 ID"), patch: { type: "object" }, status: S("目标状态"), reason: S("原因") }, required: ["projectId", "shotId", "patch"] } } },
  { type: "function", function: { name: "create_storyboard", description: "写入分镜板。", parameters: { type: "object", properties: { projectId: S("项目 ID"), storyboard: { type: "array" } }, required: ["projectId", "storyboard"] } } },
  { type: "function", function: { name: "create_keyframe", description: "写入关键帧与关键帧 Prompt（与运动 Prompt 分开）。", parameters: { type: "object", properties: { projectId: S("项目 ID"), shotId: S("镜头 ID"), keyframes: { type: "object" }, keyframePrompt: S("关键帧 Prompt") }, required: ["projectId", "shotId"] } } },
  { type: "function", function: { name: "compile_generation_prompt", description: "按可信优先级组装生成 Prompt（含注入防御）。", parameters: { type: "object", properties: { projectId: S("项目 ID"), shotId: S("镜头 ID"), provider: S("Provider"), stageSkill: S("阶段 Skill") }, required: ["projectId", "shotId"] } } },
  { type: "function", function: { name: "estimate_generation_cost", description: "预估镜头生成成本。", parameters: { type: "object", properties: { projectId: S("项目 ID"), shotId: S("镜头 ID"), provider: S("Provider") }, required: ["projectId", "shotId"] } } },
  { type: "function", function: { name: "submit_video_generation", description: "提交视频生成（进入队列，受并发/预算控制）。", parameters: { type: "object", properties: { projectId: S("项目 ID"), shotId: S("镜头 ID"), provider: S("Provider"), model: S("模型") }, required: ["projectId", "shotId"] } } },
  { type: "function", function: { name: "poll_video_generation", description: "轮询生成任务状态。", parameters: { type: "object", properties: { projectId: S("项目 ID"), taskId: S("任务 ID") }, required: ["projectId", "taskId"] } } },
  { type: "function", function: { name: "cancel_generation", description: "取消生成任务。", parameters: { type: "object", properties: { projectId: S("项目 ID"), taskId: S("任务 ID") }, required: ["projectId", "taskId"] } } },
  { type: "function", function: { name: "import_generated_clip", description: "导入生成结果为资产并记录来源/许可。", parameters: { type: "object", properties: { projectId: S("项目 ID"), asset: { type: "object" } }, required: ["projectId", "asset"] } } },
  { type: "function", function: { name: "run_clip_qc", description: "五维 QC（技术/人物/空间/运动/叙事）。", parameters: { type: "object", properties: { projectId: S("项目 ID"), shotId: S("镜头 ID"), assetId: S("资产 ID") }, required: ["projectId", "shotId", "assetId"] } } },
  { type: "function", function: { name: "compare_clip_versions", description: "比较两个片段版本。", parameters: { type: "object", properties: { projectId: S("项目 ID"), assetIdA: S("资产 A"), assetIdB: S("资产 B") }, required: ["projectId", "assetIdA", "assetIdB"] } } },
  { type: "function", function: { name: "place_clip_on_timeline", description: "把通过 QC 的片段放到时间线。", parameters: { type: "object", properties: { projectId: S("项目 ID"), shotId: S("镜头 ID"), assetId: S("资产 ID"), start: N("起始秒"), trackId: S("轨道") }, required: ["projectId", "shotId", "assetId"] } } },
  { type: "function", function: { name: "create_voiceover", description: "创建旁白/对白语音资产（含授权）。", parameters: { type: "object", properties: { projectId: S("项目 ID"), voiceover: { type: "object" } }, required: ["projectId", "voiceover"] } } },
  { type: "function", function: { name: "add_music", description: "添加音乐/音效到音频轨。", parameters: { type: "object", properties: { projectId: S("项目 ID"), assetId: S("音频资产"), kind: S("music|sfx|ambience"), start: N("起始秒"), volume: N("音量"), trackId: S("轨道") }, required: ["projectId", "assetId"] } } },
  { type: "function", function: { name: "generate_captions", description: "生成字幕并做时间轴对齐。", parameters: { type: "object", properties: { projectId: S("项目 ID"), captions: { type: "array" } }, required: ["projectId", "captions"] } } },
  { type: "function", function: { name: "render_preview", description: "渲染预览（时间线→FFmpeg）。", parameters: { type: "object", properties: { projectId: S("项目 ID") }, required: ["projectId"] } } },
  { type: "function", function: { name: "render_final", description: "渲染最终 MP4。", parameters: { type: "object", properties: { projectId: S("项目 ID") }, required: ["projectId"] } } },
  { type: "function", function: { name: "export_project_archive", description: "导出项目归档（分镜表/Bible/素材清单/版权清单）。", parameters: { type: "object", properties: { projectId: S("项目 ID") }, required: ["projectId"] } } },
  { type: "function", function: { name: "list_skills", description: "列出 Director Skills 与当前阶段路由。", parameters: { type: "object", properties: { projectId: S("项目 ID 可选") } } } },
  { type: "function", function: { name: "list_providers", description: "列出可用生成 Provider 与能力。", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "list_generation_queue", description: "列出生成队列。", parameters: { type: "object", properties: { projectId: S("项目 ID") }, required: ["projectId"] } } },
  { type: "function", function: { name: "queue_control", description: "生成队列控制（暂停/继续/并发/预算/优先级）。", parameters: { type: "object", properties: { projectId: S("项目 ID"), action: S("pause|resume|set_concurrency|set_budget|reprioritize"), value: N("数值"), taskId: S("任务 ID") }, required: ["projectId", "action"] } } },
];

/* ---------------- 目录缓存 ---------------- */
let catalogCache: DirectorCatalog | null = null;

export async function loadDirectorCatalog(url: string): Promise<DirectorCatalog | null> {
  try {
    const r = await fetch(url + "/catalog", { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return catalogCache;
    catalogCache = await r.json();
    return catalogCache;
  } catch {
    return catalogCache;
  }
}

export function directorTools(): unknown[] {
  return (catalogCache?.tools as unknown[]) ?? STATIC_DIRECTOR_TOOLS;
}

/* ---------------- 客户端 ---------------- */
export async function fetchDirectorProject(url: string, projectId: string): Promise<DirectorProject | null> {
  try {
    const r = await fetch(url + "/project/" + encodeURIComponent(projectId), { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const d = await r.json();
    return d?.ok ? (d.project as DirectorProject) : null;
  } catch { return null; }
}

export async function listDirectorProjects(url: string): Promise<{ projectId: string; title: string; phase: string; updatedAt: number; version: number }[]> {
  try {
    const r = await fetch(url + "/projects", { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return [];
    const d = await r.json();
    return (d?.projects ?? []) as never;
  } catch { return []; }
}

export async function directorAction(url: string, tool: string, args: Record<string, unknown>) {
  try {
    const r = await fetch(url + "/" + tool, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(args), signal: AbortSignal.timeout(30000) });
    return await r.json();
  } catch (e) {
    return { ok: false, error: "Director 服务不可达：" + String(e) };
  }
}

/* 阶段/状态中文标签（UI） */
export const PHASE_LABELS: Record<string, string> = {
  intake: "需求与制片约束", story: "故事与剧本", direction: "导演定调", rhythm: "节奏规划",
  script_lock: "剧本锁定", shot_design: "镜头设计", storyboard: "分镜", keyframes: "关键帧",
  generation: "视频生成", edit: "剪辑", sound: "声音", review: "审片", export: "导出", completed: "已完成",
};
export const SHOT_STATUS_LABELS: Record<string, string> = {
  planned: "已计划", approved: "已批准", prompt_ready: "Prompt 就绪", generating: "生成中",
  generated: "已生成", qc_failed: "QC 未过", repair_planned: "待修复", approved_clip: "片段已通过",
  placed_on_timeline: "已上时间线", locked: "已锁定",
};
export const TASK_STATUS_LABELS: Record<string, string> = {
  draft: "草稿", awaiting_approval: "待确认", queued: "排队中", submitted: "已提交", running: "运行中",
  generating: "生成中", succeeded: "已生成待下载", failed: "失败", cancelled: "已取消", expired: "已过期",
  downloading: "下载中", ready_for_review: "待审片", selected: "已选中", locked: "已锁定",
};
export const TAKE_STATUS_LABELS: Record<string, string> = {
  draft: "草稿", awaiting_approval: "待确认", queued: "排队中", generating: "生成中",
  succeeded: "已生成待下载", failed: "失败", cancelled: "已取消",
  downloading: "下载中", ready_for_review: "待审片", selected: "已选中", locked: "已锁定",
};
export function assetUrl(url: string, projectId: string, rel: string) {
  return url + "/asset/" + encodeURIComponent(projectId) + "/" + rel.split("/").map(encodeURIComponent).join("/");
}
