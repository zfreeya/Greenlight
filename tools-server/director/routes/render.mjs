/* ============================================================================
 * Harness Director — 渲染/剪辑域路由（时间线 / FFmpeg / 导出 / 渲染历史）
 * 依赖注入：只使用 ctx，不直接 import 服务端内部模块。
 * ==========================================================================*/

/** 创建渲染域路由表。ctx 见 server-context.mjs。 */
export default function createRenderRoutes(ctx) {
  const {
    T, GEN, FF, TL, store, engine, uploader,
    loadProject, saveProject, commitProject, nextSeq, findShot, findAsset,
    assetResolver, apiKeyInfo,
  } = ctx;

  return {
    "/place_clip_on_timeline": (b) => {
      const p = loadProject(String(b.projectId));
      const shot = findShot(p, String(b.shotId));
      const asset = findAsset(p, String(b.assetId));
      const timeline = TL.ensureTimeline(p);
      const clip = TL.placeClipOnTimeline(timeline, { shotId: shot.shotId, assetId: asset.assetId, duration: shot.duration, label: shot.shotId }, { start: b.start, trackId: b.trackId });
      shot.status = "placed_on_timeline";
      GEN.markRenderDirty(p, "时间线片段变更");
      saveProject(p);
      return { ok: true, clip, timeline };
    },

    "/create_voiceover": (b) => {
      const p = loadProject(String(b.projectId));
      const vo = b.voiceover || {};
      p.voiceovers = p.voiceovers || [];
      const rec = { id: "VO-" + (p.voiceovers.length + 1), character: vo.character || "", consent: vo.consent || "", language: vo.language || p.language, rate: vo.rate || 1, emotion: vo.emotion || "", text: vo.text || "", timecode: vo.timecode || null, version: vo.version || 1, createdAt: Date.now() };
      p.voiceovers.push(rec);
      saveProject(p);
      return { ok: true, voiceover: rec };
    },

    "/add_music": (b) => {
      const p = loadProject(String(b.projectId));
      const asset = findAsset(p, String(b.assetId));
      const timeline = TL.ensureTimeline(p);
      const clip = TL.addAudioClip(timeline, { assetId: asset.assetId, kind: b.kind || "music", label: asset.path || "", duration: asset.duration || 0 }, { start: b.start, volume: b.volume, trackId: b.trackId });
      GEN.markRenderDirty(p, "配乐/音频变更");
      saveProject(p);
      return { ok: true, clip, timeline };
    },

    "/generate_captions": (b) => {
      const p = loadProject(String(b.projectId));
      const caps = Array.isArray(b.captions) ? b.captions : [];
      const timeline = TL.ensureTimeline(p);
      timeline.captions = caps.map((c, i) => ({ id: "CAP-" + i, text: c.text || "", start: c.start || 0, end: c.end || 0, style: c.style || {} }));
      GEN.markRenderDirty(p, "字幕变更");
      saveProject(p);
      return { ok: true, captions: timeline.captions };
    },

    "/render_preview": async (b) => {
      const p = loadProject(String(b.projectId));
      const timeline = TL.ensureTimeline(p);
      const outFile = ctx.store.exportsDir(p.projectId) + "/preview.mp4";
      const assets = assetResolver(p);
      const res = await ctx.renderTimeline(timeline, p, { outFile, preview: true, workdir: ctx.store.exportsDir(p.projectId), assetResolver: (id) => assets[id] });
      saveProject(p);
      return { ok: res.ok !== false, ...res };
    },

    "/render_final": async (b) => {
      const p = loadProject(String(b.projectId));
      const timeline = TL.ensureTimeline(p);
      const outFile = ctx.store.exportsDir(p.projectId) + "/" + p.title.replace(/[^\w\u4e00-\u9fa5-]/g, "_").slice(0, 40) + "-final.mp4";
      const assets = assetResolver(p);
      const res = await ctx.renderTimeline(timeline, p, { outFile, preview: false, workdir: ctx.store.exportsDir(p.projectId), assetResolver: (id) => assets[id] });
      saveProject(p);
      return { ok: res.ok !== false, ...res, ffmpegAvailable: ctx.ffmpegAvailable() };
    },

    "/export_project_archive": (b) => {
      const p = loadProject(String(b.projectId));
      return ctx.exportArchive(p);
    },

    "/ffmpeg_status": () => ({ ok: true, ...FF.detectFfmpeg(), installPlan: FF.ffmpegInstallPlan() }),
    "/keychain_status": () => ({ ok: true, source: apiKeyInfo.source, hasKey: apiKeyInfo.hasKey, note: "仅返回来源，绝不返回 Key 本体" }),
    "/ffmpeg_install_plan": () => ({ ok: true, ...FF.ffmpegInstallPlan() }),

    "/probe_asset": (b) => {
      const p = loadProject(String(b.projectId));
      const asset = findAsset(p, String(b.assetId));
      const abs = asset.frameDir ? store.assetsDir(p.projectId) + "/" + asset.frameDir : store.assetsDir(p.projectId) + "/" + (asset.path || "");
      return { ok: true, ...FF.probe(abs) };
    },

    "/make_proxy": async (b) => {
      const pid = String(b.projectId);
      const p = loadProject(pid);
      const asset = findAsset(p, String(b.assetId));
      const abs = store.assetsDir(pid) + "/" + (asset.path || "");
      const outDir = store.assetsDir(pid);
      const outFile = outDir + "/proxy/" + asset.assetId + "-proxy.mp4";
      mkdirp(pathDirname(outFile));
      const r = await FF.makeProxy(abs, outFile, { width: b.width || 960, fps: b.fps || 24 });
      if (r.executed && r.ok) {
        const rel = pathRelative(outDir, outFile);
        commitProject(pid, (fresh) => {
          const a = (fresh.assets || []).find((x) => x.assetId === asset.assetId);
          if (a) a.proxyPath = rel;
        });
      }
      return { ok: r.ok !== false, ...r, proxyPath: pathRelative(outDir, outFile) };
    },

    "/make_thumbnail": (b) => {
      const p = loadProject(String(b.projectId));
      const asset = findAsset(p, String(b.assetId));
      const abs = store.assetsDir(p.projectId) + "/" + (asset.path || "");
      const outDir = store.assetsDir(p.projectId);
      const outFile = outDir + "/thumbs/" + asset.assetId + ".jpg";
      mkdirp(pathDirname(outFile));
      return FF.makeThumbnail(abs, outFile, b.atSec || 0).then((r) => ({ ok: r.ok !== false, ...r }));
    },

    "/export_final": async (b) => {
      const pid = String(b.projectId);
      const p = loadProject(pid);
      const timeline = TL.ensureTimeline(p);
      const outDir = store.exportsDir(pid);
      const assets = assetResolver(p);
      const base = outDir + "/" + (p.title.replace(/[^\w\u4e00-\u9fa5-]/g, "_").slice(0, 40) || "final") + ".mp4";
      const opts = { outFile: base, baseDir: outDir, preview: false, fps: p.fps, assetResolver: (id) => assets[id], crf: b.crf ?? 23, audioEnabled: timeline.global?.audioEnabled !== false };
      const r = await FF.exportTimeline(timeline, p, opts);
      commitProject(pid, (fresh) => { GEN.clearRenderDirty(fresh); });
      const ratios = Array.isArray(b.aspectRatios) && b.aspectRatios.length ? b.aspectRatios : [];
      if (!ratios.length) return { ok: r.ok !== false, ...r, ffmpeg: FF.detectFfmpeg() };
      const variants = await FF.exportVariants(timeline, p, { ...opts, aspectRatios: ratios });
      return { ok: r.ok !== false, ...r, variants, ffmpeg: FF.detectFfmpeg() };
    },

    "/update_clip": (b) => {
      const p = loadProject(String(b.projectId));
      const timeline = TL.ensureTimeline(p);
      const clip = timeline.videoTracks.flatMap((t) => t.clips).find((c) => c.clipId === String(b.clipId));
      if (!clip) return { ok: false, code: "clip_not_found" };
      if (b.start !== undefined && b.end !== undefined) { clip.start = Number(b.start); clip.end = Number(b.end); clip.duration = Number(b.end) - Number(b.start); }
      if (b.volume !== undefined) clip.volume = Number(b.volume);
      if (b.mute === true) clip.volume = 0;
      if (b.fadeIn !== undefined) clip.fadeIn = Number(b.fadeIn);
      if (b.fadeOut !== undefined) clip.fadeOut = Number(b.fadeOut);
      GEN.markRenderDirty(p, "clip 编辑");
      saveProject(p);
      return { ok: true, clip };
    },

    "/reorder_clips": (b) => {
      const p = loadProject(String(b.projectId));
      const timeline = TL.ensureTimeline(p);
      const track = timeline.videoTracks.find((t) => t.id === "V1") || timeline.videoTracks[0];
      const shotIds = Array.isArray(b.shotIds) ? b.shotIds : [];
      if (!shotIds.length) return { ok: false, code: "no_shot_ids" };
      const byShot = new Map(track.clips.map((c) => [c.shotId, c]));
      const ordered = shotIds.map((sid) => byShot.get(sid)).filter(Boolean);
      if (!ordered.length) return { ok: false, code: "no_clips" };
      let t = 0;
      for (const c of ordered) { c.start = t; c.end = t + c.duration; t = c.end; }
      track.clips = ordered;
      GEN.markRenderDirty(p, "镜头顺序调整");
      saveProject(p);
      return { ok: true, timeline };
    },

    "/add_transition": (b) => {
      const p = loadProject(String(b.projectId));
      const timeline = TL.ensureTimeline(p);
      const tr = TL.addTransition(timeline, String(b.fromClipId), String(b.toClipId), String(b.type || "crossfade"));
      GEN.markRenderDirty(p, "转场变更");
      saveProject(p);
      return { ok: true, transition: tr };
    },

    "/set_audio_clip": (b) => {
      const p = loadProject(String(b.projectId));
      const timeline = TL.ensureTimeline(p);
      const ac = timeline.audioTracks.flatMap((t) => t.clips).find((c) => c.clipId === String(b.clipId));
      if (!ac) return { ok: false, code: "audio_clip_not_found" };
      if (b.volume !== undefined) ac.volume = Number(b.volume);
      if (b.mute === true) ac.volume = 0;
      if (b.fadeIn !== undefined) ac.fadeIn = Number(b.fadeIn);
      if (b.fadeOut !== undefined) ac.fadeOut = Number(b.fadeOut);
      GEN.markRenderDirty(p, "音频/音量变更");
      saveProject(p);
      return { ok: true, clip: ac };
    },

    "/create_render_job": async (b) => {
      const pid = String(b.projectId);
      const p = loadProject(pid);
      const timeline = TL.ensureTimeline(p);
      const outDir = store.exportsDir(pid);
      const assets = assetResolver(p);
      const seq = nextSeq(p, "renderJob");
      const job = T.newRenderJob(seq, {
        projectId: pid,
        timelineRevision: p._rev || 0,
        outputProfile: String(b.outputProfile || "h264-aac-yuv420p-faststart-48k"),
        inputAssets: (timeline.videoTracks || []).flatMap((t) => t.clips.map((c) => c.assetId || c.versionRef)).filter(Boolean),
      });
      p.renderJobs = p.renderJobs || [];
      p.renderJobs.push(job);
      saveProject(p);
      const base = outDir + "/" + (p.title || "final").replace(/[^\w\u4e00-\u9fa5-]/g, "_").slice(0, 40) + "-" + job.renderJobId + ".mp4";
      const opts = { outFile: base, baseDir: outDir, fps: p.fps, assetResolver: (id) => assets[id], crf: b.crf ?? 23 };
      const r = await FF.exportTimeline(timeline, p, opts);
      commitProject(pid, (fresh) => {
        const j = (fresh.renderJobs || []).find((x) => x.renderJobId === job.renderJobId);
        if (!j) return;
        j.status = r.executed && r.ok ? "succeeded" : "failed";
        j.progress = r.executed && r.ok ? 100 : 0;
        j.outputPath = r.executed && r.ok ? base : "";
        j.ffmpegArgsSummary = Array.isArray(r.args) ? r.args.join(" ") : "";
        j.error = r.executed && !r.ok ? (r.stderrTail || "ffmpeg 失败") : (r.executed === false ? "ffmpeg 未安装" : null);
        j.finishedAt = Date.now();
        GEN.clearRenderDirty(fresh);
      });
      return { ok: true, renderJob: job.renderJobId, status: job.status, ffmpeg: FF.detectFfmpeg() };
    },

    "/list_render_jobs": (b) => {
      const p = loadProject(String(b.projectId));
      return { ok: true, renderJobs: (p.renderJobs || []).slice(-50).reverse() };
    },
  };
}

/* 本地 path/fs 小工具（不引 node:path 进路由模块顶层，保持模块纯净可打包） */
import fs from "node:fs";
import path from "node:path";
function pathDirname(p) { return path.dirname(p); }
function pathRelative(base, target) { return path.relative(base, target); }
function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }
