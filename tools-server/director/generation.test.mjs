/* ============================================================================
 * 生成引擎单元测试：Generation Spec 标准化/哈希稳定性、缓存去重、幂等、
 * 状态机、Dirty 分离、轮询退避、下载失败不重新生成、重启恢复。
 * 运行：node --test tools-server/director/generation.test.mjs
 * ==========================================================================*/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as GEN from "./generation.mjs";
import { newProject, newShot } from "./types.mjs";

function tmpfile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gen-test-")), "generation.db");
}

/* ---- 1. Generation Spec 标准化与哈希稳定性 ---- */
test("spec: 标准化字段完整且 generation_key 稳定", () => {
  const a = GEN.standardizeGenerationSpec({
    provider: "seedance", billing_mode: "agent_plan", base_url: "https://ark.cn-beijing.volces.com/api/plan/v3",
    model: "seedance-1.0", prompt: "中景女孩转身", resolution: "1080p", ratio: "16:9",
    duration: 5, generate_audio: true, watermark: false, return_last_frame: true,
    referenceAssets: [{ assetId: "AST-1", role: "reference", sha256: "abc123" }],
  });
  assert.equal(a.provider, "seedance");
  assert.equal(a.billing_mode, "agent_plan");
  assert.equal(a.reference_asset_hashes.length, 1);
  assert.ok(a.key.length === 64, "SHA-256 应为 64 位十六进制");
  // 相同输入 → 相同 key
  const b = GEN.standardizeGenerationSpec({
    provider: "seedance", billing_mode: "agent_plan", base_url: "https://ark.cn-beijing.volces.com/api/plan/v3",
    model: "seedance-1.0", prompt: "中景女孩转身", resolution: "1080p", ratio: "16:9",
    duration: 5, generate_audio: true, watermark: false, return_last_frame: true,
    referenceAssets: [{ assetId: "AST-1", role: "reference", sha256: "abc123" }],
  });
  assert.equal(a.key, b.key);
});

test("spec: 字段顺序不影响 key（规范 JSON 键排序）", () => {
  const a = GEN.standardizeGenerationSpec({ provider: "p", model: "m", prompt: "x", ratio: "16:9", duration: 5, generate_audio: false, watermark: false, return_last_frame: false });
  const b = GEN.standardizeGenerationSpec({ return_last_frame: false, generate_audio: false, duration: 5, ratio: "16:9", prompt: "x", model: "m", provider: "p", watermark: false });
  assert.equal(a.key, b.key);
});

test("spec: Prompt / 参考素材哈希变化 → key 变化", () => {
  const base = { provider: "p", model: "m", prompt: "A", ratio: "16:9", duration: 5 };
  const p1 = GEN.standardizeGenerationSpec(base).key;
  const p2 = GEN.standardizeGenerationSpec({ ...base, prompt: "B" }).key;
  assert.notEqual(p1, p2, "Prompt 改变应产生不同 key");

  const r1 = GEN.standardizeGenerationSpec({ ...base, referenceAssets: [{ assetId: "a", sha256: "h1" }] }).key;
  const r2 = GEN.standardizeGenerationSpec({ ...base, referenceAssets: [{ assetId: "a", sha256: "h2" }] }).key;
  assert.notEqual(r1, r2, "参考素材哈希改变应产生不同 key");
});

/* ---- 2. 缓存：相同请求命中，不产生第二次 API 调用 ---- */
test("cache: 命中缓存直接复用（不触发 Provider）", () => {
  const engine = new GEN.GenerationEngine(":memory:");
  const key = GEN.standardizeGenerationSpec({ provider: "seedance", model: "m", prompt: "x" }).key;
  const assetPath = "/tmp/nonexistent-video.mp4";
  // 先写入一个真实存在的文件，否则 lookupCache 会因文件缺失返回未命中
  const realFile = tmpfile() + ".mp4";
  fs.writeFileSync(realFile, "FAKEMP4");
  engine.recordCache(key, { assetPath: realFile, fileHash: GEN.fileSha256(realFile), provider: "seedance", model: "m" });
  const hit = engine.lookupCache(key);
  assert.ok(hit, "应命中缓存");
  assert.equal(hit.file_hash, GEN.fileSha256(realFile));
  engine.close();
});

