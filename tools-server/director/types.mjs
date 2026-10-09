/* ============================================================================
 * Harness Director — 数据模型（单一事实来源，零依赖 Node ESM）
 *
 * 定义 DirectorProject 及其 Bible、镜头、生成任务、资产、时间线的完整结构与
 * 状态机。所有数据与 projectId 绑定，具备版本历史与稳定 ID。
 * 本模块只定义结构、常量、状态机与工厂函数，不做任何 I/O。
 * ==========================================================================*/

/* ---------------------------------------------------------------------------
 * 稳定 ID
 * -------------------------------------------------------------------------*/
const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
function rand(len) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}
function ts36() {
  return Date.now().toString(36);
}

/** 生成项目级稳定 ID。prefix 用于人读分类，seq 来自项目内单调计数器。 */
export function makeId(prefix, seq) {
  const n = Number(seq) || 0;
  return prefix + "-" + n.toString().padStart(3, "0");
}
export function newProjectId() {
  return "D-" + ts36() + "-" + rand(4);
}
export function newStableId(category, seq) {
  return "B-" + category.toUpperCase() + "-" + String(seq).padStart(3, "0");
}
export function newAssetId(projectId, seq) {
  return "AST-" + String(projectId).slice(0, 8) + "-" + String(seq).padStart(4, "0");
}
export function newTaskId(projectId, seq) {
  return "GEN-" + String(projectId).slice(0, 8) + "-" + String(seq).padStart(4, "0");
}

/* ---------------------------------------------------------------------------
 * 项目类型与平台枚举
 * -------------------------------------------------------------------------*/
export const PROJECT_FORMATS = [
  "narrative_short", "concept_short", "advertisement", "product_video",
  "music_video", "trailer", "social_vertical", "explainer_tutorial",
  "animated_short", "imported_script", "imported_footage",
];

export const PLATFORMS = ["bilibili", "douyin", "wechat", "xiaohongshu", "youtube", "tiktok", "instagram", "tv", "cinema", "other"];

export const ASPECT_RATIOS = {
  "16:9": { w: 1920, h: 1080 },
  "9:16": { w: 1080, h: 1920 },
  "1:1": { w: 1080, h: 1080 },
  "4:3": { w: 1440, h: 1080 },
  "21:9": { w: 2560, h: 1080 },
};

/* ---------------------------------------------------------------------------
 * 制作状态机（项目阶段）
 * -------------------------------------------------------------------------*/
export const PROJECT_PHASES = [
  "intake", "story", "direction", "rhythm", "script_lock",
  "shot_design", "storyboard", "keyframes", "generation",
  "edit", "sound", "review", "export", "completed",
];

export const PHASE_ORDER = new Map(PROJECT_PHASES.map((p, i) => [p, i]));

/** 阶段依赖：进入某阶段前必须已完成的阶段（用于 gate 校验）。 */
export const PHASE_REQUIRES = {
  intake: [],
  story: ["intake"],
  direction: ["story"],
  rhythm: ["direction"],
  script_lock: ["rhythm"],
  shot_design: ["script_lock"],
  storyboard: ["shot_design"],
  keyframes: ["storyboard"],
  generation: ["keyframes"],
  edit: ["generation"],
  sound: ["edit"],
  review: ["sound"],
  export: ["review"],
  completed: ["export"],
};

export function canEnterPhase(phase, completedPhases) {
  const req = PHASE_REQUIRES[phase] || [];
  return req.every((p) => completedPhases.includes(p));
}

/* ---------------------------------------------------------------------------
 * 镜头状态机
 * -------------------------------------------------------------------------*/
export const SHOT_STATES = [
  "planned", "approved", "prompt_ready", "generating", "generated",
  "qc_failed", "repair_planned", "approved_clip", "placed_on_timeline", "locked",
];

export const SHOT_TRANSITIONS = {
  planned: ["approved", "prompt_ready"],
  approved: ["prompt_ready", "planned"],
  prompt_ready: ["generating", "planned"],
  generating: ["generated", "qc_failed", "planned"],
  generated: ["approved_clip", "qc_failed", "planned"],
  qc_failed: ["repair_planned", "planned", "approved_clip"],
  repair_planned: ["prompt_ready", "generating", "planned"],
  approved_clip: ["placed_on_timeline", "qc_failed", "planned"],
  placed_on_timeline: ["locked", "approved_clip"],
  locked: [],
};

export function canTransitionShot(from, to) {
  const allowed = SHOT_TRANSITIONS[from] || [];
  return allowed.includes(to);
}

/* ---------------------------------------------------------------------------
 * 生成任务状态机
 * -------------------------------------------------------------------------*/
