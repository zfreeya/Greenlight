/* 导演工作台三尺寸截图（真实服务 + 真实数据，用于验收）
 * 运行：node scripts/screenshot-director.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "dshot-"));
const PORT = 8456;
const BASE = "http://127.0.0.1:" + PORT;

const post = (e, b) => fetch(BASE + e, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());

async function seed() {
  await post("/create_director_project", { projectId: "C-DIR", title: "天台告别", format: "narrative_short", targetDuration: 30, aspectRatio: "16:9", targetPlatform: "bilibili", coreMessage: "女孩在天台告别过去，重新开始", purpose: "情绪短片" });
  await post("/update_project_bible", { projectId: "C-DIR", section: "characters", bible: [{ characterId: "CHAR-001", name: "小雨", outfit: "白裙", hair: "黑长发" }] });
  await post("/update_project_bible", { projectId: "C-DIR", section: "locations", bible: [{ locationId: "LOC-001", name: "城市天台", timeOfDay: "黄昏" }] });
  await post("/update_project_bible", { projectId: "C-DIR", section: "visual", bible: { texture: "胶片颗粒", color: ["暖橙", "青"], motifs: ["钟表"] } });
  await post("/create_shot_list", { projectId: "C-DIR", shots: [
    { shotId: "SHOT-001", narrativePurpose: "开场：揭示告别情绪", duration: 5, shotSize: "中景", cameraMovement: "推近", subject: "小雨背对镜头", startState: "背对镜头", primaryAction: "转身", endState: "面向镜头", environment: "黄昏天台", lighting: "暖色逆光" },
    { shotId: "SHOT-002", narrativePurpose: "转场：城市呼吸", duration: 4, shotSize: "远景", cameraMovement: "横移", subject: "城市天际线", environment: "黄昏城市", lighting: "金色" },
    { shotId: "SHOT-003", narrativePurpose: "收尾：放下与离开", duration: 5, shotSize: "全景", cameraMovement: "固定", subject: "小雨走下天台", startState: "站在天台边", primaryAction: "转身离开", endState: "走出画面", environment: "天台", lighting: "逆光" },
  ] });
  for (const s of ["SHOT-001", "SHOT-002", "SHOT-003"]) {
    await post("/create_keyframe", { projectId: "C-DIR", shotId: s, keyframePrompt: "P" + s, keyframes: { characterRef: ["CHAR-001"], sceneRef: ["LOC-001"] } });
    await post("/compile_generation_prompt", { projectId: "C-DIR", shotId: s, provider: "local-stub" });
  }
  for (const s of ["SHOT-001", "SHOT-002", "SHOT-003"]) {
    await post("/confirm_generation", { projectId: "C-DIR", shotId: s, provider: "local-stub", confirmed: true });
  }
  // 等待本地生成完成（SVG 帧 + FFmpeg mp4），至多 30s
  for (let i = 0; i < 60; i++) {
    const p = (await (await fetch(BASE + "/project/C-DIR")).json()).project;
    const allTakes = p.shots.every((s) => s.takes?.length > 0);
    if (allTakes) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const p = await (await fetch(BASE + "/project/C-DIR")).json();
  for (const s of p.project.shots) {
    const take = s.takes?.[0];
    if (take?.assetId) await post("/place_clip_on_timeline", { projectId: "C-DIR", shotId: s.shotId, assetId: take.assetId });
  }
  // 渲染一次（真实 FFmpeg 产物，供导出页展示）
  await post("/create_render_job", { projectId: "C-DIR" });
  console.log("[seed] project D-SHOT ready");
}

const sizes = [
  { name: "2480x1600", width: 2480, height: 1600 },
  { name: "1920x1080", width: 1920, height: 1080 },
  { name: "1440x900", width: 1440, height: 900 },
];

const srv = spawn(process.execPath, [path.join(ROOT, "tools-server", "director-server.mjs"), "--port", String(PORT), "--workspace", WORKSPACE], { stdio: ["ignore", "ignore", "pipe"] });
srv.stderr.on("data", () => undefined);

async function waitHealth() {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + "/health")).ok) return; } catch {} await new Promise((r) => setTimeout(r, 200)); }
  throw new Error("director-server 未启动");
}

const outDir = path.join(ROOT, "docs", "reviews", "screenshots");
fs.mkdirSync(outDir, { recursive: true });

(async () => {
  await waitHealth();
  await seed();
  const browser = await chromium.launch();
  const out = [];
  for (const size of sizes) {
    const page = await browser.newPage({ viewport: { width: size.width, height: size.height } });
    await page.addInitScript((pid) => {
      const t = { id: pid, title: "天台告别", kind: "director", status: "completed", agent: "idle", msgs: [], thinking: false, todos: [], deliverables: [], updatedAt: Date.now() };
      try { localStorage.setItem("harness.threads.v1", JSON.stringify([t])); } catch {}
      localStorage.setItem("harness.current.v1", JSON.stringify(pid));
      localStorage.setItem("harness.director.config", JSON.stringify({ url: "http://127.0.0.1:8456" }));
    }, "C-DIR");
    await page.goto("http://localhost:1420", { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(2500);
    // 分镜页
    await page.getByRole("button", { name: "分镜" }).first().click().catch(() => undefined);
    await page.waitForTimeout(1200);
    const f1 = path.join(outDir, "director-shots-" + size.name + ".png");
    await page.screenshot({ path: f1 });
    out.push(f1);
    // 策划页
    await page.getByRole("button", { name: "策划" }).first().click().catch(() => undefined);
    await page.waitForTimeout(900);
    const f2 = path.join(outDir, "director-plan-" + size.name + ".png");
    await page.screenshot({ path: f2 });
    out.push(f2);
    await page.close();
  }
  await browser.close();
  console.log("[shot] 已保存：\n" + out.join("\n"));
  srv.kill(); process.exit(0);
})().catch((e) => { console.error("[shot] 失败：", e); srv.kill(); process.exit(1); });
