/* ============================================================================
 * Harness Director — 服务组合根（createDirectorServer）
 *
 * 职责：组装依赖（store / engine / uploader / seedance）→ 构建共享上下文 ctx →
 * 装配域路由 → HTTP 服务（health / catalog / 项目 / 资产 / 导出静态 + POST 分发）→
 * 后台轮询循环（seedance 三段式：submit → poll → download）。
 *
 * 这是 director-server 模块化重构后的唯一入口；旧入口
 * tools-server/director-server.mjs 现在是它的薄 CLI 包装（行为不变）。
 * ==========================================================================*/
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

import * as T from "./types.mjs";
import { DirectorStore } from "./store.mjs";
import { GenerationEngine } from "./generation.mjs";
import { AssetUploader } from "./asset-upload.mjs";
import { SeedanceWorkerProvider, SEEDANCE_CHANNELS } from "./seedance/provider.mjs";
import { resolveApiKey } from "./keychain.mjs";
import { createDirectorContext } from "./server-context.mjs";
import createProjectRoutes from "./routes/project.mjs";
import createGenerationRoutes from "./routes/generation.mjs";
import createRenderRoutes from "./routes/render.mjs";
import createBusinessRoutes from "./routes/business.mjs";
import { toolCatalog } from "./tools.mjs";
import { ffmpegAvailable } from "./render.mjs";

const MIME = { ".html": "text/html; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".mp4": "video/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".md": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8", ".txt": "text/plain; charset=utf-8" };

/** HTTP Range 响应（WebKit/Safari 视频播放必需）。 */
function serveRange(res, req, buf, contentType) {
  const total = buf.length;
  const range = req.headers.range;
  const base = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range);
  if (m && (m[1] || m[2])) {
    let start = m[1] ? parseInt(m[1], 10) : null;
    let end = m[2] ? parseInt(m[2], 10) : null;
    if (start === null) {
      const n = end ?? 0;
      start = Math.max(0, total - n); end = total - 1;
    } else {
      if (end === null || end >= total) end = total - 1;
    }
    if (start > end || start >= total) {
      res.writeHead(416, { ...base, "Content-Range": "bytes */" + total });
      return res.end();
    }
    res.writeHead(206, { ...base, "Content-Type": contentType, "Content-Length": end - start + 1, "Content-Range": "bytes " + start + "-" + end + "/" + total, "Accept-Ranges": "bytes" });
    return res.end(buf.subarray(start, end + 1));
  }
  res.writeHead(200, { ...base, "Content-Type": contentType, "Content-Length": total, "Accept-Ranges": "bytes" });
  res.end(buf);
}

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(obj));
}

/**
 * 创建 Director 服务。
 * config: { workspace, port?, billingMode?, model?, workerPath?, apiKeyResolver? }
 * 返回 { ctx, routes, start(cb), stop() }。ctx.routes 在装配后挂载（供路由间互调）。
 */