export const TASK_STATES = ["draft", "queued", "submitted", "running", "succeeded", "failed", "cancelled", "expired"];
export const TASK_TERMINAL = new Set(["succeeded", "failed", "cancelled", "expired"]);

/* ---------------------------------------------------------------------------
 * 资产状态机
 * -------------------------------------------------------------------------*/
export const ASSET_STATES = ["imported", "generated", "rejected", "approved", "locked", "superseded"];

/* ---------------------------------------------------------------------------
 * 工厂：全新项目
 * -------------------------------------------------------------------------*/
export function newProject(partial = {}) {
  const projectId = partial.projectId || newProjectId();
  const now = Date.now();
  return {
    projectId,
    title: partial.title || "未命名视频项目",
    format: partial.format || "narrative_short",
    targetAudience: partial.targetAudience || "",
    targetPlatform: partial.targetPlatform || "",
    targetDuration: partial.targetDuration ?? 30, // 秒
    aspectRatio: partial.aspectRatio || "16:9",
    fps: partial.fps ?? 24,
    resolution: partial.resolution || "1920x1080",
    language: partial.language || "zh-CN",
    purpose: partial.purpose || "",
    coreMessage: partial.coreMessage || "",
    desiredAction: partial.desiredAction || "",
    productionMode: partial.productionMode || "ai_generated",
    budgetLimit: partial.budgetLimit ?? 0,
    deadline: partial.deadline || "",

    phase: "intake",
    completedPhases: [],

    story: {
      logline: "", theme: "", premise: "", synopsis: "",
      characters: [], characterArcs: [], scenes: [], dialogue: [],
      emotionalArc: "", narrativeStructure: "",
    },
    direction: {
      directorStatement: "", visualPosition: "", genre: "", mood: "",
      narrativePerspective: "", cameraLanguage: "", compositionRules: [],
      lensRules: [], movementRules: [], lightingRules: [], colorRules: [],
      editingRules: [], soundRules: [], motifSystem: [], forbiddenChoices: [],
    },
    production: {
      providers: [], modelVersions: [], clipDurationPolicy: { min: 2, max: 10 },
      retryPolicy: { maxAttempts: 3, escalation: "simplify" },
      estimatedCost: 0, actualCost: 0, renderSettings: {}, exportTargets: [],
    },
    bible: {
      storyBible: { worldRules: [], timeline: [], locations: [], facts: [], stableId: newStableId("story", 1) },
      characters: [],   // CharacterBible[]
      locations: [],    // LocationBible[]
      camera: [],       // CameraBible[]（stableId 引用，不依赖数组下标）
      sound: [],        // SoundBible[]（stableId 引用）
      visual: { aspectRatio: partial.aspectRatio || "16:9", texture: "", cameraLanguage: [], color: [], light: [], grain: "", sharpness: "", depthOfField: "", motifs: [], forbidden: [], stableId: newStableId("visual", 1) },
      continuity: [],   // ContinuityBible[]（逐镜头）
    },
    creativeBrief: null,
    directorTreatments: [],   // 多个方向，每个含差异与实现成本
    rhythmPlan: null,
    shotGroups: [],
    scenes: [],            // Scene 实体（正式化，见 newScene）
    shots: [],
    assets: [],            // AssetRecord[]
    generationTasks: [],   // GenerationTask[]
    renderJobs: [],        // RenderJob[]（持久化渲染历史）
    trash: [],             // 已删除资产（可恢复）
    timeline: newTimeline(),
    counters: { shot: 0, scene: 0, group: 0, char: 0, loc: 0, asset: 0, task: 0, bible: 1, renderJob: 0 },
    confirmations: {},     // gate 确认记录 {gate: {at, by, auto}}
    issues: [],            // 未解决问题
    thirdParty: [],        // 外部 Skill/来源记录
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
}

export function newTimeline() {
  return {
    videoTracks: [{ id: "V1", clips: [] }],
    audioTracks: [{ id: "A1", clips: [] }, { id: "A2", clips: [] }],
    captions: [],
    markers: [],
    transitions: [],
    global: { width: 1920, height: 1080, fps: 24, audioEnabled: true },
  };
}

export function newCharacterBible(seq, partial = {}) {
  return {
    characterId: partial.characterId || makeId("CHAR", seq),
    stableId: newStableId("char", seq),
    name: partial.name || "",
    age: partial.age ?? null, bodyType: partial.bodyType || "",
    face: partial.face || "", hair: partial.hair || "", outfit: partial.outfit || "",
    accessories: partial.accessories || "", posture: partial.posture || "",
    gestures: partial.gestures || "", performanceBoundary: partial.performanceBoundary || "",
    voice: partial.voice || "", referenceImages: partial.referenceImages || [],
    immutableTraits: partial.immutableTraits || [],
  };
}

export function newLocationBible(seq, partial = {}) {
  return {
    locationId: partial.locationId || makeId("LOC", seq),
    stableId: newStableId("loc", seq),
    name: partial.name || "",
    layout: partial.layout || "", timeOfDay: partial.timeOfDay || "",
    weather: partial.weather || "", lightSources: partial.lightSources || [],
    color: partial.color || "", fixedProps: partial.fixedProps || [],
    entrancesExits: partial.entrancesExits || "", cameraDirections: partial.cameraDirections || [],
    referenceImages: partial.referenceImages || [],
  };
}

export function newContinuityEntry(shotId, partial = {}) {
  return {
    stableId: newStableId("cont", partial.seq || 1),
    shotId: shotId || "",
    characterPositions: partial.characterPositions || {},
    facingDirections: partial.facingDirections || {},
    outfits: partial.outfits || {},
    propHands: partial.propHands || {},
    lightDirection: partial.lightDirection || "",
    timeOfDay: partial.timeOfDay || "", weather: partial.weather || "",
    actionStart: partial.actionStart || "", actionEnd: partial.actionEnd || "",
    prevShotEndState: partial.prevShotEndState || "",
    nextShotStartState: partial.nextShotStartState || "",
  };
}

/* ---------------------------------------------------------------------------
 * Scene 实体（正式化：不再只存在于 story.scenes[]）
 * -------------------------------------------------------------------------*/
export function newScene(seq, partial = {}) {
  const now = Date.now();
  return {
    sceneId: partial.sceneId || makeId("SCENE", seq),
    title: partial.title || "",
    narrativePurpose: partial.narrativePurpose || "",
    timeOfDay: partial.timeOfDay || "",
    locationRefs: partial.locationRefs || [],   // LocationBible stableId / locationId
    characterRefs: partial.characterRefs || [], // CharacterBible stableId / characterId
    mood: partial.mood || "",
    color: partial.color || "",
    soundDesign: partial.soundDesign || "",
    continuityNotes: partial.continuityNotes || "",
    shotIds: partial.shotIds || [],             // 镜头顺序
    createdAt: now,
    updatedAt: now,
  };
}

/* ---------------------------------------------------------------------------
 * Camera Bible（stableId 引用，避免数组下标）
 * -------------------------------------------------------------------------*/
export function newCameraBibleEntry(seq, partial = {}) {
  return {
    stableId: newStableId("cam", seq),
    name: partial.name || "",
    lens: partial.lens || "",
    framing: partial.framing || "",
    movement: partial.movement || "",
    height: partial.height || "",
    composition: partial.composition || "",
    shutterMotion: partial.shutterMotion || "",
    visualRestrictions: partial.visualRestrictions || [],
  };
}

/* ---------------------------------------------------------------------------
 * Sound Bible（stableId 引用）
 * -------------------------------------------------------------------------*/
export function newSoundBibleEntry(seq, partial = {}) {
  return {
    stableId: newStableId("snd", seq),
    name: partial.name || "",
    ambience: partial.ambience || "",
    dialogueStyle: partial.dialogueStyle || "",
    musicDirection: partial.musicDirection || "",
    soundEffects: partial.soundEffects || [],
    loudnessPolicy: partial.loudnessPolicy || "",
    silencePolicy: partial.silencePolicy || "",
  };
}

/* ---------------------------------------------------------------------------
 * RenderJob（渲染历史持久化）
 * -------------------------------------------------------------------------*/
export function newRenderJob(seq, partial = {}) {
  const now = Date.now();
  return {
    renderJobId: partial.renderJobId || "REND-" + String(seq).padStart(4, "0"),
    projectId: partial.projectId || "",
    timelineRevision: partial.timelineRevision ?? 0,
    outputProfile: partial.outputProfile || "h264-aac-yuv420p-faststart-48k",
    ffmpegArgsSummary: partial.ffmpegArgsSummary || "",
    inputAssets: partial.inputAssets || [],
    status: partial.status || "queued",   // queued | rendering | succeeded | failed | cancelled
    progress: partial.progress ?? 0,
    outputPath: partial.outputPath || "",
    error: partial.error || null,
    createdAt: now,
    startedAt: partial.startedAt || 0,
    finishedAt: partial.finishedAt || 0,
  };
}

/* ---------------------------------------------------------------------------
 * 镜头（Shot）—— Blocking 先于摄影机设计
 * -------------------------------------------------------------------------*/
export function newShot(seq, partial = {}) {
  return {
    shotId: partial.shotId || makeId("SHOT", seq),
    sceneId: partial.sceneId || "",
    shotGroupId: partial.shotGroupId || "",
    index: partial.index ?? seq,
    status: "planned",
    narrativePurpose: partial.narrativePurpose || "",   // 必答：镜头结束后观众多知道/感受/预期什么
    duration: partial.duration ?? 5,
    shotSize: partial.shotSize || "",        // 景别
    angle: partial.angle || "",              // 角度
    lens: partial.lens || "",                // 焦段/镜头观感
    cameraPosition: partial.cameraPosition || "",
    cameraMovement: partial.cameraMovement || "",
    subject: partial.subject || "",
    startState: partial.startState || "",    // 起始状态（Blocking）
    primaryAction: partial.primaryAction || "",  // 主动作
    endState: partial.endState || "",        // 结束状态（必须明确）
    performance: partial.performance || "",
    composition: partial.composition || "",
    lighting: partial.lighting || "",
    color: partial.color || "",
    environment: partial.environment || "",
    props: partial.props || [],
    dialogue: partial.dialogue || "",
    sfx: partial.sfx || "",
    music: partial.music || "",
    transition: partial.transition || "",
    continuityAnchors: partial.continuityAnchors || [],  // 连续性锚点（引用 bible stableId）
    generationRisk: partial.generationRisk || "",   // 生成风险
    generationMethod: partial.generationMethod || "", // 预计生成方式
    estimatedCost: partial.estimatedCost ?? 0,
    // 关键帧与 Prompt（分开保存）
    keyframes: partial.keyframes || { firstFrame: null, lastFrame: null, characterRef: [], sceneRef: [], propRef: [], styleRef: [], mask: null, compositionSketch: null },
    keyframePrompt: partial.keyframePrompt || "",
    motionPrompt: partial.motionPrompt || "",
    compiledPrompt: partial.compiledPrompt || null,
    // 生成结果
    generationTaskId: partial.generationTaskId || "",
    clipAssetId: partial.clipAssetId || "",
    qc: partial.qc || null,
    repairHistory: partial.repairHistory || [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/* ---------------------------------------------------------------------------
 * 生成任务
 * -------------------------------------------------------------------------*/
export function newGenerationTask(seq, partial = {}) {
  return {
    taskId: partial.taskId || "",
    shotId: partial.shotId || "",
    provider: partial.provider || "",
    model: partial.model || "",
    modelVersion: partial.modelVersion || "",
    promptVersion: partial.promptVersion || 1,
    referenceAssets: partial.referenceAssets || [],
    status: "draft",
    progress: partial.progress ?? 0,
    queuedAt: 0, submittedAt: 0, startedAt: 0, finishedAt: 0,
    estimatedCost: partial.estimatedCost ?? 0,
    actualCost: partial.actualCost ?? 0,
    retries: partial.retries ?? 0,
    error: partial.error || null,
    outputAssetId: partial.outputAssetId || "",
    providerJobId: partial.providerJobId || "",
  };
}

/* ---------------------------------------------------------------------------
 * 资产（版权与来源）
 * -------------------------------------------------------------------------*/
export function newAsset(seq, partial = {}) {
  return {
    assetId: partial.assetId || "",
    kind: partial.kind || "image",   // image | video | audio | script | reference
    status: "imported",
    path: partial.path || "",
    source: partial.source || "",       // imported | generated | external
    creator: partial.creator || "",
    license: partial.license || "",
    commercialUse: partial.commercialUse ?? false,
    attribution: partial.attribution || "",
    consent: partial.consent || "",     // 肖像/声音授权
    model: partial.model || "",
    prompt: partial.prompt || "",
    seed: partial.seed ?? null,
    generationTime: partial.generationTime ?? 0,
    inputAssets: partial.inputAssets || [],
    modificationHistory: partial.modificationHistory || [],
    duration: partial.duration ?? null,
    width: partial.width ?? null,
    height: partial.height ?? null,
    createdAt: Date.now(),
  };
}

/* ---------------------------------------------------------------------------
 * 状态机守卫（导出给工具层校验）
 * -------------------------------------------------------------------------*/
export function assertShotTransition(from, to) {
  if (!canTransitionShot(from, to)) {
    throw new Error("非法镜头状态迁移：" + from + " -> " + to);
  }
}

export function assertPhase(phase) {
  if (!PROJECT_PHASES.includes(phase)) throw new Error("未知项目阶段：" + phase);
}

export const ID = {
  makeId, newProjectId, newStableId, newAssetId, newTaskId,
};
