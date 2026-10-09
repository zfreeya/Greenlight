/* ============================================================================
 * 发布阻断项专项测试（可靠性 / 并发 / 失败关闭 / 能力校验）
 * 覆盖：
 *   1. 未知 Provider 失败关闭（不静默回退 local-stub）
 *   2. 能力校验：不支持的模型/分辨率/时长在 API 调用前被拒绝（真实 worker 校验 RPC）
 *   3. 两个独立数据库连接并发提交同一 generation key 只产生一个任务（唯一约束）
 *   4. 项目 JSON 乐观锁：过期写入被拒绝；加载最新→变更→保存可成功
 *   5. legacy submit_video_generation 与新引擎共享同一缓存
 * 运行：node --test tools-server/director/reliability.test.mjs
 * ==========================================================================*/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import * as GEN from "./generation.mjs";
import { DirectorStore } from "./store.mjs";
import { newProject } from "./types.mjs";
import { getProvider } from "./providers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REAL_WORKER = path.join(__dirname, "seedance", "worker.py");
const VENV_PY = path.join(process.cwd(), ".venv", "bin", "python");
const PY = fs.existsSync(VENV_PY) ? VENV_PY : "python3";

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), "rel-test-")); }

/** 与 worker 交互的极简 RPC（只读校验，不创建远程任务） */
function workerRpc(method, params) {
  const input = JSON.stringify({ id: 1, method, params }) + "\n";
  const r = spawnSync(PY, [REAL_WORKER], { input, encoding: "utf8", timeout: 30000 });
  assert.equal(r.status, 0, "worker 应正常退出（stderr=" + (r.stderr || "").slice(0, 300) + " cwd=" + process.cwd() + " py=" + PY + " exists=" + fs.existsSync(PY) + ")");
  const lines = (r.stdout || "").trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

/* ---- 1. 未知 Provider 失败关闭 ---- */
test("provider: 未知 Provider 抛错，不静默回退 local-stub", () => {
  assert.throws(() => getProvider("seedance-broken-typo"), /未知 Provider/);
  assert.throws(() => getProvider("seedance"), /未知 Provider/, "seedance 不在 providers.mjs 注册表，必须走 resolveProvider");
  const stub = getProvider("local-stub");
  assert.ok(stub, "local-stub 仍可显式选择");
});

/* ---- 2. 能力校验（真实 worker，纯 Python，无需 SDK） ---- */
test("capability: 不支持的参数在创建任务前被拒绝（真实 worker 校验 RPC）", () => {
  // 未知模型 → 阻断
  const r1 = workerRpc("validate_generation_request", { spec: { model: "unknown-video-model", resolution: "1080p", duration: 5, ratio: "16:9" } });
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.some((e) => e.param === "model"), "应指出 model 参数问题");
  assert.ok(JSON.stringify(r1.errors).includes("未收录"), "应说明模型未收录并给出支持的族");

  // 不支持的分辨率 → 阻断
  const r2 = workerRpc("validate_generation_request", { spec: { model: "doubao-seedance-1-0-pro-250528", resolution: "8k", duration: 5, ratio: "16:9" } });
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some((e) => e.param === "resolution"), "应指出 resolution 不支持");
  assert.ok(JSON.stringify(r2.errors).includes("480p"), "应给出支持的分辨率");

  // 超时长 → 阻断
  const r3 = workerRpc("validate_generation_request", { spec: { model: "doubao-seedance-1-0-pro-250528", resolution: "1080p", duration: 60, ratio: "16:9" } });
  assert.equal(r3.ok, false);
  assert.ok(r3.errors.some((e) => e.param === "duration"), "应指出 duration 超范围");

  // 合法参数 → 通过
  const r4 = workerRpc("validate_generation_request", { spec: { model: "doubao-seedance-1-0-pro-250528", resolution: "1080p", duration: 5, ratio: "16:9", generate_audio: false, watermark: true, return_last_frame: false } });
  assert.equal(r4.ok, true, "合法参数应通过校验");
  assert.ok(r4.capabilities && r4.capabilities.family, "应返回模型族能力");
});

test("capability: create_task 在 SDK 已装时仍先校验（防御纵深，非法参数不发请求）", () => {
  const r = workerRpc("create_task", { spec: { model: "doubao-seedance-1-0-pro-250528", resolution: "8k", duration: 5, ratio: "16:9" } });
  if (r.error && /SDK|未安装/.test(String(r.error || ""))) return; // SDK 缺失时短路，无法验证（环境相关）
  assert.equal(r.ok, false);
  assert.equal(r.error_kind, "validation");
  assert.ok(r.validation && r.validation.errors.length >= 1, "应返回校验错误");
});

/* ---- 3. 两个独立数据库连接并发提交同一 key ---- */
test("concurrency: 两个数据库连接同一 generation key 只产生一个任务", () => {
  const file = path.join(tmpdir(), "generation.db");
  const key = GEN.standardizeGenerationSpec({ provider: "seedance", model: "m", prompt: "x" }).key;
  const a = new GEN.GenerationEngine(file);
  const b = new GEN.GenerationEngine(file); // 独立连接（模拟两个进程/窗口）
  const r1 = a.createTask({ taskId: "GEN-A", projectId: "D", shotId: "S", takeId: "TA", generationKey: key, provider: "seedance", model: "m" });
  assert.equal(r1.created, true);
  // 第二个连接：应用层去重 → 复用
  const r2 = b.createTask({ taskId: "GEN-B", projectId: "D", shotId: "S", takeId: "TB", generationKey: key, provider: "seedance", model: "m" });
  assert.equal(r2.created, false);
  assert.equal(r2.reused, true);
  assert.equal(r2.task.task_id, "GEN-A");
  // 数据库级唯一约束：绕过 SELECT 直接插入同 key 非终态行必须失败
  assert.throws(() => b.db.prepare(`
    INSERT INTO generation_tasks (task_id, project_id, shot_id, take_id, generation_key, provider, model, billing_mode, base_url, status, retries, download_attempts, last_poll_at, error, error_kind, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '', '', 'queued', 0, 0, 0, NULL, NULL, 1, 1)
  `).run("GEN-C", "D", "S", "TC", key, "seedance", "m"), /UNIQUE|unique/i, "非终态同 key 唯一索引应阻止重复任务");
  a.close(); b.close();
});

