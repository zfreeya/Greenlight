/* ============================================================================
 * Harness Director — 共享上下文工厂（依赖注入，零依赖 Node ESM）
 *
 * 所有路由模块只依赖 ctx，不直接 import 服务端内部模块。ctx 由
 * server.mjs（createDirectorServer）构建后注入。这里集中：
 *   1) 领域常量（闸门映射）
 *   2) 项目读写助手（乐观锁提交）
 *   3) 生成引擎助手（Spec/缓存/Take/付费闸门）
 *   4) 异步 Provider 三段式（submit → poll → download）
 *   5) 导出归档 / 资产解析
 * ==========================================================================*/
import * as T from "./types.mjs";
import * as GEN from "./generation.mjs";
import * as FF from "./ffmpeg.mjs";
import * as TL from "./timeline.mjs";
import { SKILLS, getSkill, skillsForPhase, orchestratorNext } from "./skills.mjs";
import { compileGenerationPrompt } from "./prompt-compiler.mjs";
import { getProvider, listProviders } from "./providers.mjs";
import { runClipQc, compareClipVersions } from "./qc.mjs";
import { renderTimeline, ffmpegAvailable } from "./render.mjs";
import { TOOLS, toolCatalog } from "./tools.mjs";
import { THIRD_PARTY_SOURCES, thirdPartyNoticesMarkdown } from "./third-party.mjs";
import { SEEDANCE_CHANNELS } from "./seedance/provider.mjs";

/* ---- 闸门与阶段映射（领域常量，单一事实来源） ---- */
export const GATE_FOR_PHASE = {
  intake: "creative_brief", story: "script_lock", direction: "director_treatment",
  rhythm: "rhythm", script_lock: null, shot_design: null,
  storyboard: "storyboard", keyframes: "keyframes", generation: "batch_generation",
  edit: "rough_cut", sound: null, review: null, export: "final_export", completed: null,
};
export const GATES = ["creative_brief", "script_lock", "director_treatment", "rhythm", "storyboard", "keyframes", "batch_generation", "rough_cut", "final_export"];

/**
 * 构建共享上下文。deps = { store, engine, uploader, seedance }。
 * seedance 是 SeedanceWorkerProvider 实例；engine 是 GenerationEngine；
 * uploader 是 AssetUploader。所有返回的助手均为闭包，供路由模块调用。
 */
