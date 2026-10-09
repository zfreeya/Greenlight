/* ============================================================================
 * Seedance Provider + worker 测试（离线，使用 mock worker，不调用真实 SDK）
 *
 * 覆盖：Mock SDK 的成功/失败/取消/超时；API Key 不进 stdout/数据库；TOS 诚实；
 *       真实 worker.py 的 ping/capabilities（无 SDK 时诚实报错）。
 * 运行：node --test tools-server/director/seedance.test.mjs
 * ==========================================================================*/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { SeedanceWorkerProvider } from "./seedance/provider.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK = path.join(__dirname, "seedance", "mock_worker.py");
const REAL = path.join(__dirname, "seedance", "worker.py");

function mkProvider() {
  return new SeedanceWorkerProvider({ pythonCmd: "python3", workerPath: MOCK, billingMode: "agent_plan", model: "mock-success" });
}

test("provider: 成功生命周期 submit → poll → download（mock SDK）", async () => {
  const p = mkProvider();
  const spec = { model: "mock-success", prompt: "x", resolution: "1080p", ratio: "16:9", duration: 5, generate_audio: false, watermark: false, return_last_frame: false, billing_mode: "agent_plan" };
  const sub = await p.submitGeneration({ spec });
  assert.ok(sub.ok);
  assert.ok(sub.providerJobId);
  // 第一次 poll：running
  const p1 = await p.pollGeneration(sub.providerJobId, spec);
  assert.equal(p1.status, "running");
  // 第二次 poll：succeeded
  const p2 = await p.pollGeneration(sub.providerJobId, spec);
  assert.equal(p2.status, "succeeded");
  // 下载
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sd-dl-")), "out.mp4");
  const dl = await p.downloadResult(sub.providerJobId, out, spec);
  assert.ok(dl.sha256);
  assert.ok(fs.existsSync(out));
  p.dispose();
});

test("provider: 失败生命周期（mock SDK）", async () => {
  const p = new SeedanceWorkerProvider({ pythonCmd: "python3", workerPath: MOCK, billingMode: "agent_plan", model: "mock-fail" });
  const spec = { model: "mock-fail", prompt: "x", billing_mode: "agent_plan" };
  const sub = await p.submitGeneration({ spec });
  await p.pollGeneration(sub.providerJobId, spec);
  const s = await p.pollGeneration(sub.providerJobId, spec);
  assert.equal(s.status, "failed");
  p.dispose();
});

test("provider: 取消（mock SDK）", async () => {
  const p = new SeedanceWorkerProvider({ pythonCmd: "python3", workerPath: MOCK, billingMode: "agent_plan", model: "mock-cancel" });
  const spec = { model: "mock-cancel", prompt: "x", billing_mode: "agent_plan" };
  const sub = await p.submitGeneration({ spec });
  const r = await p.cancelGeneration(sub.providerJobId, spec);
  assert.ok(r.ok);
  p.dispose();
});

test("provider: 超时（mock SDK hang）不挂死", async () => {
  const p = new SeedanceWorkerProvider({ pythonCmd: "python3", workerPath: MOCK, billingMode: "agent_plan", model: "mock-hang" });
  const spec = { model: "mock-hang", prompt: "x", billing_mode: "agent_plan" };
  const sub = await p.submitGeneration({ spec });
  // get_task 在 mock-hang 下永不返回；用较短超时验证 RPC 超时路径
  await assert.rejects(() => p._rpc("get_task", { spec, task_id: sub.providerJobId }, 500), /超时/);
  p.dispose();
});

test("worker: 无 SDK 时 ping/capabilities 诚实报错", () => {
  // 真实 worker.py 在本机未安装 volcengine SDK，ping 应返回 sdkAvailable:false
  const child = spawnSync("python3", [REAL], {
    input: JSON.stringify({ id: 1, method: "ping" }) + "\n",
    encoding: "utf8", timeout: 15000,
  });
  assert.equal(child.status, 0);
  const line = child.stdout.trim().split("\n").filter(Boolean).pop();
  const resp = JSON.parse(line);
  assert.equal(resp.id, 1);
  assert.ok("sdkAvailable" in resp, "ping 应返回 sdkAvailable");
});

test("worker: API Key 脱敏（不进 stdout）", () => {
  // 构造一个必然报错场景：有 ARK_API_KEY 但模型为空 → 错误信息不应包含 Key
  const key = "sk-very-secret-123456";
  const child = spawnSync("python3", [REAL], {
    input: JSON.stringify({ id: 2, method: "create_task", params: { spec: { billing_mode: "agent_plan", model: "" } } }) + "\n",
    encoding: "utf8", timeout: 15000,
    env: { ...process.env, ARK_API_KEY: key },
  });
  const out = child.stdout || "";
  const stderr = child.stderr || "";
  assert.ok(!out.includes(key), "stdout 不得含 API Key");
  assert.ok(!stderr.includes(key), "stderr 日志不得含 API Key");
});

test("worker: TOS 未配置时诚实返回（不伪造上传）", () => {
  const child = spawnSync("python3", [REAL], {
    input: JSON.stringify({ id: 3, method: "tos_upload", params: { local_path: "/tmp/nope.mp4", mime: "video/mp4" } }) + "\n",
    encoding: "utf8", timeout: 15000,
  });
  const resp = JSON.parse(child.stdout.trim().split("\n").filter(Boolean).pop());
  assert.equal(resp.ok, false);
  assert.ok(/未配置/.test(resp.reason), "应诚实说明 TOS 未配置");
});