test("concurrency: 完成态任务不阻塞显式重新生成（forceRegenerate）", () => {
  const file = path.join(tmpdir(), "generation.db");
  const key = GEN.standardizeGenerationSpec({ provider: "seedance", model: "m", prompt: "x" }).key;
  const a = new GEN.GenerationEngine(file);
  a.createTask({ taskId: "GEN-1", projectId: "D", shotId: "S", takeId: "T1", generationKey: key, provider: "seedance", model: "m" });
  a.updateTask("GEN-1", { status: "awaiting_approval" });
  a.updateTask("GEN-1", { status: "queued" });
  a.updateTask("GEN-1", { status: "generating" });
  a.updateTask("GEN-1", { status: "succeeded" });
  a.updateTask("GEN-1", { status: "downloading" }, { force: true });
  a.updateTask("GEN-1", { status: "ready_for_review" }, { force: true });
  // 已完成（ready_for_review）后 force regenerate：允许创建新任务
  const r = a.createTask({ taskId: "GEN-2", projectId: "D", shotId: "S", takeId: "T2", generationKey: key, provider: "seedance", model: "m" });
  assert.equal(r.created, true, "终态任务不应阻止新任务");
  assert.equal(a.listTasks("D").length, 2);
  a.close();
});

/* ---- 4. 项目 JSON 乐观锁 ---- */
test("store: 过期写入被拒绝；最新快照写入成功（防旧快照覆盖新 Take/Asset）", () => {
  const dir = path.join(tmpdir(), "director");
  const store = new DirectorStore(dir);
  const p = { ...newProject({ projectId: "D-LOCK" }), _rev: undefined };
  store.createProject(p); // rev 1
  const p2 = store.loadProject("D-LOCK");
  assert.equal(p2._rev, 1);
  p2.shots = [{ shotId: "SHOT-001" }];
  store.saveProject(p2); // rev 2
  // p（rev 1 的旧快照）现在过期 → 必须拒绝
  p.shots = [{ shotId: "SHOT-OLD" }];
  assert.throws(() => store.saveProject(p), (e) => e.code === "concurrency", "过期写入应被乐观锁拒绝");
  // 以最新快照重新应用变更 → 成功，且不丢 p2 的 Take/Asset
  const p3 = store.loadProject("D-LOCK");
  assert.equal(p3.shots.length, 1);
  p3.assets = [...(p3.assets || []), { assetId: "AST-1" }];
  store.saveProject(p3); // rev 3
  const final = store.loadProject("D-LOCK");
  assert.equal(final._rev, 3);
  assert.ok(final.assets.some((a) => a.assetId === "AST-1"), "新写入不应丢失资产");
});

/* ---- 5. legacy 与新引擎共享缓存（服务端集成） ---- */
import { spawn } from "node:child_process";
const SERVER = path.join(__dirname, "..", "director-server.mjs");
const PORT = 8860 + Math.floor(Math.random() * 60);
const WORKSPACE = tmpdir();
const BASE = "http://127.0.0.1:" + PORT;
const post = (ep, body) => fetch(BASE + ep, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const get = (ep) => fetch(BASE + ep).then((r) => r.json());

test("cache: legacy submit_video_generation 与新引擎 confirm_generation 共享同一缓存", async () => {
  const child = spawn(process.execPath, [SERVER, "--port", String(PORT), "--workspace", WORKSPACE], { stdio: ["ignore", "ignore", "pipe"] });
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + "/health")).ok) break; } catch {} await new Promise((r) => setTimeout(r, 150)); }
    await post("/create_director_project", { projectId: "D-SHARE", title: "共享缓存", aspectRatio: "16:9" });
    await post("/create_shot_list", { projectId: "D-SHARE", shots: [{ shotId: "SHOT-001", duration: 5, subject: "A", narrativePurpose: "t" }] });
    await post("/create_keyframe", { projectId: "D-SHARE", shotId: "SHOT-001", keyframePrompt: "测试" });
    // 1) legacy 入口生成 → 记录缓存
    const sub = await post("/submit_video_generation", { projectId: "D-SHARE", shotId: "SHOT-001", provider: "local-stub" });
    assert.equal(sub.ok, true);
    assert.equal(sub.cacheHit, false);
    // 2) 新引擎入口（compile+confirm）同 Spec → 命中同一缓存，不二次生成
    const spec = await post("/compile_generation_spec", { projectId: "D-SHARE", shotId: "SHOT-001", provider: "local-stub" });
    assert.equal(spec.cacheHit, true, "legacy 生成后新引擎应命中缓存");
    const confirm = await post("/confirm_generation", { projectId: "D-SHARE", shotId: "SHOT-001", provider: "local-stub", confirmed: true });
    assert.equal(confirm.results[0].cacheHit, true);
    const takes = await post("/list_takes", { projectId: "D-SHARE", shotId: "SHOT-001" });
    assert.equal(takes.takes.length, 1, "缓存命中不应新增 Take");
  } finally {
    child.kill("SIGKILL");
  }
});