export function createDirectorContext(deps) {
  const { store, engine, uploader, seedance } = deps;

  /* ---- 运行中队列（暂停/并发在项目内持久化，运行中集合仅内存） ---- */
  const runningJobs = new Map(); // projectId -> Set(taskId)

  /* ---- 全局并发默认 1，可调整到 1–3 ---- */
  const DEFAULT_CONCURRENCY = 1;
  const MAX_CONCURRENCY = 3;

  /** 严格解析 Provider：seedance 走 sidecar；其余走 providers.mjs（未知名称抛错，失败关闭）。 */
  function resolveProvider(name) {
    if (name === "seedance") return seedance;
    return getProvider(name);
  }
  function isAsyncProvider(name) {
    return name === "seedance";
  }

  /** Seedance 能力以 Python Worker 为单一事实来源（Node 端只缓存）。 */
  let seedanceCapsPromise = null;
  function seedanceCaps() {
    if (!seedanceCapsPromise) {
      seedanceCapsPromise = seedance.getCapabilities().then((c) => ({
        name: "seedance",
        displayName: "火山方舟 Seedance（Python sidecar）",
        textToVideo: c.textToVideo !== false, imageToVideo: c.imageToVideo !== false, firstLastFrame: c.firstLastFrame !== false,
        referenceImage: c.referenceImage !== false, referenceVideo: c.referenceVideo !== false, referenceAudio: c.referenceAudio !== false,
        maxDuration: c.maxDuration || 12, aspectRatios: c.aspectRatios || ["16:9", "9:16", "1:1"], resolutions: c.resolutions || ["1080p"],
        supportsAudio: c.supportsAudio !== false, watermark: c.watermark !== false, returnLastFrame: c.returnLastFrame !== false,
        supportsSeed: Boolean(c.supportsSeed), negativePrompt: Boolean(c.negativePrompt),
        channels: c.channels || Object.keys(SEEDANCE_CHANNELS), concurrencyLimit: 1,
        pricing: { unit: "按次计费", perClip: "以服务端实际扣费为准" },
        timeoutMs: 600000, async: true, available: true,
        billingMode: seedance.billingMode, model: seedance.model,
        honest: "真实 AI 生成（火山方舟 Seedance）。付费调用需逐次确认；Agent Plan 失败不会静默切到 Platform。",
      })).catch(() => ({
        name: "seedance", displayName: "火山方舟 Seedance（不可用）",
        textToVideo: true, imageToVideo: true, firstLastFrame: true,
        maxDuration: 12, aspectRatios: ["16:9", "9:16", "1:1"], supportsAudio: true,
        concurrencyLimit: 1, pricing: { unit: "按次计费", perClip: "以服务端实际扣费为准" },
        timeoutMs: 600000, async: true, available: false,
        billingMode: seedance.billingMode, model: seedance.model,
        honest: "Seedance worker 不可达或 SDK 未安装。",
      }));
    }
    return seedanceCapsPromise;
  }

  /* ---- 项目读写助手 ---- */
  function loadProject(projectId) {
    let p = store.loadProject(projectId);
    if (!p || p._recovered === true && !p.title) {
      p = T.newProject({ projectId });
      p.thirdParty = THIRD_PARTY_SOURCES.map((s) => ({ name: s.name, repo: s.repo, license: s.license, author: s.author, introducedAt: s.introducedAt }));
      store.createProject(p);
    }
    if (!p.counters) p.counters = { shot: 0, scene: 0, group: 0, char: 0, loc: 0, asset: 0, task: 0, bible: 1 };
    if (!p.thirdParty) p.thirdParty = [];
    if (!Array.isArray(p.scenes) || (p.scenes.length === 0 && Array.isArray(p.story?.scenes) && p.story.scenes.length > 0)) {
      const legacyScenes = Array.isArray(p.story?.scenes) ? p.story.scenes : [];
      if (legacyScenes.length) p.scenes = legacyScenes.map((s, i) => T.newScene(i + 1, { title: s.name || "", narrativePurpose: s.summary || "" }));
    }
    if (!p.bible) p.bible = {};
    if (!Array.isArray(p.bible.camera)) p.bible.camera = [];
    if (!Array.isArray(p.bible.sound)) p.bible.sound = [];
    if (!Array.isArray(p.renderJobs)) p.renderJobs = [];
    if (!Array.isArray(p.trash)) p.trash = [];
    if (!p.counters.renderJob) p.counters.renderJob = 0;
    return p;
  }

  function saveProject(p) { return store.saveProject(p, { op: "update", by: "agent" }); }

  /** 统一项目提交：乐观锁冲突自动重试（异步操作后写项目必须走这里）。 */
  function commitProject(projectId, mutateFn, maxRetries = 5) {
    for (let i = 0; i < maxRetries; i++) {
      const fresh = loadProject(projectId);
      const result = mutateFn(fresh);
      try {
        saveProject(fresh);
        return result;
      } catch (e) {
        if (e.code !== "concurrency") throw e;
        if (i === maxRetries - 1) throw new Error("项目写入并发冲突（重试 " + maxRetries + " 次仍失败）：" + projectId);
      }
    }
  }

  function nextSeq(p, key) {
    if (!p.counters[key]) p.counters[key] = 0;
    return ++p.counters[key];
  }

  function findShot(p, shotId) {
    const s = (p.shots || []).find((x) => x.shotId === shotId);
    if (!s) throw new Error("镜头不存在：" + shotId);
    return s;
  }

  function findAsset(p, assetId) {
    const a = (p.assets || []).find((x) => x.assetId === assetId);
    if (!a) throw new Error("资产不存在：" + assetId);
    return a;
  }

  /** 解析镜头当前可用的 Take 资产（selected/locked/ready_for_review 优先；退 clipAssetId）。 */
  function takeAssetFor(p, shot) {
    const take = (shot.takes || []).find((t) => t.status === "locked" || t.status === "selected")
      || (shot.takes || []).find((t) => t.status === "ready_for_review");
    const assetId = take?.assetId || shot.clipAssetId;
    if (!assetId) return null;
    const asset = (p.assets || []).find((a) => a.assetId === assetId);
    if (!asset || !asset.path) return null;
    return {
      takeId: take?.takeId || null,
      assetId: asset.assetId,
      abs: pathJoinAssets(p.projectId, asset.path),
      duration: asset.duration ?? take?.duration ?? null,
    };
  }

  function pathJoinAssets(projectId, rel) {
    // 保持与 store.assetsDir 一致（server.mjs 注入 assetsDir 解析器）
    return deps.resolveAssetAbs(projectId, rel);
  }

  /* ---- 生成队列（legacy 镜像路径） ---- */
  function concurrency(p) {
    const v = Number(p.production?.concurrencyLimit ?? DEFAULT_CONCURRENCY);
    return Math.min(Math.max(1, v || 1), MAX_CONCURRENCY);
  }
  function isRunningTask(t) { return t.status === "submitted" || t.status === "running"; }

  function finalizeTask(p, task, shot, result) {
    if (result.ok !== false) {
      const manifest = result.manifest || {};
      const assetId = T.newAssetId(p.projectId, nextSeq(p, "asset"));
      const relDir = manifest.assetDir ? pathRelativeAssets(p.projectId, manifest.assetDir) : manifest.jobId || "";
      const asset = {
        ...T.newAsset(nextSeq(p, "asset"), {
          assetId, kind: "video", status: "generated", source: "generated",
          model: task.model || "local-stub", prompt: manifest.prompt || "", seed: manifest.seed ?? null,
          generationTime: Date.now(), inputAssets: task.referenceAssets || [],
          duration: manifest.duration ?? null, width: manifest.width ?? null, height: manifest.height ?? null,
        }),
        path: (relDir ? relDir + "/" : "") + (manifest.videoFile || "manifest.json"),
        frameDir: relDir,
        manifest,
      };
      p.assets.push(asset);
      task.status = "succeeded";
      task.progress = 1;
      task.finishedAt = Date.now();
      task.outputAssetId = assetId;
      task.actualCost = task.estimatedCost ?? 0;
      p.production.actualCost = (p.production.actualCost || 0) + (task.actualCost || 0);
      shot.clipAssetId = assetId;
      shot.generationTaskId = task.taskId;
      shot.status = "generated";
      shot.qc = null;
      return { ok: true, taskId: task.taskId, assetId, shotId: shot.shotId, status: "succeeded" };
    }
    task.status = "failed";
    task.error = result.error || "生成失败";
    task.finishedAt = Date.now();
    shot.status = "qc_failed";
    shot.repairHistory = shot.repairHistory || [];
    shot.repairHistory.push({ ts: Date.now(), reason: task.error, target: "regenerate" });
    return { ok: false, taskId: task.taskId, error: task.error };
  }

  function startTask(p, task) {
    const provider = resolveProvider(task.provider);
    const shot = findShot(p, task.shotId);
    task.status = "submitted";
    task.submittedAt = Date.now();
    task.status = "running";
    task.startedAt = Date.now();
    const req = {
      shotId: shot.shotId, shot, prompt: shot.compiledPrompt?.finalPrompt || shot.motionPrompt || "",
      duration: shot.duration, fps: p.fps, seed: shot.keyframes?.seed ?? null,
      palette: (p.bible?.visual?.color || []).slice(0, 3),
    };
    let result;
    try {
      result = provider.submitGeneration(req, deps.assetsDir(p.projectId));
    } catch (e) {
      result = { ok: false, error: String(e?.message ?? e) };
    }
    return finalizeTask(p, task, shot, result);
  }

  function processQueue(p) {
    if (p.queuePaused) return { started: 0, note: "队列已暂停" };
    const limit = concurrency(p);
    let started = 0;
    const queued = (p.generationTasks || []).filter((t) => t.status === "queued" || t.status === "draft");
    for (const task of queued) {
      if (p.queuePaused) break;
      if ((p.generationTasks || []).filter(isRunningTask).length >= limit) break;
      startTask(p, task);
      started++;
    }
    return { started };
  }

  function pathRelativeAssets(projectId, absDir) {
    return deps.relativeAssetsAbs(projectId, absDir);
  }

  /* ---- Generation Spec / 缓存 / Take / 付费闸门 ---- */
  function referenceHashes(project, shot) {
    const refs = [];
    const kf = shot.keyframes || {};
    const ids = [...(kf.characterRef || []), ...(kf.sceneRef || [])];
    for (const id of ids) {
      const a = (project.assets || []).find((x) => x.assetId === id);
      if (a && a.fileHash) refs.push({ assetId: id, role: "reference", sha256: a.fileHash });
    }
    return refs;
  }

  function normalizeResolution(res, provider) {
    if (provider !== "seedance") return res;
    const map = {
      "1920x1080": "1080p", "1280x720": "720p", "854x480": "480p",
      "1080x1920": "1080p", "720x1280": "720p", "480x854": "480p",
    };
    return map[String(res).toLowerCase()] || String(res);
  }

  function frameReferenceHashes(project, shot) {
    const kf = shot.keyframes || {};
    const out = [];
    for (const [role, key] of [["first_frame", "firstFrame"], ["last_frame", "lastFrame"]]) {
      const id = kf[key];
      if (!id) continue;
      const a = (project.assets || []).find((x) => x.assetId === id);
      if (!a) continue;
      out.push({ assetId: id, role, sha256: a.fileHash || ("assetref:" + a.assetId + ":" + (a.path || "")) });
    }
    return out;
  }

  async function buildGenerationSpec(project, shot, opts = {}) {
    const provider = opts.provider || "local-stub";
    const caps = provider === "seedance" ? await seedanceCaps() : (resolveProvider(provider).getCapabilities());
    const compiled = compileGenerationPrompt(project, shot, caps);
    const ratio = opts.ratio || project.aspectRatio || "16:9";
    const resolution = normalizeResolution(opts.resolution || project.resolution || "1080p", provider);
    const billingMode = provider === "seedance" ? (opts.billing_mode || seedance.billingMode || "platform") : "";
    const baseUrl = provider === "seedance" ? (opts.base_url || SEEDANCE_CHANNELS[billingMode] || "") : "";
    return GEN.standardizeGenerationSpec({
      provider,
      billing_mode: billingMode,
      base_url: baseUrl,
      model: opts.model || (provider === "seedance" ? (seedance.model || String((project.production?.modelVersions || [])[0] || "")) : ((caps.modelVersions || [])[0] || "stub-1")),
      prompt: compiled.finalPrompt || compiled.motionPrompt || "",
      negative_prompt: opts.negative_prompt || "",
      referenceAssets: [...referenceHashes(project, shot), ...frameReferenceHashes(project, shot)],
      resolution,
      ratio,
      duration: opts.duration ?? shot.duration,
      generate_audio: Boolean(opts.generate_audio),
      watermark: Boolean(opts.watermark),
      return_last_frame: Boolean(opts.return_last_frame),
      seed: shot.keyframes?.seed ?? null,
      references: opts.references || {},
      extra: opts.extra || {},
    });
  }

  async function validateSpecForProvider(providerName, spec) {
    if (providerName === "seedance") {
      return seedance.validateGenerationRequest(spec);
    }
    const provider = resolveProvider(providerName);
    const r = provider.validateRequest({
      shotId: spec.extra?.shotId,
      model: spec.model, duration: spec.duration, resolution: spec.resolution, ratio: spec.ratio,
      generate_audio: spec.generate_audio, watermark: spec.watermark, return_last_frame: spec.return_last_frame,
      references: spec.references || {},
    });
    return { ok: r.ok !== false, errors: r.errors || [], warnings: r.warnings || [], capabilities: null };
  }

  function cacheToAsset(project, cached) {
    const existing = (project.assets || []).find((a) => a.path === cached.asset_path || a.fileHash === cached.file_hash);
    if (existing) return existing;
    const assetId = T.newAssetId(project.projectId, nextSeq(project, "asset"));
    let localPath = cached.asset_path;
    const projAssets = deps.assetsDir(project.projectId);
    if (!pathIsInside(localPath, projAssets)) {
      const ext = pathExtname(cached.asset_path) || ".mp4";
      const target = pathJoin(projAssets, "seedance", assetId + ext);
      fsMkdir(dirname(target));
      fsCopyFile(cached.asset_path, target);
      localPath = target;
      engine.recordCache(cached.generation_key, {
        assetPath: target, fileHash: cached.file_hash, fileSize: cached.file_size,
        width: cached.width, height: cached.height, duration: cached.duration, codec: cached.codec,
        sourceTaskId: cached.source_task_id, provider: cached.provider, model: cached.model,
      });
    }
    const asset = {
      ...T.newAsset(nextSeq(project, "asset"), {
        assetId, kind: "video", status: "generated", source: "generated",
        model: cached.model || "", prompt: "", generationTime: cached.created_at,
        duration: cached.duration ?? null, width: cached.width ?? null, height: cached.height ?? null,
      }),
      path: deps.relativeAssetsAbs(project.projectId, localPath),
      fileHash: cached.file_hash, fileSize: cached.file_size, codec: cached.codec,
      fromCache: true,
    };
    project.assets.push(asset);
    return asset;
  }

  /** 把成功结果落为资产 + Take + 缓存。 */
  function finalizeTake(project, shot, take, task, result) {
    let asset = result.asset;
    if (!asset) {
      const assetId = T.newAssetId(project.projectId, nextSeq(project, "asset"));
      const rel = result.path ? deps.relativeAssetsAbs(project.projectId, result.path) : "";
      asset = {
        ...T.newAsset(nextSeq(project, "asset"), {
          assetId, kind: "video", status: "generated", source: "generated",
          model: take.model || task?.model || "", prompt: take.spec?.prompt || "",
          generationTime: Date.now(), duration: result.duration ?? null,
          width: result.width ?? null, height: result.height ?? null,
        }),
        path: rel || "",
        fileHash: result.fileHash || result.sha256 || "",
        fileSize: result.fileSize ?? result.bytes ?? null,
        codec: result.codec || "",
      };
      project.assets.push(asset);
    }
    take.assetId = asset.assetId;
    take.fileHash = asset.fileHash || "";
    take.fileSize = asset.fileSize ?? null;
    take.width = asset.width ?? null;
    take.height = asset.height ?? null;
    take.duration = asset.duration ?? null;
    take.codec = asset.codec || "";
    take.sourceTaskId = task?.task_id || task?.taskId || "";
    take.status = "ready_for_review";
    take.updatedAt = Date.now();

    shot.takes = shot.takes || [];
    const idx = shot.takes.findIndex((t) => t.takeId === take.takeId);
    if (idx >= 0) shot.takes[idx] = take; else shot.takes.push(take);
    shot.selectedTakeId = take.takeId;
    shot.clipAssetId = asset.assetId;
    shot.generationTaskId = task?.task_id || task?.taskId || "";
    shot.status = "generated";
    GEN.clearGenerationDirty(shot);

    engine.recordCache(take.generationKey, {
      assetPath: deps.assetsAbsJoin(project.projectId, asset.path),
      fileHash: asset.fileHash, fileSize: asset.fileSize,
      width: asset.width, height: asset.height, duration: asset.duration, codec: asset.codec,
      sourceTaskId: take.sourceTaskId, provider: take.provider, model: take.model,
    });
    return take;
  }

  function failTake(project, shot, take, task, errorKind, error) {
    take.status = "failed";
    take.error = error;
    take.errorKind = errorKind;
    take.updatedAt = Date.now();
    shot.takes = shot.takes || [];
    const idx = shot.takes.findIndex((t) => t.takeId === take.takeId);
    if (idx >= 0) shot.takes[idx] = take; else shot.takes.push(take);
    if (task) {
      engine.updateTask(task.task_id, { status: "failed", error, error_kind: errorKind }, { force: true });
    }
    shot.status = "qc_failed";
    return take;
  }

  /** 在最新快照上定位 shot+take 并应用变更（供 commitProject 使用）。 */
  function applyTakeState(project, shotId, takeId, updater) {
    const shot = (project.shots || []).find((s) => s.shotId === shotId);
    if (!shot) return false;
    const take = (shot.takes || []).find((t) => t.takeId === takeId);
    if (!take) return false;
    updater(shot, take);
    return true;
  }

  /** 只读预览：spec 构建 + capability 校验 + 缓存/in-flight 检查（绝不创建任务）。 */
  async function previewGeneration(p, shot, opts = {}) {
    const provider = String(opts.provider || "local-stub");
    if (provider === "ark") return { ok: false, code: "use_seedance", hint: "ark(arkcli) 通道已废弃；火山方舟视频生成请使用 provider=seedance（模型在设置中配置）" };
    resolveProvider(provider);
    const spec = await buildGenerationSpec(p, shot, { ...opts, provider });
    const validation = await validateSpecForProvider(provider, spec);
    const cached = opts.forceRegenerate ? null : engine.lookupCache(spec.key);
    const inflight = (!opts.forceRegenerate && !cached) ? engine.findInFlightTask(spec.key) : null;
    return {
      ok: true,
      shotId: shot.shotId,
      spec,
      validation,
      blocked: !validation.ok,
      cacheHit: Boolean(cached),
      needsGeneration: !cached,
      inflightTakeId: inflight ? inflight.take_id : null,
      pendingConfirmation: isAsyncProvider(provider) && !cached && !inflight,
    };
  }

  /**
   * 统一生成入口核心（所有生成路径最终都走这里）。
   * 校验失败 / 未确认 / 未知 Provider 时绝不创建远程任务。
   */
  async function enqueueShotForGeneration(p, shot, opts = {}) {
    const provider = String(opts.provider || "local-stub");
    if (provider === "ark") {
      return { ok: false, code: "use_seedance", hint: "ark(arkcli) 通道已废弃；火山方舟视频生成请使用 provider=seedance（模型在设置中配置）" };
    }
    resolveProvider(provider);
    const spec = await buildGenerationSpec(p, shot, { ...opts, provider });
    const validation = await validateSpecForProvider(provider, spec);
    if (!validation.ok) {
      return { ok: false, code: "capability_rejected", shotId: shot.shotId, validation, spec };
    }
    const cached = opts.forceRegenerate ? null : engine.lookupCache(spec.key);
    if (cached) {
      shot.takes = shot.takes || [];
      let take = shot.takes.find((t) => t.generationKey === spec.key && t.status !== "failed" && t.status !== "cancelled");
      let asset;
      if (take) asset = (p.assets || []).find((a) => a.assetId === take.assetId);
      if (!take || !asset) {
        asset = cacheToAsset(p, cached);
        take = GEN.newTake(nextSeq(p, "task"), {
          takeId: GEN.newTakeId(p.projectId, nextSeq(p, "task")),
          shotId: shot.shotId, status: "ready_for_review", generationKey: spec.key, spec,
          provider, model: spec.model, assetId: asset.assetId, fileHash: cached.file_hash,
          fileSize: cached.file_size, width: cached.width, height: cached.height,
          duration: cached.duration, codec: cached.codec, sourceTaskId: cached.source_task_id,
        });
        shot.takes.push(take);
      }
      take.status = "ready_for_review";
      shot.selectedTakeId = take.takeId;
      shot.clipAssetId = asset.assetId;
      shot.status = "generated";
      return { ok: true, shotId: shot.shotId, cacheHit: true, takeId: take.takeId, assetId: asset.assetId, status: "ready_for_review", validation, spec };
    }
    if (!opts.forceRegenerate) {
      const inflight = engine.findInFlightTask(spec.key);
      if (inflight) {
        const existingTake = (shot.takes || []).find((t) => t.takeId === inflight.take_id);
        if (existingTake) {
          shot.selectedTakeId = existingTake.takeId;
          return { ok: true, shotId: shot.shotId, cacheHit: false, reused: true, takeId: existingTake.takeId, taskId: inflight.task_id, status: existingTake.status, validation, spec };
        }
      }
    }
    if (isAsyncProvider(provider) && opts.confirmed !== true) {
      const est = seedance.estimateCost();
      return {
        ok: true, pendingConfirmation: true, shotId: shot.shotId, generationKey: spec.key, spec, validation,
        confirmation: {
          provider, billingMode: spec.billing_mode || null, baseUrl: spec.base_url || null, model: spec.model,
          shotCount: 1, resolution: spec.resolution, ratio: spec.ratio, duration: spec.duration,
          generateAudio: spec.generate_audio, watermark: spec.watermark, returnLastFrame: spec.return_last_frame,
          cacheHit: false, newGenerationCount: 1, cost: est, costDisclaimer: "以服务端实际扣费为准",
          channelLabel: spec.billing_mode === "agent_plan" ? "Agent Plan" : "Platform",
        },
      };
    }
    if (opts._batch && opts._batch.batchCap !== null) {
      if (opts._batch.newCreated >= opts._batch.batchCap) {
        return { ok: false, code: "batch_cap", shotId: shot.shotId, hint: "已到达本次批量上限（batchCap=" + opts._batch.batchCap + "），该镜头本次未提交" };
      }
      opts._batch.newCreated++;
    }
    const isPaid = provider !== "local-stub";
    if (isPaid) {
      const paidCap = Number(p.production?.paidGenerationCap);
      if (Number.isFinite(paidCap) && paidCap > 0 && (p.production?.paidSubmissions || 0) >= paidCap) {
        return { ok: false, code: "paid_cap", shotId: shot.shotId, hint: "本项目付费生成已达上限（" + paidCap + " 条新生成），可通过 queue_control set_paid_cap 调整，或新建项目" };
      }
      p.production.paidSubmissions = (p.production?.paidSubmissions || 0) + 1;
    }
    const takeId = GEN.newTakeId(p.projectId, nextSeq(p, "task"));
    const taskId = GEN.newTaskId(p.projectId, nextSeq(p, "task"));
    const take = GEN.newTake(nextSeq(p, "task"), {
      takeId, shotId: shot.shotId, status: "queued", generationKey: spec.key, spec,
      provider, model: spec.model, taskId,
    });
    shot.takes = shot.takes || [];
    shot.takes.push(take);
    shot.generationTaskId = taskId;
    const created = engine.createTask({
      taskId, projectId: p.projectId, shotId: shot.shotId, takeId,
      generationKey: spec.key, provider, model: spec.model,
      billingMode: spec.billing_mode, baseUrl: spec.base_url,
    });
    if (created.created) engine.updateTask(taskId, { status: "queued" }, { force: true });
    if (!isAsyncProvider(provider)) {
      const req = { shotId: shot.shotId, shot, prompt: spec.prompt, duration: spec.duration, fps: p.fps, seed: spec.seed, palette: (p.bible?.visual?.color || []).slice(0, 3) };
      const result = resolveProvider(provider).submitGeneration(req, deps.assetsDir(p.projectId));
      if (result.ok === false) {
        failTake(p, shot, take, engine.getTask(taskId), "generation", result.error || "生成失败");
      } else {
        const manifest = result.manifest || {};
        const assetId = T.newAssetId(p.projectId, nextSeq(p, "asset"));
        const relDir = manifest.assetDir ? deps.relativeAssetsAbs(p.projectId, manifest.assetDir) : (manifest.jobId || "");
        const asset = {
          ...T.newAsset(nextSeq(p, "asset"), {
            assetId, kind: "video", status: "generated", source: "generated",
            model: spec.model || "local-stub", prompt: manifest.prompt || spec.prompt || "",
            seed: manifest.seed ?? spec.seed ?? null, generationTime: Date.now(),
            duration: manifest.duration ?? null, width: manifest.width ?? null, height: manifest.height ?? null,
          }),
          path: (relDir ? relDir + "/" : "") + (manifest.videoFile || "manifest.json"), frameDir: relDir, manifest,
        };
        p.assets.push(asset);
        finalizeTake(p, shot, take, engine.getTask(taskId), { asset });
        engine.updateTask(taskId, { status: "ready_for_review" }, { force: true });
      }
    }
    shot.status = isAsyncProvider(provider) ? "generating" : shot.status;
    return { ok: true, shotId: shot.shotId, cacheHit: false, takeId, taskId, status: take.status, assetId: take.assetId || null, validation, spec };
  }

  /** 纯异步：提交 seedance 任务。 */
  async function submitSeedanceProvider(task, take) {
    try {
      const r = await seedance.submitGeneration({ spec: take.spec || {} });
      return { ok: true, providerJobId: r.providerJobId };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  }

  /** 纯异步：轮询一次（网络异常只重试查询，不重新创建任务）。 */
  async function pollSeedanceProvider(task, take) {
    try {
      const r = await seedance.pollGeneration(task.provider_job_id, take.spec || {});
      engine.touchPoll(task.task_id, { retryIncrement: true });
      const status = String(r.status || "").toLowerCase();
      if (["succeeded", "success", "completed", "done"].includes(status)) return { kind: "succeeded" };
      if (["failed", "cancelled", "error"].includes(status)) return { kind: "failed", error: "Seedance 任务失败：" + status };
      engine.touchPoll(task.task_id);
      return { kind: "running" };
    } catch (e) {
      engine.touchPoll(task.task_id, { retryIncrement: true });
      return { kind: "running", networkError: true };
    }
  }

  /** 纯异步：下载结果到项目资产目录。 */
  async function downloadSeedanceProvider(task, take, projectId) {
    engine.updateTask(task.task_id, { status: "downloading" }, { force: true });
    const target = deps.assetsAbsJoin(projectId, "seedance", take.takeId + ".mp4");
    fsMkdir(dirname(target));
    try {
      const meta = await seedance.downloadResult(task.provider_job_id, target, take.spec || {});
      engine.updateTask(task.task_id, { status: "ready_for_review", download_attempts: task.download_attempts }, { force: true });
      return { kind: "downloaded", path: target, fileHash: meta.sha256, bytes: meta.bytes, codec: "h264" };
    } catch (e) {
      engine.updateTask(task.task_id, { download_attempts: (task.download_attempts || 0) + 1 }, { force: true });
      return { kind: "download_failed", error: String(e?.message ?? e) };
    }
  }

  /* ---- 导出归档 / 资产解析 ---- */
  function exportArchive(p) {
    const dir = deps.exportsDir(p.projectId);
    const shotsCsv = ["shotId,sceneId,narrativePurpose,duration,shotSize,angle,cameraMovement,startState,primaryAction,endState,transition,status"]
      .concat((p.shots || []).map((s) => [s.shotId, s.sceneId, s.narrativePurpose, s.duration, s.shotSize, s.angle, s.cameraMovement, s.startState, s.primaryAction, s.endState, s.transition, s.status].map((x) => '"' + String(x ?? "").replace(/"/g, '""') + '"').join(",")))
      .join("\n");
    fsWriteFileSync(pathJoin(dir, "shots.csv"), shotsCsv);
    fsWriteFileSync(pathJoin(dir, "project-bible.md"), renderBible(p));
    fsWriteFileSync(pathJoin(dir, "assets-manifest.json"), JSON.stringify(p.assets, null, 2));
    fsWriteFileSync(pathJoin(dir, "rights-manifest.json"), JSON.stringify({ thirdParty: p.thirdParty, assets: p.assets.map((a) => ({ assetId: a.assetId, source: a.source, creator: a.creator, license: a.license, commercialUse: a.commercialUse, attribution: a.attribution, consent: a.consent, model: a.model })) }, null, 2));
    fsWriteFileSync(pathJoin(dir, "third-party-notices.md"), thirdPartyNoticesMarkdown());
    return {
      ok: true, dir,
      files: ["shots.csv", "project-bible.md", "assets-manifest.json", "rights-manifest.json", "third-party-notices.md"],
    };
  }

  function renderBible(p) {
    const b = p.bible || {};
    const L = [];
    L.push("# " + p.title + " — Project Bible");
    L.push("");
    L.push("## Story Bible");
    L.push("- 主题：" + (p.story.theme || "")); L.push("- 前提：" + (p.story.premise || "")); L.push("- 梗概：" + (p.story.synopsis || ""));
    L.push("");
    L.push("## Characters");
    for (const c of b.characters || []) L.push("- " + c.name + "（" + c.characterId + "）：" + [c.age, c.bodyType, c.outfit, c.hair].filter(Boolean).join("，"));
    L.push("");
    L.push("## Locations");
    for (const l of b.locations || []) L.push("- " + l.name + "（" + l.locationId + "）：" + l.layout + " · 光线 " + (l.lightSources || []).join("、"));
    L.push("");
    L.push("## Visual Bible");
    const v = b.visual || {};
    L.push("- 质感：" + (v.texture || "")); L.push("- 色彩：" + (v.color || []).join("、")); L.push("- 光线：" + (v.light || []).join("、"));
    L.push("- 母题：" + (v.motifs || []).join("、"));
    return L.join("\n");
  }

  /** 资产解析器：assetId -> { frameDir(绝对), file(绝对) } 供渲染与 UI */
  function assetResolver(p) {
    const map = {};
    for (const a of p.assets || []) {
      const base = deps.assetsDir(p.projectId);
      map[a.assetId] = {
        frameDir: a.frameDir ? pathJoin(base, a.frameDir) : null,
        file: a.path ? pathJoin(base, a.path) : null,
        assetId: a.assetId, manifest: a.manifest,
      };
    }
    return map;
  }

  return {
    /* 模块与依赖 */
    T, GEN, FF, TL, store, engine, uploader, seedance,
    SKILLS, getSkill, skillsForPhase, orchestratorNext,
    compileGenerationPrompt, getProvider, listProviders,
    renderTimeline, ffmpegAvailable,
    runClipQc, compareClipVersions,
    TOOLS, toolCatalog, THIRD_PARTY_SOURCES, thirdPartyNoticesMarkdown,
    SEEDANCE_CHANNELS, GATE_FOR_PHASE, GATES,
    runningJobs, DEFAULT_CONCURRENCY, MAX_CONCURRENCY,
    apiKeyInfo: deps.apiKeyInfo || { source: "unknown", hasKey: false },
    /* 助手 */
    resolveProvider, isAsyncProvider, seedanceCaps,
    loadProject, saveProject, commitProject, nextSeq, findShot, findAsset, takeAssetFor,
    concurrency, isRunningTask, finalizeTask, startTask, processQueue,
    referenceHashes, frameReferenceHashes, normalizeResolution, buildGenerationSpec,
    validateSpecForProvider, cacheToAsset, finalizeTake, failTake, applyTakeState,
    previewGeneration, enqueueShotForGeneration,
    submitSeedanceProvider, pollSeedanceProvider, downloadSeedanceProvider,
    exportArchive, renderBible, assetResolver,
  };
}

/* ---- 路径/fs 小工具（集中在这里，避免 ctx 依赖 node:path 之外的内部细节） ---- */
import fs from "node:fs";
import path from "node:path";
function pathJoin(...parts) { return path.join(...parts); }
function pathIsInside(target, base) {
  const t = path.resolve(target);
  const b = path.resolve(base);
  const r = path.relative(b, t);
  return !(r === "" || r.startsWith("..") || path.isAbsolute(r));
}
function pathExtname(p) { return path.extname(p); }
function dirname(p) { return path.dirname(p); }
function fsMkdir(p) { fs.mkdirSync(p, { recursive: true }); }
function fsCopyFile(a, b) { fs.copyFileSync(a, b); }
function fsWriteFileSync(p, d) { fs.writeFileSync(p, d, "utf8"); }
