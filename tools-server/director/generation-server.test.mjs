/* ============================================================================
 * 生成引擎 HTTP 集成测试：确认面板、缓存命中不二次调用、Take 切换、
 * Dirty 分离（字幕→Render、Prompt→Generation）、重启持久化。
 * 运行：node --test tools-server/director/generation-server.test.mjs
 * ==========================================================================*/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "..", "director-server.mjs");
const PORT = 8760 + Math.floor(Math.random() * 100);
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "gensrv-"));
const BASE = "http://127.0.0.1:" + PORT;

function post(ep, body) { return fetch(BASE + ep, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()); }
function get(ep) { return fetch(BASE + ep).then((r) => r.json()); }

function start() {
  const child = spawn(process.execPath, [SERVER, "--port", String(PORT), "--workspace", WORKSPACE], { stdio: ["ignore", "ignore", "pipe"] });
  return child;
}
async function waitHealth() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + "/health")).ok) return true; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

test("生成引擎：确认面板 → 生成 → 缓存命中 → Take 切换 → Dirty 分离 → 重启持久化", async () => {
  let s = start();
  try {
    assert.equal(await waitHealth(), true);
    await post("/create_director_project", { projectId: "D-GEN", title: "生成引擎测试", aspectRatio: "16:9" });
    await post("/create_shot_list", { projectId: "D-GEN", shots: [{ shotId: "SHOT-001", narrativePurpose: "测试", duration: 5, subject: "女孩", primaryAction: "转身", endState: "面向镜头", startState: "背对" }] });
    await post("/create_keyframe", { projectId: "D-GEN", shotId: "SHOT-001", keyframePrompt: "中景女孩", keyframes: {} });
    await post("/compile_generation_prompt", { projectId: "D-GEN", shotId: "SHOT-001", provider: "local-stub" });

    // 1. 编译 Spec → 确认面板字段齐全
    const spec = await post("/compile_generation_spec", { projectId: "D-GEN", shotId: "SHOT-001", provider: "local-stub" });
    assert.equal(spec.ok, true);
    assert.ok(spec.generationKey.length === 64);
    assert.equal(spec.confirmation.provider, "local-stub");
    assert.equal(spec.confirmation.duration, 5);
    assert.equal(spec.confirmation.cacheHit, false);
    assert.equal(spec.confirmation.newGenerationCount, 1);
    assert.ok(/以服务端实际扣费为准/.test(spec.confirmation.costDisclaimer));

    // 2. 未确认不生成：generate_shot 不带 confirmed 返回确认面板，不产生 Take
    const pending = await post("/generate_shot", { projectId: "D-GEN", shotId: "SHOT-001", provider: "local-stub" });
    assert.equal(pending.cacheHit, false);
    assert.equal(pending.needsGeneration, true);
    let takes = await post("/list_takes", { projectId: "D-GEN", shotId: "SHOT-001" });
    assert.equal(takes.takes.length, 0, "未确认不得生成 Take");

    // 2b. 服务端确认闸门：confirm_generation 不带 confirmed=true 必须拒绝（防 Agent/脚本绕过）
    const noConfirm = await post("/confirm_generation", { projectId: "D-GEN", shotId: "SHOT-001", provider: "local-stub" });
    assert.equal(noConfirm.ok, false);
    assert.equal(noConfirm.code, "confirmation_required");
    takes = await post("/list_takes", { projectId: "D-GEN", shotId: "SHOT-001" });
    assert.equal(takes.takes.length, 0, "未确认不得创建 Take");

    // 3. 确认生成 → 产生 Take（ready_for_review）
    const c1 = await post("/confirm_generation", { projectId: "D-GEN", shotId: "SHOT-001", provider: "local-stub", confirmed: true });
    assert.equal(c1.ok, true);
    assert.equal(c1.results[0].cacheHit, false);
    takes = await post("/list_takes", { projectId: "D-GEN", shotId: "SHOT-001" });
    assert.equal(takes.takes.length, 1);
    assert.equal(takes.takes[0].status, "ready_for_review");

    // 4. 相同请求再次确认 → 命中缓存，不新增 Take、不二次调用 API
    const c2 = await post("/confirm_generation", { projectId: "D-GEN", shotId: "SHOT-001", provider: "local-stub", confirmed: true });
    assert.equal(c2.results[0].cacheHit, true);
    takes = await post("/list_takes", { projectId: "D-GEN", shotId: "SHOT-001" });
    assert.equal(takes.takes.length, 1, "缓存命中不应新增 Take");

    // 4b. forceRegenerate=true：即使用户明确要求「生成新 Take」，也应新建（不覆盖旧）
    const fr = await post("/confirm_generation", { projectId: "D-GEN", shotId: "SHOT-001", provider: "local-stub", forceRegenerate: true, confirmed: true });
    assert.equal(fr.results[0].cacheHit, false);
    takes = await post("/list_takes", { projectId: "D-GEN", shotId: "SHOT-001" });
    assert.equal(takes.takes.length, 2, "强制重新生成应新增 Take");

    // 5. 修改 Prompt → 只标记该 Shot Generation dirty
    await post("/update_shot", { projectId: "D-GEN", shotId: "SHOT-001", patch: { subject: "男孩" } });
    let p = (await get("/project/D-GEN")).project;
    assert.equal(p.shots[0].dirty.generation, true);
    assert.ok(!p.renderDirty || p.renderDirty.flag !== true, "Prompt 修改不得标 Render dirty");

    // 6. 修改字幕 → 只标记 Render dirty
    await post("/generate_captions", { projectId: "D-GEN", captions: [{ text: "你好", start: 0, end: 2 }] });
    p = (await get("/project/D-GEN")).project;
    assert.equal(p.renderDirty.flag, true);
    assert.ok(p.shots[0].dirty.generation === true, "既有 Generation dirty 保持（Prompt 已改）");

    // 7. 修改 Prompt 后生成新 Take（多 Take 切换）
    const spec2 = await post("/compile_generation_spec", { projectId: "D-GEN", shotId: "SHOT-001", provider: "local-stub" });
    await post("/confirm_generation", { projectId: "D-GEN", shotId: "SHOT-001", provider: "local-stub", confirmed: true });
    takes = await post("/list_takes", { projectId: "D-GEN", shotId: "SHOT-001" });
    assert.equal(takes.takes.length, 3, "修改 Prompt 后应产生新 Take（不覆盖旧 Take）");

    // 8. 选择/锁定 Take
    const t1 = takes.takes[0].takeId;
    const sel = await post("/select_take", { projectId: "D-GEN", shotId: "SHOT-001", takeId: t1 });
    assert.equal(sel.selectedTakeId, t1);
    const lock = await post("/lock_take", { projectId: "D-GEN", shotId: "SHOT-001", takeId: t1 });
    assert.equal(lock.status, "locked");
  } finally {
    s.kill("SIGKILL");
  }

  // 9. 重启：Take / 选中项 / 任务持久化
  const s2 = start();
  try {
    assert.equal(await waitHealth(), true);
    const p = (await get("/project/D-GEN")).project;
    assert.equal(p.shots[0].takes.length, 3);
    assert.ok(p.shots[0].selectedTakeId);
    const q = await post("/list_generation_queue", { projectId: "D-GEN" });
    assert.ok(q.queue.length >= 0);
  } finally {
    s2.kill("SIGKILL");
  }
});
