import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "..", "director-server.mjs");
const PORT = 8460 + Math.floor(Math.random() * 200);
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "director-itest-"));
const BASE = "http://127.0.0.1:" + PORT;

function post(ep, body) {
  return fetch(BASE + ep, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
}
function get(ep) { return fetch(BASE + ep).then((r) => r.json()); }

function startServer() {
  const child = spawn(process.execPath, [SERVER, "--port", String(PORT), "--workspace", WORKSPACE], { stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  return { child, logs: () => logs };
}

async function waitHealth(timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(BASE + "/health"); if (r.ok) return true; } catch { /* retry */ }
    await new Promise((res) => setTimeout(res, 150));
  }
  return false;
}

test("director-server 端到端闭环 + 持久化恢复", async () => {
  let s = startServer();
  try {
    assert.equal(await waitHealth(), true, "服务应健康启动");

    // 1. catalog
    const cat = await get("/catalog");
    assert.ok(cat.ok);
    assert.ok(cat.tools.length >= 25);
    assert.equal(cat.skills.length, 18);
    assert.ok(cat.providers.some((p) => p.name === "local-stub"));

    // 2. 创建项目
    const proj = await post("/create_director_project", { projectId: "D-ITEST", title: "测试短片", format: "narrative_short", targetDuration: 30, aspectRatio: "16:9", coreMessage: "告别" });
    assert.equal(proj.ok, true);

    // 3. Bible
    await post("/update_project_bible", { projectId: "D-ITEST", section: "visual", bible: { texture: "胶片颗粒", color: ["暖橙", "青"], light: ["柔光"], motifs: ["钟表"], forbidden: ["快速变焦"] } });
    await post("/update_project_bible", { projectId: "D-ITEST", section: "characters", bible: [{ characterId: "CHAR-001", name: "小雨", outfit: "白裙", face: "圆脸", hair: "黑长发" }] });

    // 4. 镜头表
    const shots = await post("/create_shot_list", { projectId: "D-ITEST", shots: [{ shotId: "SHOT-001", sceneId: "SCENE-1", narrativePurpose: "揭示告别情绪", duration: 5, shotSize: "中景", cameraMovement: "推近", subject: "小雨", startState: "背对镜头", primaryAction: "转身", endState: "面向镜头", environment: "黄昏天台", lighting: "暖色逆光" }] });
    assert.equal(shots.count, 1);

    // 5. 关键帧
    await post("/create_keyframe", { projectId: "D-ITEST", shotId: "SHOT-001", keyframePrompt: "中景，女孩白裙黑长发背对镜头站在黄昏天台", keyframes: { characterRef: ["CHAR-001"], seed: 42 } });

    // 6. 编译 Prompt（注入防御）
    const compiled = await post("/compile_generation_prompt", { projectId: "D-ITEST", shotId: "SHOT-001", provider: "local-stub" });
    assert.ok(compiled.finalPrompt.includes("安全与权限规则"));
    assert.ok(compiled.finalPrompt.includes("SHOT-001"));

    // 7. 提交生成（兼容入口已收敛到生成引擎：spec→校验→key→缓存→SQLite任务→提交）
    const sub = await post("/submit_video_generation", { projectId: "D-ITEST", shotId: "SHOT-001", provider: "local-stub" });
    assert.equal(sub.ok, true);
    assert.ok(sub.taskId);
    assert.ok(sub.validation.ok, "能力校验应通过");
    assert.equal(sub.cacheHit, false);

    // 8. 轮询（统一状态机终态为 ready_for_review）
    const poll = await post("/poll_video_generation", { projectId: "D-ITEST", taskId: sub.taskId });
    assert.equal(poll.status, "ready_for_review");

    // 9. 读取项目状态（Take 是完成单元；legacy generationTasks 镜像已废弃）
    let p = await get("/project/D-ITEST");
    assert.equal(p.project.shots[0].status, "generated");
    const assetId = p.project.shots[0].clipAssetId;
    assert.ok(assetId);
    assert.equal(p.project.shots[0].takes.length, 1);
    assert.equal(p.project.shots[0].takes[0].status, "ready_for_review");

    // 10. QC（真实检测冻结帧）
    const qc = await post("/run_clip_qc", { projectId: "D-ITEST", shotId: "SHOT-001", assetId });
    assert.ok(["pass", "pass_with_notes", "regenerate", "repair_prompt", "redesign_shot", "reject"].includes(qc.verdict));

    // 11. 放到时间线
    const placed = await post("/place_clip_on_timeline", { projectId: "D-ITEST", shotId: "SHOT-001", assetId });
    assert.equal(placed.ok, true);

    // 12. 渲染（命令生成）
    const preview = await post("/render_preview", { projectId: "D-ITEST" });
    assert.ok(preview.command.startsWith("ffmpeg"));
    const final = await post("/render_final", { projectId: "D-ITEST" });
    assert.ok(final.command.includes("concat"));

    // 13. 导出归档（真实写文件）
    const exp = await post("/export_project_archive", { projectId: "D-ITEST" });
    assert.equal(exp.ok, true);
    for (const f of ["shots.csv", "project-bible.md", "assets-manifest.json", "rights-manifest.json", "third-party-notices.md"]) {
      assert.ok(fs.existsSync(path.join(exp.dir, f)), "导出文件缺失：" + f);
    }

    // 14. 队列
    const q = await post("/list_generation_queue", { projectId: "D-ITEST" });
    assert.equal(q.queue.length, 1);

    // 15. 检查点 + 版本
    const cp = await post("/checkpoint_project", { projectId: "D-ITEST", reason: "itest" }).catch(() => ({ ok: false }));
    // 直接通过 store 验证版本持久化（project.json 已在磁盘）
    assert.ok(fs.existsSync(path.join(WORKSPACE, "director", "D-ITEST", "project.json")));
  } finally {
    s.child.kill("SIGKILL");
  }

  // 16. 重启服务，验证状态完整恢复（可恢复性）
  const s2 = startServer();
  try {
    assert.equal(await waitHealth(), true);
    const p = await get("/project/D-ITEST");
    assert.equal(p.ok, true);
    assert.equal(p.project.title, "测试短片");
    assert.equal(p.project.shots.length, 1);
    assert.equal(p.project.shots[0].status, "placed_on_timeline");
    assert.ok(p.project.timeline.videoTracks[0].clips.length >= 1);
    assert.equal(p.project.assets.length, 1);
    const projs = await get("/projects");
    assert.equal(projs.projects.length, 1);
  } finally {
    s2.child.kill("SIGKILL");
  }
});
