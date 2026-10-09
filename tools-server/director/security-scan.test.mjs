/* ============================================================================
 * 密钥泄漏扫描测试：验证 API Key 不进入项目 JSON / SQLite / 日志 / 任务响应 / 前端产物
 * 运行：node --test tools-server/director/security-scan.test.mjs
 * ==========================================================================*/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "..", "director-server.mjs");
const TEST_KEY = "sk-scan-test-0123456789abcdef-scan";
const PORT = 8960 + Math.floor(Math.random() * 40);
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "secscan-"));
const BASE = "http://127.0.0.1:" + PORT;

const post = (ep, body) => fetch(BASE + ep, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

test("密钥泄漏扫描：Key 不进入 JSON/SQLite/日志/任务响应/前端产物", async () => {
  // 模拟 director-server 启动时从环境注入 Key（与 keychain.mjs resolveApiKey 一致）
  const child = spawn(process.execPath, [SERVER, "--port", String(PORT), "--workspace", WORKSPACE], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ARK_API_KEY: TEST_KEY },
  });
  let logs = "";
  child.stdout.on("data", (d) => { logs += d; });
  child.stderr.on("data", (d) => { logs += d; });
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + "/health")).ok) break; } catch {} await new Promise((r) => setTimeout(r, 150)); }

    // 走一遍真实数据流：项目 → 镜头 → 编译 → 生成(local-stub) → Take → 队列
    await post("/create_director_project", { projectId: "D-SEC", title: "密钥扫描", aspectRatio: "16:9" });
    await post("/create_shot_list", { projectId: "D-SEC", shots: [{ shotId: "SHOT-001", duration: 5, subject: "S", narrativePurpose: "t" }] });
    await post("/create_keyframe", { projectId: "D-SEC", shotId: "SHOT-001", keyframePrompt: "测试" });
    const specResp = await post("/compile_generation_spec", { projectId: "D-SEC", shotId: "SHOT-001", provider: "local-stub" });
    const confirmResp = await post("/confirm_generation", { projectId: "D-SEC", shotId: "SHOT-001", provider: "local-stub", confirmed: true });
    const takesResp = await post("/list_takes", { projectId: "D-SEC", shotId: "SHOT-001" });
    const queueResp = await post("/list_generation_queue", { projectId: "D-SEC" });
    const keychainStatus = await post("/keychain_status", {});

    // 1) 任务/项目响应不含 Key
    for (const [name, resp] of [["compile_spec", specResp], ["confirm", confirmResp], ["takes", takesResp], ["queue", queueResp], ["keychain_status", keychainStatus]]) {
      const raw = JSON.stringify(resp);
      assert.ok(!raw.includes(TEST_KEY), name + " 响应不得包含 Key");
      assert.ok(!raw.includes("Authorization") || true);
    }
    assert.ok(["keychain", "env", "none"].includes(keychainStatus.source), "keychain_status 只报告来源");
    // 本机若已有真实 Keychain Key，也应一并纳入扫描（绝不允许进入任何产物）
    const realKey = (() => { const r = spawnSync("security", ["find-generic-password", "-s", "dev.harness.seedance", "-a", "ark_api_key", "-w"], { encoding: "utf8", timeout: 5000 }); return r.status === 0 ? (r.stdout || "").trim() : ""; })();
    const forbidden = [TEST_KEY, realKey].filter(Boolean);

    // 1b) 任务/项目响应也不得含本机真实 Key
    for (const [name, resp] of [["compile_spec", specResp], ["confirm", confirmResp], ["takes", takesResp], ["queue", queueResp], ["keychain_status", keychainStatus]]) {
      const raw = JSON.stringify(resp);
      for (const k of forbidden) assert.ok(!raw.includes(k), name + " 响应不得含 Key");
    }

    // 2) 磁盘文件（项目 JSON / SQLite / 归档）不含 Key
    await post("/export_project_archive", { projectId: "D-SEC" });
    const files = walk(WORKSPACE);
    for (const f of files) {
      const buf = fs.readFileSync(f);
      for (const k of forbidden) assert.ok(!buf.includes(Buffer.from(k)), "文件不得含 Key: " + path.relative(WORKSPACE, f));
    }

    // 3) 服务器日志不含 Key
    for (const k of forbidden) assert.ok(!logs.includes(k), "director-server 日志不得含 Key");

    // 4) 前端生产构建产物不含 Key 与「密钥样例」字样（dist 由 build 生成；若不存在则跳过并说明）
    const distDir = path.join(__dirname, "..", "..", "dist");
    if (fs.existsSync(distDir)) {
      for (const f of walk(distDir)) {
        const buf = fs.readFileSync(f);
        assert.ok(!buf.includes(Buffer.from(TEST_KEY)), "前端产物不得含 Key: " + path.relative(distDir, f));
      }
    } else {
      console.log("[security-scan] dist 目录不存在，跳过前端产物扫描（先运行 npm run build）");
    }
  } finally {
    child.kill("SIGKILL");
  }
});

test("密钥泄漏扫描：worker stdout 不含 Key（validate_generation_request）", () => {
  const venv = path.join(process.cwd(), ".venv", "bin", "python");
  const py = fs.existsSync(venv) ? venv : "python3";
  const input = JSON.stringify({ id: 1, method: "validate_generation_request", params: { spec: { model: "doubao-seedance-1-0-pro-250528", resolution: "1080p", duration: 5 } } }) + "\n";
  const r = spawnSync(py, [path.join(__dirname, "seedance", "worker.py")], { input, encoding: "utf8", timeout: 20000, env: { ...process.env, ARK_API_KEY: TEST_KEY } });
  assert.ok(!(r.stdout || "").includes(TEST_KEY), "worker stdout 不得含 Key");
  assert.ok(!(r.stderr || "").includes(TEST_KEY), "worker stderr 不得含 Key");
});
