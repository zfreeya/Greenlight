/* ============================================================================
 * Harness Director — 生成域路由（Spec / 缓存 / Take / 付费闸门 / 队列 / QC）
 * 依赖注入：只使用 ctx，不直接 import 服务端内部模块。
 * ==========================================================================*/

/** 创建生成域路由表。ctx 见 server-context.mjs。 */
export default function createGenerationRoutes(ctx) {
  const {
    T, GEN, store, engine, seedance, TL,
    loadProject, saveProject, commitProject, nextSeq, findShot, findAsset, takeAssetFor,
    concurrency, resolveProvider, isAsyncProvider, seedanceCaps,
    buildGenerationSpec, validateSpecForProvider, previewGeneration, enqueueShotForGeneration,
    finalizeTake, failTake, applyTakeState, downloadSeedanceProvider,
    runClipQc, compareClipVersions, orchestratorNext, SKILLS, getProvider,
  } = ctx;

  return {
    "/estimate_generation_cost": async (b) => {
      const p = loadProject(String(b.projectId));
      const shot = findShot(p, String(b.shotId));
      const providerName = String(b.provider || "local-stub");
      const provider = resolveProvider(providerName);
      const est = providerName === "seedance" ? seedance.estimateCost() : provider.estimateCost({ duration: shot.duration });
      shot.estimatedCost = est.amount ?? 0;
      saveProject(p);
      return { ok: true, shotId: shot.shotId, ...est };
    },

    "/submit_video_generation": async (b) => {
      // 兼容适配：旧入口统一走生成引擎（spec→校验→key→缓存→确认→SQLite任务→Provider提交）
      const p = loadProject(String(b.projectId));
      const shot = findShot(p, String(b.shotId));
      const providerName = String(b.provider || "local-stub");
      const r = await enqueueShotForGeneration(p, shot, { ...b, provider: providerName });
      if (r.ok === false) return r;
      saveProject(p);
      const res = {
        ok: true,
        taskId: r.taskId || null,
        status: r.status || null,
        cacheHit: r.cacheHit === true,
        reused: r.reused === true,
        takeId: r.takeId || null,
        pendingConfirmation: Boolean(r.pendingConfirmation),
        confirmation: r.confirmation || null,
        validation: r.validation || null,
        cost: providerName === "seedance" ? seedance.estimateCost() : (() => { try { return resolveProvider(providerName).estimateCost({ duration: shot.duration }); } catch { return null; } })(),
      };
      if (res.pendingConfirmation) {
        res.hint = "付费确认闸门：向用户展示 confirmation 中的费用，获得明确同意后，用 confirm_generation（或 submit_video_generation）传 confirmed=true 重新提交；相同请求会命中缓存不重复计费。confirm_gate 是阶段闸门，不能替代本次付费确认。";
      }
      return res;
    },

    "/poll_video_generation": (b) => {
      const p = loadProject(String(b.projectId));
      const engineTask = engine.getTask(String(b.taskId));
      if (engineTask) {
        const take = (p.shots || []).flatMap((s) => s.takes || []).find((t) => t.taskId === engineTask.task_id || t.takeId === engineTask.take_id);
        return { ok: true, taskId: engineTask.task_id, status: engineTask.status, retries: engineTask.retries, error: engineTask.error, errorKind: engineTask.error_kind, takeId: engineTask.take_id, takeStatus: take?.status || null, outputAssetId: take?.assetId || null };
      }
      const task = (p.generationTasks || []).find((t) => t.taskId === String(b.taskId));
      if (!task) return { ok: false, code: "task_not_found" };
      if (T.TASK_TERMINAL.has(task.status)) return { ok: true, taskId: task.taskId, status: task.status, progress: task.progress, error: task.error, outputAssetId: task.outputAssetId };
      return { ok: true, taskId: task.taskId, status: task.status, progress: task.progress };
    },

    "/cancel_generation": (b) => {
      const p = loadProject(String(b.projectId));
      const engineTask = engine.getTask(String(b.taskId));
      if (engineTask) {
        if (GEN.TASK_TERMINAL.has(engineTask.status)) return { ok: true, taskId: engineTask.task_id, status: engineTask.status, note: "已是终态" };
        if (isAsyncProvider(engineTask.provider) && engineTask.provider_job_id) {
          seedance.cancelGeneration(engineTask.provider_job_id, {}).catch(() => undefined);
        }
        engine.updateTask(engineTask.task_id, { status: "cancelled" }, { force: true });
        const shot = p.shots.find((s) => s.shotId === engineTask.shot_id);
        const take = (shot?.takes || []).find((t) => t.takeId === engineTask.take_id || t.taskId === engineTask.task_id);
        if (take) { take.status = "cancelled"; take.updatedAt = Date.now(); }
        if (shot && shot.status === "generating") shot.status = "planned";
        saveProject(p);
        return { ok: true, taskId: engineTask.task_id, status: "cancelled" };
      }
      const task = (p.generationTasks || []).find((t) => t.taskId === String(b.taskId));
      if (!task) return { ok: false, code: "task_not_found" };
      if (T.TASK_TERMINAL.has(task.status)) return { ok: true, taskId: task.taskId, status: task.status, note: "已是终态" };
      resolveProvider(task.provider).cancelGeneration(task.providerJobId);
      task.status = "cancelled";
      task.finishedAt = Date.now();
      const shot = p.shots.find((s) => s.shotId === task.shotId);
      if (shot && shot.status === "generating") shot.status = "planned";
      saveProject(p);
      return { ok: true, taskId: task.taskId, status: "cancelled" };
    },

    "/import_generated_clip": (b) => {
      const p = loadProject(String(b.projectId));
      const a = b.asset || {};
      const asset = { ...T.newAsset(nextSeq(p, "asset"), { ...a, assetId: a.assetId || T.newAssetId(p.projectId, nextSeq(p, "asset")), status: a.status || "imported" }) };
      p.assets.push(asset);
      saveProject(p);
      return { ok: true, asset };
    },

    "/run_clip_qc": (b) => {
      const p = loadProject(String(b.projectId));
      const shot = findShot(p, String(b.shotId));
      const asset = findAsset(p, String(b.assetId));
      const assetDir = asset.frameDir ? store.assetsDir(p.projectId) + "/" + asset.frameDir : store.resolveAssetPath(p.projectId, asset.path || "");
      const qc = runClipQc(p, shot, asset, assetDir);
      shot.qc = qc;
      if (qc.verdict === "pass" || qc.verdict === "pass_with_notes") shot.status = "approved_clip";
      else shot.status = "qc_failed";
      saveProject(p);
      return { ok: true, qc, shotId: shot.shotId, verdict: qc.verdict };
    },

    "/compare_clip_versions": (b) => {
      const p = loadProject(String(b.projectId));
      const a = findAsset(p, String(b.assetIdA));
      const b2 = findAsset(p, String(b.assetIdB));
      return { ok: true, ...compareClipVersions(a, b2) };
    },

    "/list_skills": (b) => {
      const p = b.projectId ? loadProject(String(b.projectId)) : null;
      return { ok: true, skills: SKILLS.map((s) => ({ name: s.name, phase: s.phase, confirmation: s.confirmation })), route: p ? orchestratorNext(p) : null };
    },

    "/list_providers": async () => {
      const visible = (await Promise.all([Promise.resolve(ctx.listProviders()), seedanceCaps()])).flat();
      return { ok: true, providers: visible.filter((p) => p.name !== "ark" || p.available !== false) };
    },

    "/list_generation_queue": (b) => {
      const p = loadProject(String(b.projectId));
      const legacy = (p.generationTasks || []).map((t) => ({ taskId: t.taskId, shotId: t.shotId, provider: t.provider, model: t.model, status: t.status, progress: t.progress, retries: t.retries, estimatedCost: t.estimatedCost, actualCost: t.actualCost, error: t.error, outputAssetId: t.outputAssetId }));
      const engineTasks = engine.listTasks(p.projectId).map((t) => ({ taskId: t.task_id, shotId: t.shot_id, takeId: t.take_id, provider: t.provider, model: t.model, status: t.status, progress: 0, retries: t.retries, estimatedCost: null, actualCost: null, error: t.error, errorKind: t.error_kind, outputAssetId: null, generationKey: t.generation_key, lastPollAt: t.last_poll_at }));
      const seen = new Set(legacy.map((t) => t.taskId));
      return { ok: true, queue: [...legacy, ...engineTasks.filter((t) => !seen.has(t.taskId))], budget: { actual: p.production?.actualCost || 0, limit: p.production?.budgetLimit || 0, paidCap: p.production?.paidGenerationCap || 0, paidSubmissions: p.production?.paidSubmissions || 0 }, paused: Boolean(p.queuePaused), concurrency: concurrency(p) };
    },

    "/queue_control": (b) => {
      const p = loadProject(String(b.projectId));
      const action = String(b.action);
      if (action === "pause") p.queuePaused = true;
      else if (action === "resume") { p.queuePaused = false; saveProject(p); ctx.processQueue(p); }
      else if (action === "set_concurrency") { p.production.concurrencyLimit = Math.max(1, Number(b.value) || 1); }
      else if (action === "set_budget") { p.production.budgetLimit = Math.max(0, Number(b.value) || 0); }
      else if (action === "set_paid_cap") { p.production.paidGenerationCap = Math.max(0, Number(b.value) || 0); }
      else if (action === "reprioritize") {
        const idx = p.generationTasks.findIndex((t) => t.taskId === String(b.taskId));
        if (idx >= 0 && b.value !== undefined) { const [t] = p.generationTasks.splice(idx, 1); const ni = Math.max(0, Math.min(p.generationTasks.length, Number(b.value))); p.generationTasks.splice(ni, 0, t); }
      } else return { ok: false, code: "unknown_action" };
      saveProject(p);
      return { ok: true, paused: Boolean(p.queuePaused), concurrency: concurrency(p), budgetLimit: p.production.budgetLimit, paidGenerationCap: p.production.paidGenerationCap || 0, paidSubmissions: p.production.paidSubmissions || 0, queue: p.generationTasks.map((t) => ({ taskId: t.taskId, status: t.status })) };
    },

    "/set_project_model": (b) => {
      const p = loadProject(String(b.projectId));
      const model = String(b.model || "").trim();
      if (!model) return { ok: false, code: "model_required", hint: "model 不能为空" };
      p.production = p.production || {};
      p.production.modelVersions = [model];
      saveProject(p);
      return { ok: true, model, note: "模型已写入项目 production.modelVersions[0]，后续生成默认使用（可被显式 model 参数覆盖）" };
    },

    "/compile_generation_spec": async (b) => {
      const p = loadProject(String(b.projectId));
      const shot = findShot(p, String(b.shotId));
      const provider = String(b.provider || "local-stub");
      const r = await previewGeneration(p, shot, { ...b, provider });
      if (r.ok === false) return r;
      const est = (() => {
        try {
          if (provider === "seedance") return seedance.estimateCost();
          return resolveProvider(provider).estimateCost({ duration: shot.duration });
        } catch { return { currency: "CNY", amount: null, range: "未知", note: "以服务端实际扣费为准" }; }
      })();
      const confirmation = {
        provider,
        billingMode: r.spec.billing_mode || null,
        baseUrl: r.spec.base_url || null,
        model: r.spec.model,
        shotCount: 1,
        resolution: r.spec.resolution,
        ratio: r.spec.ratio,
        duration: r.spec.duration,
        generateAudio: r.spec.generate_audio,
        watermark: r.spec.watermark,
        returnLastFrame: r.spec.return_last_frame,
        cacheHit: r.cacheHit === true,
        newGenerationCount: r.cacheHit === true ? 0 : 1,
        cost: est,
        costDisclaimer: "以服务端实际扣费为准",
        channelLabel: provider === "local-stub" ? "本地占位" : (r.spec.billing_mode === "agent_plan" ? "Agent Plan" : (r.spec.billing_mode === "platform" ? "Platform" : "未配置通道")),
      };
      return {
        ok: true,
        shotId: shot.shotId,
        generationKey: r.spec.key,
        spec: r.spec,
        cacheHit: r.cacheHit === true,
        needsGeneration: r.cacheHit !== true,
        validation: r.validation,
        blocked: r.blocked === true,
        confirmation,
        pendingConfirmation: Boolean(r.pendingConfirmation),
      };
    },

    "/confirm_generation": async (b) => {
      if (b.confirmed !== true) return { ok: false, code: "confirmation_required", hint: "付费生成需经确认面板确认后提交（confirmed=true）" };
      const p = loadProject(String(b.projectId));
      const shotIds = Array.isArray(b.shotIds) && b.shotIds.length ? b.shotIds : [String(b.shotId)];
      const provider = String(b.provider || "local-stub");
      const rawCap = Number(b.batchCap);
      const batchCap = Number.isFinite(rawCap) && rawCap > 0 ? Math.floor(rawCap) : null;
      const batch = { batchCap, newCreated: 0 };
      const results = [];
      for (const sid of shotIds) {
        let shot;
        try { shot = findShot(p, sid); } catch { results.push({ shotId: sid, ok: false, code: "shot_not_found" }); continue; }
        const r = await enqueueShotForGeneration(p, shot, { ...b, provider, _batch: batch });
        if (r.ok === false) { results.push({ shotId: sid, ...r }); continue; }
        results.push({ shotId: sid, cacheHit: r.cacheHit === true, reused: r.reused === true, takeId: r.takeId, taskId: r.taskId, status: r.status, assetId: r.assetId || null, validation: r.validation });
      }
      saveProject(p);
      return {
        ok: true, results,
        needsGenerationCount: results.filter((r) => !r.cacheHit && !r.reused && r.ok !== false).length,
        cacheHitCount: results.filter((r) => r.cacheHit).length,
        skippedByCap: results.filter((r) => r.code === "batch_cap").length,
        batchCap,
        costDisclaimer: "Seedance 按次计费，单条费用以服务端实际扣费为准；相同请求命中缓存不重复计费。",
      };
    },

    "/generate_shot": async (b) => {
      const spec = await ctx.routes["/compile_generation_spec"](b);
      if (!spec.ok) return spec;
      if (b.confirmed === true) {
        const r = await ctx.routes["/confirm_generation"](b);
        return { ...spec, ...r };
      }
      return spec;
    },

    "/generate_selected_shots": async (b) => {
      const p = loadProject(String(b.projectId));
      const provider = String(b.provider || "local-stub");
      let shotIds = Array.isArray(b.shotIds) && b.shotIds.length ? b.shotIds.map(String) : null;
      if (!shotIds) {
        shotIds = (p.shots || [])
          .filter((s) => ["approved", "prompt_ready", "generated", "qc_failed", "placed_on_timeline"].includes(s.status))
          .map((s) => s.shotId);
      }
      if (!shotIds.length) return { ok: false, code: "no_shots", hint: "没有可生成的镜头（需先批准镜头）" };
      const rawCap = Number(b.batchCap);
      const batchCap = Number.isFinite(rawCap) && rawCap > 0 ? Math.floor(rawCap) : null;
      const body = { ...b, shotIds };
      if (b.confirmed === true) return ctx.routes["/confirm_generation"](body);
      const items = [];
      for (const sid of shotIds) {
        let shot;
        try { shot = findShot(p, sid); } catch { items.push({ shotId: sid, blocked: true, cacheHit: false, inflight: false, newGen: false, shotNotFound: true }); continue; }
        const r = await previewGeneration(p, shot, { ...b, provider });
        items.push({
          shotId: sid,
          generationKey: r.spec?.key || null,
          cacheHit: r.cacheHit === true,
          inflight: Boolean(r.inflightTakeId),
          newGen: r.cacheHit !== true && !r.inflightTakeId,
          duration: r.spec?.duration ?? shot.duration,
          blocked: r.blocked === true,
          validation: r.validation,
        });
      }
      return {
        ok: true, pending: true, shotIds, items,
        newGenerationCount: items.filter((i) => i.newGen).length,
        cacheHitCount: items.filter((i) => i.cacheHit).length,
        batchCap,
        costDisclaimer: "Seedance 按次计费，服务端无法在本地预估单条费用，以实际扣费为准；命中缓存不产生新费用。",
        hint: "请用户确认后再次调用并传 confirmed=true（可选 batchCap 限制本次最多新生成条数）",
      };
    },

    "/select_take": (b) => {
      const p = loadProject(String(b.projectId));
      const shot = findShot(p, String(b.shotId));
      const take = (shot.takes || []).find((t) => t.takeId === String(b.takeId));
      if (!take) return { ok: false, code: "take_not_found" };
      shot.selectedTakeId = take.takeId;
      shot.clipAssetId = take.assetId;
      shot.status = "generated";
      take.status = "selected";
      for (const t of shot.takes) if (t.takeId !== take.takeId && t.status === "selected") t.status = "ready_for_review";
      saveProject(p);
      return { ok: true, shotId: shot.shotId, selectedTakeId: take.takeId };
    },

    "/lock_take": (b) => {
      const p = loadProject(String(b.projectId));
      const shot = findShot(p, String(b.shotId));
      const take = (shot.takes || []).find((t) => t.takeId === String(b.takeId));
      if (!take) return { ok: false, code: "take_not_found" };
      take.status = "locked";
      shot.status = "locked";
      shot.locked = true;
      saveProject(p);
      return { ok: true, shotId: shot.shotId, takeId: take.takeId, status: "locked" };
    },

    "/list_takes": (b) => {
      const p = loadProject(String(b.projectId));
      const shot = findShot(p, String(b.shotId));
      return { ok: true, takes: shot.takes || [], selectedTakeId: shot.selectedTakeId || null };
    },

    "/retry_download": async (b) => {
      const pid = String(b.projectId);
      const shotId = String(b.shotId);
      const takeId = String(b.takeId);
      const p = loadProject(pid);
      const shot = findShot(p, shotId);
      const take = (shot.takes || []).find((t) => t.takeId === takeId);
      if (!take) return { ok: false, code: "take_not_found" };
      if (take.errorKind !== "download") return { ok: false, code: "not_download_failure", hint: "仅下载失败可重试下载，生成失败不得通过本接口重新生成" };
      const task = engine.getTaskByTake(takeId) || { task_id: take.taskId || takeId, provider_job_id: take.taskId || takeId, download_attempts: 0 };
      commitProject(pid, (fresh) => applyTakeState(fresh, shotId, takeId, (s, t) => { t.status = "downloading"; t.updatedAt = Date.now(); }));
      const dl = await downloadSeedanceProvider(task, take, pid);
      if (dl.kind === "downloaded") {
        commitProject(pid, (fresh) => {
          const fshot = (fresh.shots || []).find((s) => s.shotId === shotId);
          const ftake = fshot?.takes?.find((t) => t.takeId === takeId);
          if (fshot && ftake) finalizeTake(fresh, fshot, ftake, task, { path: dl.path, fileHash: dl.fileHash, bytes: dl.bytes, codec: dl.codec });
        });
        return { ok: true, takeId, status: "ready_for_review" };
      }
      commitProject(pid, (fresh) => {
        const fshot = (fresh.shots || []).find((s) => s.shotId === shotId);
        const ftake = fshot?.takes?.find((t) => t.takeId === takeId);
        if (fshot && ftake) failTake(fresh, fshot, ftake, task, "download", dl.error);
      });
      return { ok: false, code: "download_failed", takeId, status: "failed", errorKind: "download", error: dl.error };
    },
  };
}
