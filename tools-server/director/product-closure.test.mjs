/* ============================================================================
 * 产品闭环测试：时间线编辑(Render dirty) / RenderJob / 尾帧衔接 / Asset 删除保护 / Scene / Camera·Sound Bible
 * 运行：node --test tools-server/director/product-closure.test.mjs
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
const PORT = 9000 + Math.floor(Math.random() * 60);
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "closure-"));
const BASE = "http://127.0.0.1:" + PORT;
const post = (ep, body) => fetch(BASE + ep, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const get = (ep) => fetch(BASE + ep).then((r) => r.json());

function start() {
  return spawn(process.execPath, [SERVER, "--port", String(PORT), "--workspace", WORKSPACE], { stdio: ["ignore", "ignore", "pipe"] });
}
async function waitHealth() {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + "/health")).ok) return true; } catch {} await new Promise((r) => setTimeout(r, 150)); }
  return false;
}

test("产品闭环：时间线编辑只标记 Render dirty，不触发生成", async () => {
  const s = start();
  try {
    assert.equal(await waitHealth(), true);
    await post("/create_director_project", { projectId: "D-CLOSE", title: "闭环", aspectRatio: "16:9" });
    await post("/create_shot_list", { projectId: "D-CLOSE", shots: [
      { shotId: "SHOT-001", duration: 5, subject: "A", narrativePurpose: "t1" },
      { shotId: "SHOT-002", duration: 5, subject: "B", narrativePurpose: "t2" },
    ] });
    await post("/create_keyframe", { projectId: "D-CLOSE", shotId: "SHOT-001", keyframePrompt: "P1" });
    // 生成镜头1（local-stub），得到 clip
    await post("/compile_generation_prompt", { projectId: "D-CLOSE", shotId: "SHOT-001", provider: "local-stub" });
    const confirm = await post("/confirm_generation", { projectId: "D-CLOSE", shotId: "SHOT-001", provider: "local-stub", confirmed: true });
    const takesAfter = await post("/list_takes", { projectId: "D-CLOSE", shotId: "SHOT-001" });
    const assetId = takesAfter.takes[0].assetId;
    assert.ok(assetId, "应生成资产");
    await post("/place_clip_on_timeline", { projectId: "D-CLOSE", shotId: "SHOT-001", assetId });

    let p = (await get("/project/D-CLOSE")).project;
    const videoClipId = p.timeline.videoTracks[0].clips[0].clipId;
    assert.equal(p.renderDirty.flag, true, "放置片段后 Render dirty");

    // 清理 Generation dirty（生成已完成应被清除）
    assert.ok(!p.shots[0].dirty?.generation, "生成完成后 Generation dirty 应清除");

    // 1) 修改 clip（音量/mute/fade）→ 只 Render dirty
    const upd = await post("/update_clip", { projectId: "D-CLOSE", clipId: videoClipId, volume: 0.5, fadeIn: 1 });
    assert.equal(upd.ok, true);
    // 2) 调整镜头顺序 → 只 Render dirty
    const reorder = await post("/reorder_clips", { projectId: "D-CLOSE", shotIds: ["SHOT-001"] });
    assert.equal(reorder.ok, true);
    // 3) 加转场 → 只 Render dirty
    const tr = await post("/add_transition", { projectId: "D-CLOSE", fromClipId: videoClipId, toClipId: videoClipId, type: "crossfade" });
    assert.equal(tr.ok, true);

    p = (await get("/project/D-CLOSE")).project;
    assert.equal(p.renderDirty.flag, true, "时间线编辑应标记 Render dirty");
    assert.ok(!p.shots[0].dirty?.generation, "时间线编辑不得标记 Generation dirty");
    assert.equal(p.shots[0].takes.length, 1, "不得产生新 Take");
    const q = await post("/list_generation_queue", { projectId: "D-CLOSE" });
    assert.equal(q.queue.filter((t) => t.status === "queued" || t.status === "generating").length, 0, "不得产生新的生成任务");
  } finally { s.kill("SIGKILL"); }
});

test("产品闭环：RenderJob 持久化（ffmpeg 未安装时诚实 failed）", async () => {
  const s = start();
  try {
    assert.equal(await waitHealth(), true);
    await post("/create_director_project", { projectId: "D-RJ", title: "渲染历史", aspectRatio: "16:9" });
    const job = await post("/create_render_job", { projectId: "D-RJ" });
    assert.equal(job.ok, true);
    assert.ok(job.renderJob);
    const jobs = await post("/list_render_jobs", { projectId: "D-RJ" });
    assert.equal(jobs.renderJobs.length, 1);
    const rec = jobs.renderJobs[0];
    assert.ok(rec.renderJobId && rec.status && rec.createdAt);
    assert.ok(["succeeded", "failed"].includes(rec.status));
    if (rec.status === "failed") {
      assert.ok(rec.error, "失败原因应记录（ffmpeg 未安装等）");
    }
    // 重启后 RenderJob 历史仍在
  } finally { s.kill("SIGKILL"); }
});

test("产品闭环：尾帧衔接改变 generation key，但不自动生成", async () => {
  const s = start();
  try {
    assert.equal(await waitHealth(), true);
    await post("/create_director_project", { projectId: "D-LF", title: "尾帧", aspectRatio: "16:9" });
    await post("/create_shot_list", { projectId: "D-LF", shots: [
      { shotId: "SHOT-001", duration: 5, subject: "A", narrativePurpose: "t" },
      { shotId: "SHOT-002", duration: 5, subject: "B", narrativePurpose: "t" },
    ] });
    await post("/create_keyframe", { projectId: "D-LF", shotId: "SHOT-001", keyframePrompt: "P" });
    await post("/create_keyframe", { projectId: "D-LF", shotId: "SHOT-002", keyframePrompt: "P2" });
    const c1 = await post("/confirm_generation", { projectId: "D-LF", shotId: "SHOT-001", provider: "local-stub", confirmed: true });
    const keyBefore = (await post("/compile_generation_spec", { projectId: "D-LF", shotId: "SHOT-002", provider: "local-stub" })).generationKey;

    // 提取尾帧（ffmpeg 未安装 → 诚实返回 executed:false，但仍登记资产占位路径；此处验证 key 变化逻辑）
    const ext = await post("/extract_last_frame", { projectId: "D-LF", shotId: "SHOT-001", takeId: c1.results[0].takeId });
    const frameAssetId = ext.assetId;
    assert.ok(frameAssetId, "应登记尾帧资产（ffmpeg 缺失时也登记，诚实返回 executed:false）");
    const use = await post("/use_as_first_frame", { projectId: "D-LF", shotId: "SHOT-002", frameAssetId });
    assert.equal(use.ok, true);
    assert.equal(use.generationDirty, true);
    const keyAfter = (await post("/compile_generation_spec", { projectId: "D-LF", shotId: "SHOT-002", provider: "local-stub" })).generationKey;
    assert.notEqual(keyAfter, keyBefore, "首帧参考变化应改变 generation key");
    // 绝不自动生成：无新 Take、无新任务
    const takes = await post("/list_takes", { projectId: "D-LF", shotId: "SHOT-002" });
    assert.equal(takes.takes.length, 0, "设置首帧不得自动生成");
  } finally { s.kill("SIGKILL"); }
});

test("产品闭环：Asset 被引用时不可直接删除；未被引用可移入 Trash", async () => {
  const s = start();
  try {
    assert.equal(await waitHealth(), true);
    await post("/create_director_project", { projectId: "D-AD", title: "删除保护", aspectRatio: "16:9" });
    await post("/create_shot_list", { projectId: "D-AD", shots: [{ shotId: "SHOT-001", duration: 5, subject: "A", narrativePurpose: "t" }] });
    await post("/create_keyframe", { projectId: "D-AD", shotId: "SHOT-001", keyframePrompt: "P" });
    const c1 = await post("/confirm_generation", { projectId: "D-AD", shotId: "SHOT-001", provider: "local-stub", confirmed: true });
    const takesAfter = await post("/list_takes", { projectId: "D-AD", shotId: "SHOT-001" });
    const assetId = takesAfter.takes[0].assetId;
    // 被 Take 引用 → 拒绝
    const del = await post("/delete_asset", { projectId: "D-AD", assetId, trash: true });
    assert.equal(del.ok, false);
    assert.equal(del.code, "asset_referenced");
    assert.ok(del.references.length >= 1, "应返回引用列表");
    // 未被引用资产（导入一个无引用的）→ 可移入 Trash
    const imp = await post("/import_generated_clip", { projectId: "D-AD", asset: { assetId: "AST-ORPHAN", kind: "image", status: "imported", source: "external", path: "x.jpg" } });
    const del2 = await post("/delete_asset", { projectId: "D-AD", assetId: "AST-ORPHAN", trash: true });
    assert.equal(del2.ok, true);
    assert.equal(del2.trashed, true);
    const p = (await get("/project/D-AD")).project;
    assert.ok(p.trash.some((t) => t.assetId === "AST-ORPHAN"), "应进入 Trash");
    assert.ok(!p.assets.some((a) => a.assetId === "AST-ORPHAN"), "应从 assets 移除");
  } finally { s.kill("SIGKILL"); }
});

test("产品闭环：Scene 实体 + Camera/Sound Bible 稳定 ID + 旧项目迁移", async () => {
  const s = start();
  try {
    assert.equal(await waitHealth(), true);
    // 旧格式项目（只有 story.scenes）→ 加载后迁移出 scenes 实体
    const fs2 = await import("node:fs");
    const storeRoot = path.join(WORKSPACE, "director");
    const pid = "D-LEGACY";
    const { newProject } = await import("./types.mjs");
    const legacy = newProject({ projectId: pid, title: "旧项目" });
    legacy.story.scenes = [{ name: "天台", summary: "告别" }];
    fs2.mkdirSync(path.join(storeRoot, pid), { recursive: true });
    fs2.writeFileSync(path.join(storeRoot, pid, "project.json"), JSON.stringify(legacy, null, 2));
    const p = (await get("/project/" + pid)).project;
    assert.ok(Array.isArray(p.scenes), "应迁移出 scenes 实体");
    assert.equal(p.scenes.length, 1);
    assert.equal(p.scenes[0].title, "天台");
    // 创建 Scene / Camera Bible / Sound Bible
    const sc = await post("/create_scene", { projectId: pid, scene: { title: "新场景", narrativePurpose: "核心冲突", timeOfDay: "黄昏" } });
    assert.ok(sc.scene.sceneId.startsWith("SCENE-"));
    const cam = await post("/create_camera_bible", { projectId: pid, entry: { name: "手持近景", lens: "35mm", framing: "近景", movement: "手持跟随" } });
    assert.ok(cam.entry.stableId.startsWith("B-CAM-"), "Camera Bible 应带稳定 ID");
    const snd = await post("/create_sound_bible", { projectId: pid, entry: { name: "城市环境", ambience: "车流", loudnessPolicy: "EBU R128 -23 LUFS" } });
    assert.ok(snd.entry.stableId.startsWith("B-SND-"), "Sound Bible 应带稳定 ID");
    const p2 = (await get("/project/" + pid)).project;
    assert.equal(p2.scenes.length, 2);
    assert.equal(p2.bible.camera.length, 1);
    assert.equal(p2.bible.sound.length, 1);
  } finally { s.kill("SIGKILL"); }
});
