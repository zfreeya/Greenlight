/* ============================================================================
 * Harness Director — 业务域路由（连续性检查 / 产品模板 / 订单记账 / 反向工作流 / 资产）
 * 依赖注入：只使用 ctx，不直接 import 服务端内部模块。
 * ==========================================================================*/
import fs from "node:fs";
import path from "node:path";

/** 创建业务域路由表。ctx 见 server-context.mjs。 */
export default function createBusinessRoutes(ctx) {
  const { T, GEN, FF, store, engine, uploader, loadProject, saveProject, commitProject, nextSeq, findShot, findAsset, takeAssetFor } = ctx;

  return {
    /* ---- 连续性检查 v0（审片页）：时间线顺序 + 绑定 Take 版本 ---- */
    "/continuity_check": async (b) => {
      const p = loadProject(String(b.projectId));
      if (!FF.detectFfmpeg().available) return { ok: false, code: "ffmpeg_missing", hint: "连续性检查依赖本地 FFmpeg 抽帧" };
      const withTake = (p.shots || []).filter((s) => takeAssetFor(p, s));
      if (withTake.length < 2) return { ok: false, code: "need_two_shots", hint: "至少需要两个有已通过 Take 的镜头才能检查相邻差异" };
      // 顺序基准：时间线上已有 clip 时按时间线顺序（用户重排后检查跟着走），否则退回镜头 index。
      const clipOrder = new Map();
      for (const t of (p.timeline?.videoTracks || [])) {
        for (const c of (t.clips || [])) {
          if (!clipOrder.has(c.shotId)) clipOrder.set(c.shotId, c.start);
        }
      }
      const ordered = withTake.slice().sort((a, z) => {
        const ca = clipOrder.has(a.shotId), cz = clipOrder.has(z.shotId);
        if (ca && cz) return clipOrder.get(a.shotId) - clipOrder.get(z.shotId);
        if (ca !== cz) return ca ? -1 : 1;
        return (a.index || 0) - (z.index || 0);
      });
      const orderBasis = clipOrder.size >= 2 ? "timeline" : "shot_index";
      const pairs = [];
      for (let i = 0; i + 1 < ordered.length; i++) {
        const a = takeAssetFor(p, ordered[i]);
        const z = takeAssetFor(p, ordered[i + 1]);
        if (!a || !z) continue;
        const sa = await FF.frameStats(a.abs, Math.max(0, (a.duration ?? 0) - 0.3));
        const sb = await FF.frameStats(z.abs, 0.1);
        if (!sa.ok || !sb.ok) {
          pairs.push({ shotIdA: ordered[i].shotId, shotIdB: ordered[i + 1].shotId, takeIdA: a.takeId, takeIdB: z.takeId, verdict: "error", error: sa.error || sb.error });
          continue;
        }
        const lumaDiff = Math.abs(sa.luma - sb.luma);
        const rgbDiff = Math.max(Math.abs(sa.r - sb.r), Math.abs(sa.g - sb.g), Math.abs(sa.b - sb.b));
        let histDiff = 0;
        for (let h = 0; h < 16; h++) histDiff += Math.abs(sa.hist[h] - sb.hist[h]);
        histDiff /= 2;
        const verdict = (lumaDiff > 12 || rgbDiff > 24 || histDiff > 0.4) ? "warn" : "ok";
        pairs.push({ shotIdA: ordered[i].shotId, shotIdB: ordered[i + 1].shotId, takeIdA: a.takeId, takeIdB: z.takeId, lumaDiff: +lumaDiff.toFixed(1), rgbDiff: +rgbDiff.toFixed(1), histDiff: +histDiff.toFixed(3), verdict });
      }
      const csvName = "continuity-check-" + Date.now() + ".csv";
      const csvAbs = path.join(store.exportsDir(p.projectId), csvName);
      fs.mkdirSync(path.dirname(csvAbs), { recursive: true });
      const rows = [["shotA", "shotB", "takeA", "takeB", "lumaDiff", "rgbDiff", "histDiff", "verdict"].join(",")];
      for (const x of pairs) rows.push([x.shotIdA, x.shotIdB, x.takeIdA ?? "", x.takeIdB ?? "", x.lumaDiff ?? "", x.rgbDiff ?? "", x.histDiff ?? "", x.verdict].join(","));
      fs.writeFileSync(csvAbs, rows.join("\n") + "\n");
      p.continuityChecks = { at: Date.now(), pairs, csvPath: csvName, orderBasis };
      saveProject(p);
      return { ok: true, at: p.continuityChecks.at, pairs, csv: csvName, orderBasis, warnCount: pairs.filter((x) => x.verdict === "warn").length, errorCount: pairs.filter((x) => x.verdict === "error").length };
    },

    /* ---- 产品模板：建 4 镜头 + 产品角色卡（一致性锚点，07 保温杯单） ---- */
    "/create_shot_list_from_template": (b) => {
      const p = loadProject(String(b.projectId));
      const tpl = String(b.template || "product_4shot");
      const product = String(b.product || p.title || "产品").trim();
      if (tpl !== "product_4shot") return { ok: false, code: "unknown_template", hint: "仅支持 product_4shot（产品特写/桌面/手持/促销结尾）" };
      if ((p.shots || []).length) return { ok: false, code: "shots_exist", hint: "项目已有镜头，模板只用于空项目起步" };
      const shots = [
        { shotId: "SHOT-001", narrativePurpose: "产品特写：倒水瞬间，突出材质与水花", duration: 5, shotSize: "特写", cameraMovement: "固定", subject: product + "倒水特写", startState: "杯中立桌", primaryAction: "倒水", endState: "水面晃动", environment: "纯色背景" },
        { shotId: "SHOT-002", narrativePurpose: "桌面场景：产品融入使用环境", duration: 5, shotSize: "中景", cameraMovement: "缓慢推近", subject: product + "置于桌面", startState: "桌面近景", primaryAction: "拿起", endState: "举至镜头前", environment: "办公室桌面" },
        { shotId: "SHOT-003", narrativePurpose: "手持使用：展示便携与单手操作", duration: 5, shotSize: "近景", cameraMovement: "跟随", subject: "手持" + product, startState: "手持状态", primaryAction: "开盖饮用", endState: "放下", environment: "户外浅景深" },
        { shotId: "SHOT-004", narrativePurpose: "促销结尾：产品居中，干净收尾", duration: 5, shotSize: "全景", cameraMovement: "固定", subject: product + "居中展示", startState: "产品居中", primaryAction: "静态展示", endState: "定格", environment: "渐变背景" },
      ];
      const created = shots.map((s) => {
        const seq = nextSeq(p, "shot");
        const shot = T.newShot(seq, s);
        p.shots.push(shot);
        return shot;
      });
      const charSeq = nextSeq(p, "char");
      const productChar = T.newCharacterBible(charSeq, {
        name: product, bodyType: "产品本体", face: "产品外观", hair: "",
        outfit: "产品包装/配色", accessories: "品牌标识",
        immutableTraits: ["产品外观跨镜头保持一致", "品牌标识不漂移"],
        referenceImages: [],
      });
      p.bible = p.bible || {};
      p.bible.characters = p.bible.characters || [];
      p.bible.characters.push(productChar);
      for (const s of created) {
        s.continuityAnchors = s.continuityAnchors || [];
        if (!s.continuityAnchors.includes(productChar.characterId)) s.continuityAnchors.push(productChar.characterId);
      }
      saveProject(p);
      return { ok: true, count: created.length, template: tpl, product, productCharacterId: productChar.characterId, shots: created, hint: "产品已建为角色卡（一致性锚点）；如需锁定产品外观，把产品参考图导入为资产后挂到镜头 keyframes.characterRef" };
    },

    /* ---- 订单记账：order_summary 汇总镜头/Take/任务/成本，CSV 导出 ---- */
    "/order_summary": (b) => {
      const p = loadProject(String(b.projectId));
      const tasks = (p.generationTasks || []).map((t) => ({
        taskId: t.taskId, shotId: t.shotId, provider: t.provider, model: t.model, status: t.status,
        retries: t.retries || 0, estimatedCost: t.estimatedCost ?? null, actualCost: t.actualCost ?? null,
        createdAt: t.queuedAt || t.createdAt || null, startedAt: t.startedAt || null, finishedAt: t.finishedAt || null,
      }));
      const engineTasks = engine.listTasks(p.projectId).map((t) => ({
        taskId: t.task_id, shotId: t.shot_id, provider: t.provider, model: t.model, status: t.status,
        retries: t.retries || 0, estimatedCost: null, actualCost: null,
        createdAt: t.created_at || null, startedAt: t.started_at || null, finishedAt: t.finished_at || null,
      }));
      const seen = new Set(tasks.map((t) => t.taskId));
      const all = [...tasks, ...engineTasks.filter((t) => !seen.has(t.taskId))];
      const shots = (p.shots || []).map((s) => ({ shotId: s.shotId, status: s.status, takeCount: (s.takes || []).length, clipAssetId: s.clipAssetId || null }));
      const csvName = "order-summary-" + Date.now() + ".csv";
      const csvAbs = path.join(store.exportsDir(p.projectId), csvName);
      fs.mkdirSync(path.dirname(csvAbs), { recursive: true });
      const rows = [
        ["项目", "镜头", "状态", "Take数", "任务", "Provider", "模型", "任务状态", "重试", "预计(分)", "实际(分)", "创建", "完成"].join(","),
        ...shots.map((s) => [p.title, s.shotId, s.status, s.takeCount, "", "", "", "", "", "", "", "", ""].join(",")),
        ...all.map((t) => ["", t.shotId, "", "", t.taskId, t.provider, t.model, t.status, t.retries, t.estimatedCost ?? "", t.actualCost ?? "", t.createdAt ? new Date(t.createdAt).toISOString().slice(0, 16) : "", t.finishedAt ? new Date(t.finishedAt).toISOString().slice(0, 16) : ""].join(",")),
      ];
      fs.writeFileSync(csvAbs, rows.join("\n") + "\n");
      return {
        ok: true, projectId: p.projectId, title: p.title, csv: csvName,
        shots: shots.length, tasks: all.length,
        retryTotal: all.reduce((n, t) => n + (t.retries || 0), 0),
        actualCostFen: all.reduce((n, t) => n + (t.actualCost || 0), 0),
        createdAt: p.createdAt, updatedAt: p.updatedAt,
        note: "前 5 单逐单记账，校准成本与耗时（05/08 要求）",
      };
    },

    /* ---- 反向工作流（O2-KR2）：导入 → 抽帧 → 反推 ---- */
    "/import_user_video": (b) => {
      const p = loadProject(String(b.projectId));
      const srcPath = String(b.path || "").trim();
      if (!srcPath) return { ok: false, code: "path_required", hint: "需要提供本地视频文件的绝对路径" };
      if (!fs.existsSync(srcPath) || !fs.statSync(srcPath).isFile()) {
        return { ok: false, code: "file_not_found", hint: "文件不存在或不是普通文件：" + srcPath };
      }
      const probe = FF.probe(srcPath);
      if (!probe.ok || !probe.width) {
        return { ok: false, code: "not_video", hint: probe.error || "ffprobe 未识别出视频流（ffmpeg 未安装或文件不是视频）" };
      }
      const assetId = T.newAssetId(p.projectId, nextSeq(p, "asset"));
      const ext = (path.extname(srcPath) || ".mp4").toLowerCase();
      const rel = "user-videos/" + assetId + ext;
      const outAbs = path.join(store.assetsDir(p.projectId), rel);
      fs.mkdirSync(path.dirname(outAbs), { recursive: true });
      fs.copyFileSync(srcPath, outAbs);
      const asset = {
        ...T.newAsset(nextSeq(p, "asset"), {
          assetId, kind: "video_user", status: "imported", source: "user_import",
          title: b.title || path.basename(srcPath), path: rel,
          duration: probe.duration, width: probe.width, height: probe.height,
          codec: probe.videoCodec, createdAt: Date.now(),
        }),
        probe: { fps: probe.fps, audioCodec: probe.audioCodec, sampleRate: probe.sampleRate },
      };
      p.assets.push(asset);
      p.userVideos = p.userVideos || [];
      p.userVideos.push({ assetId, srcPath, importedAt: Date.now() });
      saveProject(p);
      return { ok: true, assetId, duration: probe.duration, width: probe.width, height: probe.height, fps: probe.fps, codec: probe.videoCodec, path: rel, hint: "下一步调用 sample_frames 抽帧，再让 Agent 用 reverse_storyboard 反推镜头草稿（草稿确认后才会写入镜头表）" };
    },

    "/sample_frames": async (b) => {
      const p = loadProject(String(b.projectId));
      const asset = findAsset(p, String(b.assetId));
      if (asset.kind !== "video_user" && asset.kind !== "video") {
        return { ok: false, code: "not_video_asset", hint: "只支持视频资产抽帧" };
      }
      const abs = path.join(store.assetsDir(p.projectId), asset.path || "");
      const frameDir = path.join(store.assetsDir(p.projectId), "frames", asset.assetId);
      const r = await FF.extractFrames(abs, frameDir, { intervalSec: b.intervalSec, maxFrames: b.maxFrames });
      if (!r.ok) return { ok: false, code: "extract_failed", hint: r.reason || r.error || "抽帧失败" };
      const relDir = path.relative(store.assetsDir(p.projectId), frameDir);
      asset.frameDir = relDir;
      asset.manifest = { provider: "user_import", frames: r.frames, duration: asset.duration, fps: asset.probe?.fps ?? null };
      saveProject(p);
      return { ok: true, assetId: asset.assetId, frames: r.frames, count: r.count, intervalSec: r.intervalSec };
    },

    "/reverse_storyboard": (b) => {
      const p = loadProject(String(b.projectId));
      const asset = findAsset(p, String(b.assetId));
      const frames = Array.isArray(asset.manifest?.frames) ? asset.manifest.frames : [];
      return {
        ok: true,
        assetId: asset.assetId,
        title: asset.title || asset.assetId,
        duration: asset.duration ?? null,
        width: asset.width ?? null, height: asset.height ?? null,
        fps: asset.probe?.fps ?? null,
        frames,
        hasFrames: frames.length > 0,
        hint: "请依据时长、帧序列和用户说明反推镜头草稿（segments: start/end/景别/运镜/主体/叙事目的），展示给用户确认后再用 create_shot_list 写入正式镜头表；草稿本身不写入项目。",
      };
    },

    /* ---- 尾帧衔接 / 首帧参考 / 删除保护 ---- */
    "/extract_last_frame": (b) => {
      const p = loadProject(String(b.projectId));
      const shot = findShot(p, String(b.shotId));
      const take = (shot.takes || []).find((t) => t.takeId === String(b.takeId || shot.selectedTakeId));
      if (!take || !take.assetId) return { ok: false, code: "no_take_asset" };
      const srcAsset = findAsset(p, take.assetId);
      const srcAbs = path.join(store.assetsDir(p.projectId), srcAsset.path || "");
      const assetId = T.newAssetId(p.projectId, nextSeq(p, "asset"));
      const rel = "frames/" + assetId + ".jpg";
      const outAbs = path.join(store.assetsDir(p.projectId), rel);
      fs.mkdirSync(path.dirname(outAbs), { recursive: true });
      return FF.makeThumbnail(srcAbs, outAbs, b.atSec ?? -0.1).then((r) => {
        const asset = {
          ...T.newAsset(nextSeq(p, "asset"), {
            assetId, kind: "image", status: "imported", source: "extracted_last_frame",
            model: srcAsset.model || "", prompt: "", generationTime: Date.now(),
          }),
          path: rel,
          frameOfAssetId: srcAsset.assetId,
          sourceTakeId: take.takeId,
          frameKind: "last_frame",
          extractedAt: Date.now(),
        };
        p.assets.push(asset);
        saveProject(p);
        return { ok: true, assetId, rel, executed: r.executed, ffmpegOk: r.ok !== false };
      });
    },

    "/use_as_first_frame": (b) => {
      const p = loadProject(String(b.projectId));
      const shot = findShot(p, String(b.shotId));
      const frameAsset = findAsset(p, String(b.frameAssetId));
      if (frameAsset.kind !== "image" || frameAsset.frameKind !== "last_frame") return { ok: false, code: "not_last_frame", hint: "仅尾帧资产可作为首帧参考" };
      shot.keyframes = shot.keyframes || {};
      shot.keyframes.firstFrame = frameAsset.assetId;
      GEN.markGenerationDirty(shot, "首帧参考变更（尾帧衔接）");
      saveProject(p);
      return { ok: true, shotId: shot.shotId, firstFrame: frameAsset.assetId, generationDirty: true };
    },

    "/delete_asset": (b) => {
      const p = loadProject(String(b.projectId));
      const asset = findAsset(p, String(b.assetId));
      const refs = [];
      for (const s of p.shots || []) {
        if (s.clipAssetId === asset.assetId) refs.push({ where: "shot", id: s.shotId, detail: "clipAssetId" });
        for (const t of s.takes || []) if (t.assetId === asset.assetId) refs.push({ where: "take", id: t.takeId, detail: "take.assetId" });
        const kf = s.keyframes || {};
        if (kf.firstFrame === asset.assetId) refs.push({ where: "shot", id: s.shotId, detail: "keyframes.firstFrame" });
        if (kf.lastFrame === asset.assetId) refs.push({ where: "shot", id: s.shotId, detail: "keyframes.lastFrame" });
      }
      for (const t of (p.timeline?.videoTracks || [])) for (const c of t.clips || []) if (c.assetId === asset.assetId || c.versionRef === asset.assetId) refs.push({ where: "timeline", id: c.clipId, detail: "clip" });
      for (const j of (p.renderJobs || [])) if ((j.inputAssets || []).includes(asset.assetId)) refs.push({ where: "renderJob", id: j.renderJobId, detail: "inputAssets" });
      for (const c of (p.bible?.characters || [])) if ((c.referenceImages || []).includes(asset.assetId)) refs.push({ where: "characterBible", id: c.stableId || c.characterId });
      for (const l of (p.bible?.locations || [])) if ((l.referenceImages || []).includes(asset.assetId)) refs.push({ where: "locationBible", id: l.stableId || l.locationId });
      if (refs.length) {
        return { ok: false, code: "asset_referenced", assetId: asset.assetId, references: refs, hint: "被引用资产不可直接删除；请先解除引用或将操作改为 Trash（标记移除，可恢复）" };
      }
      if (b.trash === true) {
        asset.trashedAt = Date.now();
        p.trash = p.trash || [];
        p.trash.push({ assetId: asset.assetId, trashedAt: Date.now(), path: asset.path, reason: b.reason || "" });
        p.assets = (p.assets || []).filter((a) => a.assetId !== asset.assetId);
        saveProject(p);
        return { ok: true, trashed: true, assetId: asset.assetId };
      }
      return { ok: false, code: "confirm_required", hint: "删除会移入 Trash（可恢复）；请传 trash:true 确认；永久删除需先移入 Trash" };
    },

    /* ---- 参考素材上传 ---- */
    "/asset_upload_status": (b) => {
      return { ok: true, status: uploader.status(String(b.assetId)) };
    },

    "/prepare_reference_upload": (b) => {
      const p = loadProject(String(b.projectId));
      const asset = findAsset(p, String(b.assetId));
      const localPath = path.join(store.assetsDir(p.projectId), asset.path || "");
      return uploader.prepareReference({
        assetId: asset.assetId,
        localPath,
        kind: b.kind,
        role: b.role,
        remoteUrl: b.remoteUrl,
        expiresAt: b.expiresAt,
      }).then((r) => ({ ok: true, ...r }));
    },
  };
}