export function createDirectorServer(config = {}) {
  const workspace = path.resolve(config.workspace || process.env.DSH_TOOLS_WORKSPACE || path.join(osHomedir(), "Harness"));
  const ROOT = path.join(workspace, "director");
  const store = new DirectorStore(ROOT);

  // 清理被杀进程遗留的导出临时文件（原子输出的 .tmp-*）
  try {
    for (const p of store.listProjects()) {
      const d = path.join(store.projectDir(p.projectId), "exports");
      if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) if (f.includes(".tmp-")) { try { fs.unlinkSync(path.join(d, f)); } catch { /* ignore */ } }
    }
  } catch { /* ignore */ }

  const engine = new GenerationEngine(path.join(ROOT, "generation.db"));
  const uploader = new AssetUploader({ dbFile: path.join(ROOT, "uploads.db") });
  const seedance = new SeedanceWorkerProvider({
    billingMode: config.billingMode || process.env.SEEDANCE_BILLING_MODE || "platform",
    model: config.model ?? process.env.SEEDANCE_MODEL ?? "",
    workerPath: config.workerPath !== undefined
      ? config.workerPath
      : (process.env.SEEDANCE_MOCK === "1" ? new URL("./seedance/mock_worker.py", import.meta.url).pathname : undefined),
  });

  const apiKeyInfo = config.apiKeyInfo || (() => {
    const k = resolveApiKey();
    if (k.source === "keychain" && k.key) process.env.ARK_API_KEY = k.key;
    return { source: k.source, hasKey: Boolean(k.key) };
  })();

  /* ---- 依赖注入：路径解析器（store 的目录语义集中在这里） ---- */
  const deps = {
    store, engine, uploader, seedance, apiKeyInfo,
    assetsDir: (pid) => store.assetsDir(pid),
    exportsDir: (pid) => store.exportsDir(pid),
    resolveAssetAbs: (pid, rel) => store.resolveAssetPath(pid, rel),
    relativeAssetsAbs: (pid, p) => path.relative(store.assetsDir(pid), p),
    assetsAbsJoin: (pid, ...parts) => path.join(store.assetsDir(pid), ...parts),
  };
  const ctx = createDirectorContext(deps);

  /* ---- 域路由装配 ---- */
  const routes = {
    ...createProjectRoutes(ctx),
    ...createGenerationRoutes(ctx),
    ...createRenderRoutes(ctx),
    ...createBusinessRoutes(ctx),
  };
  ctx.routes = routes; // 供 generate_shot / generate_selected_shots 互调

  /* ---- 目录列表与 Catalog ---- */
  async function catalog() {
    const providers = (await Promise.all([Promise.resolve(ctx.listProviders()), ctx.seedanceCaps()])).flat();
    return {
      ok: true,
      projectPhases: T.PROJECT_PHASES,
      phaseRequires: T.PHASE_REQUIRES,
      shotStates: T.SHOT_STATES,
      shotTransitions: T.SHOT_TRANSITIONS,
      taskStates: T.TASK_STATES,
      generationTaskStates: ctx.GEN.TASK_STATES,
      generationTransitions: ctx.GEN.TASK_TRANSITIONS,
      channels: SEEDANCE_CHANNELS,
      assetStates: T.ASSET_STATES,
      formats: T.PROJECT_FORMATS,
      platforms: T.PLATFORMS,
      aspectRatios: T.ASPECT_RATIOS,
      gates: ctx.GATES,
      gateForPhase: ctx.GATE_FOR_PHASE,
      skills: ctx.SKILLS,
      tools: toolCatalog(),
      providers: providers.filter((p) => p.name !== "ark" || p.available !== false),
      thirdParty: ctx.THIRD_PARTY_SOURCES,
      version: 2,
    };
  }

  /* ---- 后台轮询循环：恢复未完成任务 + 推进 seedance 三段式 ---- */
  let pollTimer = null;
  function startPollLoop() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      try {
        const projects = store.listProjects();
        for (const rec of projects) {
          const pid = rec.projectId;
          const p = ctx.loadProject(pid);
          if (!p) continue;
          const inFlight = engine.listInFlight(pid);
          for (const task of inFlight) {
            if (task.status === "queued") {
              const take = (p.shots || []).flatMap((s) => s.takes || []).find((t) => t.takeId === task.take_id);
              if (!take) continue;
              if (!ctx.isAsyncProvider(task.provider)) continue;
              const generatingCount = engine.listInFlight(pid).filter((t) => t.status === "generating").length;
              if (generatingCount >= ctx.concurrency(p)) continue;
              const sub = await ctx.submitSeedanceProvider(task, take);
              if (sub.ok) {
                engine.updateTask(task.task_id, { status: "generating", provider_job_id: sub.providerJobId });
                ctx.commitProject(pid, (fresh) => ctx.applyTakeState(fresh, task.shot_id, task.take_id, (s, t) => { t.status = "generating"; t.taskId = task.task_id; t.updatedAt = Date.now(); }));
              } else {
                engine.updateTask(task.task_id, { status: "failed", error: sub.error, error_kind: "generation" }, { force: true });
                ctx.commitProject(pid, (fresh) => ctx.applyTakeState(fresh, task.shot_id, task.take_id, (s, t) => { t.status = "failed"; t.error = sub.error; t.errorKind = "generation"; t.updatedAt = Date.now(); s.status = "qc_failed"; }));
              }
              continue;
            }
            if (task.status === "generating" && ctx.isAsyncProvider(task.provider)) {
              if (Date.now() - (task.last_poll_at || 0) < engine.pollIntervalMs(task)) continue;
              const take = (p.shots || []).flatMap((s) => s.takes || []).find((t) => t.takeId === task.take_id);
              if (!take) continue;
              const st = await ctx.pollSeedanceProvider(task, take);
              if (st.kind === "succeeded") {
                engine.updateTask(task.task_id, { status: "succeeded" });
                ctx.commitProject(pid, (fresh) => ctx.applyTakeState(fresh, task.shot_id, task.take_id, (s, t) => { t.status = "succeeded"; t.updatedAt = Date.now(); }));
              } else if (st.kind === "failed") {
                engine.updateTask(task.task_id, { status: "failed", error: st.error, error_kind: "generation" }, { force: true });
                ctx.commitProject(pid, (fresh) => ctx.applyTakeState(fresh, task.shot_id, task.take_id, (s, t) => { t.status = "failed"; t.error = st.error; t.errorKind = "generation"; t.updatedAt = Date.now(); s.status = "qc_failed"; }));
              }
              continue;
            }
            if (task.status === "succeeded" && ctx.isAsyncProvider(task.provider)) {
              const take = (p.shots || []).flatMap((s) => s.takes || []).find((t) => t.takeId === task.take_id);
              if (!take) continue;
              const dl = await ctx.downloadSeedanceProvider(task, take, pid);
              if (dl.kind === "downloaded") {
                ctx.commitProject(pid, (fresh) => {
                  const fshot = (fresh.shots || []).find((s) => s.shotId === task.shot_id);
                  const ftake = fshot?.takes?.find((t) => t.takeId === task.take_id);
                  if (fshot && ftake) ctx.finalizeTake(fresh, fshot, ftake, task, { path: dl.path, fileHash: dl.fileHash, bytes: dl.bytes, codec: dl.codec });
                });
              } else {
                ctx.commitProject(pid, (fresh) => {
                  const fshot = (fresh.shots || []).find((s) => s.shotId === task.shot_id);
                  const ftake = fshot?.takes?.find((t) => t.takeId === task.take_id);
                  if (fshot && ftake) ctx.failTake(fresh, fshot, ftake, task, "download", dl.error);
                });
              }
              continue;
            }
          }
        }
      } catch (e) {
        process.stderr.write("[director poll] " + String(e?.message ?? e) + "\n");
      }
    }, 3000);
  }

  /* ---- HTTP 服务 ---- */
  const server = http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST,GET,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }); res.end(); return; }
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const pathname = url.pathname;

    if (req.method === "GET" && pathname === "/health") return json(res, 200, { status: "ok", workspace, root: ROOT, ffmpeg: ffmpegAvailable(), pid: process.pid });
    if (req.method === "GET" && pathname === "/catalog") return json(res, 200, await catalog());
    if (req.method === "GET" && pathname === "/projects") return json(res, 200, { ok: true, projects: store.listProjects() });
    if (req.method === "GET" && pathname.startsWith("/project/")) {
      const pid = decodeURIComponent(pathname.slice("/project/".length));
      try { return json(res, 200, { ok: true, project: ctx.loadProject(pid) }); } catch (e) { return json(res, 200, { ok: false, error: String(e.message || e) }); }
    }
    if (req.method === "GET" && pathname.startsWith("/export/")) {
      const rest = decodeURIComponent(pathname.slice("/export/".length));
      const slash = rest.indexOf("/");
      if (slash < 0) return json(res, 404, { error: "缺少文件名" });
      const pid = rest.slice(0, slash);
      const file = rest.slice(slash + 1);
      if (!file || file !== path.basename(file) || file.includes("..")) return json(res, 404, { error: "非法文件名" });
      try {
        const abs = path.join(store.exportsDir(pid), file);
        if (!pathInside(abs, store.exportsDir(pid))) return json(res, 404, { error: "非法路径" });
        const buf = fs.readFileSync(abs);
        serveRange(res, req, buf, MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream");
      } catch { json(res, 404, { error: "导出文件不存在：" + file }); }
      return;
    }
    if (req.method === "GET" && pathname.startsWith("/asset/")) {
      const rest = decodeURIComponent(pathname.slice("/asset/".length));
      const slash = rest.indexOf("/");
      if (slash < 0) return json(res, 404, { error: "缺少资产路径" });
      const pid = rest.slice(0, slash);
      const rel = rest.slice(slash + 1);
      try {
        const abs = store.resolveAssetPath(pid, rel);
        const buf = fs.readFileSync(abs);
        serveRange(res, req, buf, MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream");
      } catch { json(res, 404, { error: "资产不存在：" + rel }); }
      return;
    }

    if (req.method === "POST" && routes[pathname]) {
      let raw = "";
      req.on("data", (c) => { raw += c; if (raw.length > 5_000_000) req.destroy(); });
      req.on("end", async () => {
        let body = {};
        try { body = JSON.parse(raw || "{}"); } catch { return json(res, 400, { error: "请求体不是合法 JSON" }); }
        try { return json(res, 200, await routes[pathname](body)); }
        catch (e) { return json(res, 200, { ok: false, code: "internal_error", error: String(e?.message ?? e) }); }
      });
      return;
    }
    json(res, 404, { error: "未知端点" });
  });

  return {
    ctx, routes,
    start(cb) {
      server.listen(config.port ?? 8456, "127.0.0.1", () => {
        console.log("[director-server] listening on http://127.0.0.1:" + (config.port ?? 8456) + " workspace=" + workspace);
        startPollLoop();
        if (cb) cb(server);
      });
      return server;
    },
    stop() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      server.close();
    },
  };
}

import os from "node:os";
function osHomedir() { return os.homedir(); }
function pathInside(target, base) {
  const t = path.resolve(target);
  const b = path.resolve(base);
  const r = path.relative(b, t);
  return !(r.startsWith("..") || path.isAbsolute(r));
}
