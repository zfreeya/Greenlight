/* ============================================================================
 * 反向工作流集成测试（O2-KR2）：从已有视频反推镜头表。
 * 覆盖：import_user_video（真实 mp4 导入）、sample_frames（按间隔抽帧）、
 * reverse_storyboard（返回素材信息但不写正式数据）、草稿确认后 create_shot_list
 * 写入、全程无付费调用；以及产品模板建产品角色卡（一致性锚点）。
 * 运行：node --test tools-server/director/reverse-workflow.test.mjs
 * ==========================================================================*/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { detectFfmpeg } from "./ffmpeg.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "..", "director-server.mjs");
const PORT = 8860 + Math.floor(Math.random() * 100);
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "revflow-"));
const BASE = "http://127.0.0.1:" + PORT;

function post(ep, body) { return fetch(BASE + ep, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()); }
function get(ep) { return fetch(BASE + ep).then((r) => r.json()); }

function start() {
  return spawn(process.execPath, [SERVER, "--port", String(PORT), "--workspace", WORKSPACE], { stdio: ["ignore", "ignore", "pipe"] });
}
async function waitHealth() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + "/health")).ok) return true; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

/** 用 ffmpeg 生成一段 6 秒真实 mp4（lavfi 纯色源），供导入测试。 */
function makeTestVideo() {
  const ff = detectFfmpeg();
  if (!ff.available) return null;
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "revvid-")), "sample.mp4");
  const r = spawnSync(ff.ffmpeg, ["-y", "-f", "lavfi", "-i", "color=c=red:s=320x240:d=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", out], { encoding: "utf8", timeout: 30000 });
  if (r.status !== 0) return null;
  return out;
}

test("反向工作流：导入 → 抽帧 → 反推 → 确认写入，全程无付费调用", async () => {
  const video = makeTestVideo();
  if (!video) { test.skip("ffmpeg 不可用，跳过（需真实视频文件）"); return; }
  let s = start();
  try {
    assert.equal(await waitHealth(), true);
    await post("/create_director_project", { projectId: "D-REV", title: "反向工作流测试", aspectRatio: "16:9" });

    // 1. 导入用户视频：资产存在、probe 信息正确、文件已复制进项目目录
    const imp = await post("/import_user_video", { projectId: "D-REV", path: video, title: "demo 素材" });
    assert.equal(imp.ok, true, JSON.stringify(imp));
    assert.equal(imp.duration, 6);
    assert.equal(imp.width, 320);
    assert.equal(imp.height, 240);
    const proj0 = await get("/project/" + encodeURIComponent("D-REV"));
    const asset = proj0.project.assets.find((a) => a.assetId === imp.assetId);
    assert.ok(asset, "导入后应有资产记录");
    assert.equal(asset.kind, "video_user");
    assert.equal(asset.source, "user_import");
    assert.ok(fs.existsSync(path.join(WORKSPACE, "director", "D-REV", "assets", asset.path)), "视频文件应复制进项目资产目录");

    // 2. 抽帧：数量在预期范围、文件存在、manifest 写入
    const frames = await post("/sample_frames", { projectId: "D-REV", assetId: imp.assetId, intervalSec: 2, maxFrames: 10 });
    assert.equal(frames.ok, true, JSON.stringify(frames));
    assert.ok(frames.count >= 1 && frames.count <= 4, "6 秒 / 2 秒间隔应抽 3~4 帧，实际 " + frames.count);
    const proj1 = await get("/project/" + encodeURIComponent("D-REV"));
    const a1 = proj1.project.assets.find((a) => a.assetId === imp.assetId);
    assert.ok(a1.manifest?.frames?.length >= 1, "manifest.frames 应已写入");
    const frameAbs = path.join(WORKSPACE, "director", "D-REV", "assets", a1.frameDir, a1.manifest.frames[0].file);
    assert.ok(fs.existsSync(frameAbs), "帧文件应真实存在");

    // 3. 反推：返回素材信息，但不写正式数据（shots 仍为空）
    const rev = await post("/reverse_storyboard", { projectId: "D-REV", assetId: imp.assetId });
    assert.equal(rev.ok, true);
    assert.ok(rev.frames.length >= 1);
    assert.equal(rev.duration, 6);
    const proj2 = await get("/project/" + encodeURIComponent("D-REV"));
    assert.equal(proj2.project.shots.length, 0, "反推不应写入正式镜头表");

    // 4. 草稿确认后写入：create_shot_list 正常创建，可进入生成
    const created = await post("/create_shot_list", { projectId: "D-REV", shots: [
      { shotId: "SHOT-001", narrativePurpose: "开场", duration: 3, shotSize: "全景", subject: "场景一", startState: "A", endState: "B" },
      { shotId: "SHOT-002", narrativePurpose: "中段", duration: 3, shotSize: "中景", subject: "场景二", startState: "B", endState: "C" },
    ] });
    assert.equal(created.ok, true);
    assert.equal(created.count, 2);

    // 5. 全程无付费调用：无任何生成任务被创建
    const queue = await post("/list_generation_queue", { projectId: "D-REV" });
    assert.equal(queue.queue.length, 0, "导入/抽帧/反推/建镜头不应创建任何生成任务");
  } finally {
    s.kill();
  }
});

test("产品模板：同时创建产品角色卡作为一致性锚点（07 保温杯单）", async () => {
  let s = start();
  try {
    assert.equal(await waitHealth(), true);
    await post("/create_director_project", { projectId: "D-TPL", title: "保温杯 15 秒" });
    const r = await post("/create_shot_list_from_template", { projectId: "D-TPL", template: "product_4shot", product: "便携保温杯" });
    assert.equal(r.ok, true);
    assert.equal(r.count, 4);
    assert.ok(r.productCharacterId, "应返回产品角色卡 ID");
    const proj = await get("/project/" + encodeURIComponent("D-TPL"));
    const chars = proj.project.bible.characters || [];
    const pc = chars.find((c) => c.characterId === r.productCharacterId);
    assert.ok(pc, "bible.characters 应包含产品角色卡");
    assert.equal(pc.name, "便携保温杯");
    assert.ok((pc.immutableTraits || []).length >= 1, "产品应有不可变特征（一致性锚点）");
    for (const sh of proj.project.shots) {
      assert.ok((sh.continuityAnchors || []).includes(r.productCharacterId), "每个镜头应引用产品锚点 " + sh.shotId);
    }
    // 模板不可重复用于非空项目
    const again = await post("/create_shot_list_from_template", { projectId: "D-TPL", template: "product_4shot", product: "x" });
    assert.equal(again.ok, false);
  } finally {
    s.kill();
  }
});