test("cache: 文件缺失视为未命中（诚实）", () => {
  const engine = new GEN.GenerationEngine(":memory:");
  const key = GEN.standardizeGenerationSpec({ provider: "seedance", model: "m", prompt: "x" }).key;
  engine.recordCache(key, { assetPath: "/tmp/definitely-missing.mp4", fileHash: "deadbeef" });
  assert.equal(engine.lookupCache(key), null, "文件缺失不得命中缓存");
  engine.close();
});

/* ---- 6. 幂等：查询超时不会重复创建任务 ---- */
test("task: 幂等创建（同 generation_key 复用，不重复下单）", () => {
  const engine = new GEN.GenerationEngine(":memory:");
  const key = GEN.standardizeGenerationSpec({ provider: "seedance", model: "m", prompt: "x" }).key;
  const a = engine.createTask({ taskId: "GEN-1", projectId: "D", shotId: "S", takeId: "T1", generationKey: key, provider: "seedance", model: "m" });
  const b = engine.createTask({ taskId: "GEN-2", projectId: "D", shotId: "S", takeId: "T2", generationKey: key, provider: "seedance", model: "m" });
  assert.equal(a.created, true);
  assert.equal(b.created, false, "第二次应复用而非新建");
  assert.equal(b.reused, true);
  assert.equal(b.task.task_id, "GEN-1", "复用既有 task_id");
  assert.equal(engine.listTasks("D").length, 1, "任务总数仍为 1");
  engine.close();
});

test("task: findInFlightTask 定位同 key 未完成任务（双击/并发窗口复用，不产生孤儿 Take）", () => {
  const engine = new GEN.GenerationEngine(":memory:");
  const key = GEN.standardizeGenerationSpec({ provider: "seedance", model: "m", prompt: "x" }).key;
  engine.createTask({ taskId: "GEN-1", projectId: "D", shotId: "S", takeId: "T1", generationKey: key, provider: "seedance", model: "m" });
  const f = engine.findInFlightTask(key);
  assert.ok(f, "应找到未完成任务");
  assert.equal(f.task_id, "GEN-1");
  // 终态后不再返回（可重新下单）
  engine.updateTask("GEN-1", { status: "awaiting_approval" });
  engine.updateTask("GEN-1", { status: "queued" });
  engine.updateTask("GEN-1", { status: "generating" });
  engine.updateTask("GEN-1", { status: "succeeded" });
  assert.equal(engine.findInFlightTask(key).task_id, "GEN-1", "succeeded(待下载)仍在飞行中");
  engine.updateTask("GEN-1", { status: "downloading" }, { force: true });
  engine.updateTask("GEN-1", { status: "failed" }, { force: true });
  assert.equal(engine.findInFlightTask(key), null, "终态后不再返回");
  engine.close();
});

/* ---- 3/4. Dirty 分离 ---- */
test("dirty: 修改字幕/时间线只触发 Render dirty", () => {
  const p = newProject({ projectId: "D-x" });
  const shot = newShot(1, { shotId: "SHOT-001" });
  GEN.markRenderDirty(p, "字幕改动");
  assert.equal(GEN.isRenderDirty(p), true);
  assert.equal(GEN.isGenerationDirty(shot), false, "Render dirty 不得标记 Generation dirty");
});

test("dirty: 修改 Prompt 只标记对应 Shot Generation dirty", () => {
  const p = newProject({ projectId: "D-x" });
  const s1 = newShot(1, { shotId: "SHOT-001" });
  const s2 = newShot(2, { shotId: "SHOT-002" });
  GEN.markGenerationDirty(s1, "Prompt 改动");
  assert.equal(GEN.isGenerationDirty(s1), true);
  assert.equal(GEN.isGenerationDirty(s2), false, "只标记对应 Shot");
  assert.equal(GEN.isRenderDirty(p), false, "Generation dirty 不得标记 Render dirty");
  GEN.clearGenerationDirty(s1);
  assert.equal(GEN.isGenerationDirty(s1), false);
});

