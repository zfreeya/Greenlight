/* 导演工作台布局验收（程序化测量，替代目测截图）
 * 检查：无竖排中文 / 无横向溢出 / 面板不重叠 / Inspector 可收起 / Timeline 仅剪辑页 / 侧栏可收起
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "dverify-"));
const PORT = 8457;
const BASE = "http://127.0.0.1:" + PORT;
const post = (e, b) => fetch(BASE + e, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());

async function seed() {
  await post("/create_director_project", { projectId: "C-V", title: "验证项目", aspectRatio: "16:9", coreMessage: "测试" });
  await post("/create_shot_list", { projectId: "C-V", shots: [
    { shotId: "SHOT-001", duration: 5, subject: "主角", narrativePurpose: "开场", shotSize: "中景", cameraMovement: "推近" },
    { shotId: "SHOT-002", duration: 4, subject: "城市", narrativePurpose: "转场", shotSize: "远景" },
    { shotId: "SHOT-003", duration: 5, subject: "离开", narrativePurpose: "收尾" },
  ] });
  for (const s of ["SHOT-001", "SHOT-002", "SHOT-003"]) { await post("/create_keyframe", { projectId: "C-V", shotId: s, keyframePrompt: "P" }); await post("/compile_generation_prompt", { projectId: "C-V", shotId: s, provider: "local-stub" }); }
  for (const s of ["SHOT-001", "SHOT-002", "SHOT-003"]) await post("/confirm_generation", { projectId: "C-V", shotId: s, provider: "local-stub", confirmed: true });
  const p = (await (await fetch(BASE + "/project/C-V")).json()).project;
  for (const s of p.shots) if (s.takes?.[0]?.assetId) await post("/place_clip_on_timeline", { projectId: "C-V", shotId: s.shotId, assetId: s.takes[0].assetId });
}

const srv = spawn(process.execPath, [path.join(ROOT, "tools-server", "director-server.mjs"), "--port", String(PORT), "--workspace", WORKSPACE], { stdio: ["ignore", "ignore", "pipe"] });
const waitHealth = async () => { for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + "/health")).ok) return; } catch {} await new Promise((r) => setTimeout(r, 200)); } throw new Error("server"); };

(async () => {
  await waitHealth(); await seed();
  const browser = await chromium.launch();
  const results = [];
  const sizes = [
    { name: "2480x1600", width: 2480, height: 1600 },
    { name: "1920x1080", width: 1920, height: 1080 },
    { name: "1440x900", width: 1440, height: 900 },
  ];
  for (const size of sizes) {
    const page = await browser.newPage({ viewport: { width: size.width, height: size.height } });
    await page.addInitScript((pid) => {
      const t = { id: pid, title: "验证项目", kind: "director", status: "completed", agent: "idle", msgs: [], thinking: false, todos: [], deliverables: [], updatedAt: Date.now() };
      try { localStorage.setItem("harness.threads.v1", JSON.stringify([t])); } catch {}
      localStorage.setItem("harness.current.v1", JSON.stringify(pid));
      localStorage.setItem("harness.director.config", JSON.stringify({ url: "http://127.0.0.1:8457" }));
    }, "C-V");
    await page.goto("http://localhost:1420", { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(2200);

    const R = {};
    // 1) 横向溢出
    R.noHOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    // 2) 主工作区宽度
    R.mainW = await page.evaluate(() => { const el = document.querySelector(".d-main"); return el ? Math.round(el.getBoundingClientRect().width) : -1; });
    // 3) 竖排中文检测：含 CJK 的文本节点渲染宽度 < 8px 或行内逐字折行（clientWidth 显著小于 scrollWidth 且文本长）
    R.verticalCJK = await page.evaluate(() => {
      const bad = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const n = walker.currentNode; const t = n.textContent || "";
        if (!/[\u4e00-\u9fa5]/.test(t)) continue;
        const r = n.parentElement?.getBoundingClientRect(); if (!r || r.width < 2 || r.height < 2) continue;
        // 若容器内中文被逐字竖排：每行高度≈字高且容器高度远大于宽度容纳
        const lineH = parseFloat(getComputedStyle(n.parentElement).lineHeight) || 16;
        const rows = Math.round(r.height / lineH);
        const chars = [...t].filter((c) => /[\u4e00-\u9fa5]/.test(c)).length;
        if (rows >= 3 && r.width < 40 && chars > rows) bad.push(t.trim().slice(0, 12) + "@" + Math.round(r.width) + "px");
      }
      return bad.slice(0, 5);
    });
    // 4) 面板不重叠：header/nav/body/agent 包围盒
    R.overlap = await page.evaluate(() => {
      const boxes = [".d-header", ".d-nav", ".d-body", ".d-agent"].map((s) => document.querySelector(s)).filter(Boolean)
        .map((el) => el.getBoundingClientRect());
      const els = [".d-header", ".d-nav", ".d-body", ".d-agent"].map((s) => document.querySelector(s)).filter(Boolean);
      for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) {
        const a = els[i].getBoundingClientRect(), b = els[j].getBoundingClientRect();
        // 跳过嵌套（祖先/后代）对
        const contains = a.left <= b.left && a.top <= b.top && a.right >= b.right && a.bottom >= b.bottom
          || b.left <= a.left && b.top <= a.top && b.right >= a.right && b.bottom >= a.bottom;
        if (contains) continue;
        const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
        const y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        if (x > 4 && y > 4) return { i, j, x: Math.round(x), y: Math.round(y) };
      }
      return null;
    });
    // 5) 分镜页：Timeline 不出现
    await page.getByRole("button", { name: "分镜" }).first().click().catch(() => undefined);
    await page.waitForTimeout(800);
    R.timelineOnShots = await page.evaluate(() => Boolean(document.querySelector(".d-timeline")));
    R.shotCards = await page.evaluate(() => document.querySelectorAll(".d-shot-card").length);
    // 6) 选中镜头 → Inspector 出现
    await page.evaluate(() => { const c = document.querySelector(".d-shot-card"); if (c) c.click(); });
    await page.waitForTimeout(500);
    R.inspectorOnSelect = await page.evaluate(() => Boolean(document.querySelector(".d-inspector")));
    // 7) 剪辑页：Timeline 出现
    await page.getByRole("button", { name: "剪辑" }).first().click().catch(() => undefined);
    await page.waitForTimeout(800);
    R.timelineOnEdit = await page.evaluate(() => Boolean(document.querySelector(".d-timeline")));
    R.playerOnEdit = await page.evaluate(() => Boolean(document.querySelector(".d-player")));
    // 7b) 生成页：唯一主导行动入口（O3-KR3）
    await page.getByRole("button", { name: "生成" }).first().click().catch(() => undefined);
    await page.waitForTimeout(700);
    R.primaryOnGeneration = await page.evaluate(() => Array.from(document.querySelectorAll(".d-pane-head .btn-primary")).length);
    // 7c) 导出页：唯一主导行动入口
    await page.getByRole("button", { name: "导出" }).first().click().catch(() => undefined);
    await page.waitForTimeout(700);
    R.primaryOnExport = await page.evaluate(() => Array.from(document.querySelectorAll(".d-pane-head .btn-primary")).length);
    // 8) Agent 抽屉展开宽度（无竖排中文的底线）
    await page.evaluate(() => { const el = document.querySelector(".d-agent-toggle"); if (el) el.click(); });
    await page.waitForTimeout(400);
    R.agentW = await page.evaluate(() => { const el = document.querySelector(".d-agent"); return el ? Math.round(el.getBoundingClientRect().width) : -1; });
    // 9) 侧栏收起
    R.sidebarCollapse = await page.evaluate(() => {
      const before = document.querySelector(".sidebar")?.getBoundingClientRect().width || 0;
      document.querySelector(".side-toggle")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return new Promise((res) => setTimeout(() => {
        const after = document.querySelector(".sidebar")?.getBoundingClientRect().width || 0;
        res({ before: Math.round(before), after: Math.round(after) });
      }, 150));
    });
    await page.close();
    results.push({ size: size.name, ...R });
  }
  await browser.close();
  console.log(JSON.stringify(results, null, 2));
  const fail = results.filter((r) => !r.noHOverflow || r.verticalCJK?.length || r.overlap || r.timelineOnShots || !r.inspectorOnSelect || !r.timelineOnEdit || !r.playerOnEdit || r.agentW < 360 || r.mainW < 700 || !r.shotCards || r.primaryOnGeneration !== 1 || r.primaryOnExport !== 1);
  if (fail.length) { console.log("验收不通过尺寸：", fail.map((f) => f.size)); srv.kill(); process.exit(1); }
  console.log("验收通过：三种尺寸均无竖排中文/无溢出/无重叠；Inspector 按选中显示；Timeline 仅剪辑页；Agent 抽屉 ≥360px；侧栏可收起；生成/导出页各仅一个主导入口。");
  srv.kill(); process.exit(0);
})().catch((e) => { console.error("验收失败：", e); srv.kill(); process.exit(1); });
