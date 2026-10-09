/* ============================================================================
 * Harness Director — macOS Keychain 凭证存取（安全存储）
 *
 * 正式桌面端：ARK_API_KEY 存入 macOS Keychain，绝不进入 localStorage / 前端状态 /
 * 日志 / SQLite / 项目文件，也绝不进入渲染进程。
 *
 * 开发环境：从 ARK_API_KEY 环境变量读取（不落盘）。
 *
 * 本模块用 macOS `security` CLI 读写 Keychain（零第三方依赖）：
 *   - readApiKey()  / writeApiKey() / deleteApiKey()
 *   - resolveApiKey()：优先 Keychain，回退 ARK_API_KEY（仅开发）
 * 返回的 Key 只应注入 sidecar worker 的 env，绝不下发到 HTTP / 前端。
 * ==========================================================================*/
import { spawnSync } from "node:child_process";

const SERVICE = process.env.HARNESS_KEYCHAIN_SERVICE || "dev.harness.seedance";
const ACCOUNT = process.env.HARNESS_KEYCHAIN_ACCOUNT || "ark_api_key";

function isMac() { return process.platform === "darwin"; }

export function readApiKey(opts = {}) {
  const service = opts.service || SERVICE;
  const account = opts.account || ACCOUNT;
  if (!isMac()) return null;
  const r = spawnSync("security", ["find-generic-password", "-s", service, "-a", account, "-w"], {
    encoding: "utf8", timeout: 5000,
  });
  if (r.status !== 0) return null;
  return (r.stdout || "").trim() || null;
}

export function writeApiKey(key, opts = {}) {
  const service = opts.service || SERVICE;
  const account = opts.account || ACCOUNT;
  if (!isMac()) throw new Error("Keychain 仅在 macOS 可用");
  if (!key) throw new Error("不能写入空 Key");
  // 先删后写，避免重复项冲突
  spawnSync("security", ["delete-generic-password", "-s", service, "-a", account], { timeout: 5000 });
  const r = spawnSync("security", ["add-generic-password", "-s", service, "-a", account, "-w", key, "-U"], {
    encoding: "utf8", timeout: 5000,
  });
  if (r.status !== 0) throw new Error("写入 Keychain 失败：" + (r.stderr || "").slice(0, 200));
  return true;
}

export function deleteApiKey(opts = {}) {
  const service = opts.service || SERVICE;
  const account = opts.account || ACCOUNT;
  if (!isMac()) return false;
  const r = spawnSync("security", ["delete-generic-password", "-s", service, "-a", account], { timeout: 5000 });
  return r.status === 0;
}

/**
 * 解析 API Key：优先 Keychain（正式），回退 ARK_API_KEY（仅开发）。
 * 该 Key 只能注入 worker env，绝不进入 HTTP 响应 / 前端 / 日志 / 数据库。
 */
export function resolveApiKey(opts = {}) {
  const fromKeychain = readApiKey(opts);
  if (fromKeychain) return { key: fromKeychain, source: "keychain" };
  const fromEnv = process.env.ARK_API_KEY || "";
  if (fromEnv) return { key: fromEnv, source: "env" };
  return { key: "", source: "none" };
}

export default { readApiKey, writeApiKey, deleteApiKey, resolveApiKey };
