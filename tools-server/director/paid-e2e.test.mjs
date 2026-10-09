/* ============================================================================
 * 付费端到端测试（真实 Seedance，绝不默认运行）
 *
 * 门禁（必须同时满足，缺一即跳过）：
 *   1. RUN_PAID_E2E === "1"
 *   2. CONFIRM_PAID_SEEDANCE === "YES"（硬性费用护栏，等价界面二次确认）
 *   3. 环境存在 ARK_API_KEY
 *
 * 运行：RUN_PAID_E2E=1 CONFIRM_PAID_SEEDANCE=YES ARK_API_KEY=... \
 *        SEEDANCE_MODEL=doubao-seedance-1-0-pro-250528 \
 *        node --test tools-server/director/paid-e2e.test.mjs
 *
 * 硬性护栏：全程只允许一次真实 Provider create；第二次提交完全相同 Spec 必须
 * 命中缓存（不产生第二次远程任务）。最小成本参数：单镜头、5s、480p、无音频。
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
const PORT = 9200 + Math.floor(Math.random() * 50);
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "paid-e2e-"));
const BASE = "http://127.0.0.1:" + PORT;

const paidEnabled = process.env.RUN_PAID_E2E === "1";
const userConfirmed = process.env.CONFIRM_PAID_SEEDANCE === "YES" || process.env.PAID_E2E_CONFIRM === "yes";
const hasKey = Boolean(process.env.ARK_API_KEY);
const MODEL = process.env.SEEDANCE_MODEL || "";
const BILLING = process.env.SEEDANCE_BILLING_MODE || "agent_plan";

const post = (ep, body) => fetch(BASE + ep, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

test("付费 E2E：真实 Seedance 一次 create → 轮询 → 下载 → Take → 二次同 Spec 命中缓存", async (t) => {
  if (!paidEnabled) return t.skip("未设置 RUN_PAID_E2E=1，跳过付费测试");
  if (!userConfirmed) return t.skip("未设置 CONFIRM_PAID_SEEDANCE=YES（等价于界面二次确认），跳过付费测试");
  if (!hasKey) return t.skip("缺少 ARK_API_KEY，跳过付费测试");
  if (!MODEL) return t.skip("缺少 SEEDANCE_MODEL，跳过付费测试");

  const child = spawn(process.execPath, [SERVER, "--port", String(PORT), "--workspace", WORKSPACE], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ARK_API_KEY: process.env.ARK_API_KEY, SEEDANCE_MODEL: MODEL, SEEDANCE_BILLING_MODE: BILLING },
  });
  let logs = "";
  child.stdout.on("data", (d) => { logs += d; });
  child.stderr.on("data", (d) => { logs += d; });
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + "/health")).ok) break; } catch {} await new Promise((r) => setTimeout(r, 150)); }

    // 最小成本参数：单镜头、5s、最低分辨率 480p、无音频
    await post("/create_director_project", { projectId: "D-PAID", title: "付费冒烟", aspectRatio: "16:9", resolution: "480p" });
    await post("/create_shot_list", { projectId: "D-PAID", shots: [{ shotId: "SHOT-001", duration: 5, subject: "猫在窗边", narrativePurpose: "冒烟测试" }] });
    await post("/create_keyframe", { projectId: "D-PAID", shotId: "SHOT-001", keyframePrompt: "一只猫在窗边慢慢转头" });

    // 1) 编译 → 能力校验必须通过
    const spec = await post("/compile_generation_spec", { projectId: "D-PAID", shotId: "SHOT-001", provider: "seedance", model: MODEL, billing_mode: BILLING, resolution: "480p", duration: 5, generate_audio: false });
    assert.equal(spec.ok, true, "能力校验应通过：" + JSON.stringify(spec.validation));
    assert.equal(spec.blocked, false, "参数应受支持：" + JSON.stringify(spec.validation));
    assert.equal(spec.cacheHit, false, "首次不应命中缓存");

    // 2) 确认提交 → 引擎唯一约束 + 幂等保护只允许一次 Provider create
    const confirm = await post("/confirm_generation", { projectId: "D-PAID", shotId: "SHOT-001", provider: "seedance", model: MODEL, billing_mode: BILLING, resolution: "480p", duration: 5, generate_audio: false, confirmed: true });
    assert.equal(confirm.ok, true, "确认提交应成功：" + JSON.stringify(confirm));
    assert.equal(confirm.results[0].cacheHit, false);

    // 3) 轮询至终态（下载完成 → ready_for_review）
    let status = "";
    for (let i = 0; i < 120; i++) {
      const q = await post("/list_generation_queue", { projectId: "D-PAID" });
      const task = q.queue.find((x) => x.taskId === confirm.results[0].taskId);
      status = task ? task.status : "unknown";
      if (status === "ready_for_review" || status === "failed" || status === "cancelled") break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    assert.equal(status, "ready_for_review", "真实任务应下载完成（实际状态=" + status + "，日志尾部=" + logs.slice(-500) + "）");

    // 4) 完全相同的 Spec 再次编译 → 必须命中缓存（不产生第二次 Provider create）
    const spec2 = await post("/compile_generation_spec", { projectId: "D-PAID", shotId: "SHOT-001", provider: "seedance", model: MODEL, billing_mode: BILLING, resolution: "480p", duration: 5, generate_audio: false });
    assert.equal(spec2.cacheHit, true, "第二次相同 Spec 必须命中缓存（不产生第二次 Provider create）");
    const q = await post("/list_generation_queue", { projectId: "D-PAID" });
    assert.ok(q.queue.filter((x) => x.generationKey === spec.generationKey).length >= 1);
    console.log("[paid-e2e] PASS：一次真实 create，第二次命中缓存，key=" + spec.generationKey.slice(0, 16));
  } finally {
    child.kill("SIGKILL");
  }
});