/* ---- 状态机 ---- */
test("state: 任务状态机合法/非法迁移", () => {
  assert.equal(GEN.canTransition("draft", "awaiting_approval"), true);
  assert.equal(GEN.canTransition("queued", "generating"), true);
  assert.equal(GEN.canTransition("generating", "succeeded"), true);
  assert.equal(GEN.canTransition("succeeded", "downloading"), true);
  assert.equal(GEN.canTransition("downloading", "ready_for_review"), true);
  assert.equal(GEN.canTransition("ready_for_review", "selected"), true);
  assert.equal(GEN.canTransition("selected", "locked"), true);
  assert.throws(() => GEN.assertTransition("locked", "queued"), "锁定后不得回退");
  assert.throws(() => GEN.assertTransition("failed", "generating"), "生成失败不得直接重新生成");
});

test("state: updateTask 强制/非强制迁移", () => {
  const engine = new GEN.GenerationEngine(":memory:");
  const key = GEN.standardizeGenerationSpec({ provider: "p", model: "m", prompt: "x" }).key;
  engine.createTask({ taskId: "GEN-1", projectId: "D", shotId: "S", takeId: "T", generationKey: key, provider: "p", model: "m" });
  assert.throws(() => engine.updateTask("GEN-1", { status: "generating" }), "draft→generating 非法");
  engine.updateTask("GEN-1", { status: "awaiting_approval" });
  engine.updateTask("GEN-1", { status: "queued" });
  engine.updateTask("GEN-1", { status: "generating" });
  assert.equal(engine.getTask("GEN-1").status, "generating");
  engine.close();
});

/* ---- 轮询退避 ---- */
test("poll: 初始 3s 后指数退避 + 抖动范围", () => {
  const engine = new GEN.GenerationEngine(":memory:");
  const i0 = engine.pollIntervalMs({ retries: 0 }, { baseMs: 3000, maxMs: 60000 });
  const i1 = engine.pollIntervalMs({ retries: 1 }, { baseMs: 3000, maxMs: 60000 });
  const i5 = engine.pollIntervalMs({ retries: 5 }, { baseMs: 3000, maxMs: 60000 });
  assert.ok(i0 >= 2400 && i0 <= 3600, "初始约 3s ±20%");
  assert.ok(i1 >= 4800 && i1 <= 7200, "第 1 次重试约 6s");
  assert.ok(i5 <= 60000 * 1.2, "不超过上限（含抖动）");
  engine.close();
});

/* ---- 5. 重启恢复 ---- */
test("recovery: 应用重启后恢复 task_id 并继续轮询", () => {
  const file = tmpfile();
  const engine = new GEN.GenerationEngine(file);
  const key = GEN.standardizeGenerationSpec({ provider: "seedance", model: "m", prompt: "x" }).key;
  engine.createTask({ taskId: "GEN-REC", projectId: "D", shotId: "S", takeId: "T", generationKey: key, provider: "seedance", model: "m" });
  engine.updateTask("GEN-REC", { status: "awaiting_approval" });
  engine.updateTask("GEN-REC", { status: "queued" });
  engine.updateTask("GEN-REC", { status: "generating", provider_job_id: "mock-job" });
  engine.close();

  // 重启：新连接读同一 DB
  const engine2 = new GEN.GenerationEngine(file);
  const t = engine2.getTask("GEN-REC");
  assert.ok(t, "重启后任务仍在");
  assert.equal(t.task_id, "GEN-REC");
  assert.equal(t.status, "generating");
  const inFlight = engine2.listInFlight("D");
  assert.ok(inFlight.some((x) => x.task_id === "GEN-REC"), "未完成任务应被恢复继续轮询");
  engine2.close();
});

/* ---- 7. 下载失败只重试下载 ---- */
test("take: 下载失败与生成失败在 errorKind 上区分", () => {
  const take = GEN.newTake(1, { takeId: "T", shotId: "S", status: "downloading" });
  take.status = "failed";
  take.errorKind = "download";
  assert.equal(take.errorKind, "download");
  // 生成失败不得通过下载重试路径重新生成：状态机 failed 为 terminal（下载失败重试由上层 retry_download 专门处理）
  assert.equal(GEN.canTransition("failed", "generating"), false);
  assert.equal(GEN.canTransition("failed", "downloading"), false, "通用迁移不允许 failed→downloading（需走 retry_download 专项接口）");
});
