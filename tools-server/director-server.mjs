/* ============================================================================
 * Harness Director — 服务入口（薄 CLI 包装）
 *
 * 全部实现已按域模块化到 director/ 包内（server.mjs 组合根 + routes/* 域路由 +
 * server-context.mjs 共享上下文）。本文件只负责解析命令行参数并启动，行为与
 * 旧版 director-server.mjs 完全一致（health / catalog / 项目 / 资产 / 导出 /
 * 全部工具路由 / 轮询循环）。
 *
 * 运行：node tools-server/director-server.mjs [--workspace <dir>] [--port <n>]
 *   环境变量：DSH_DIRECTOR_PORT / DSH_TOOLS_WORKSPACE / SEEDANCE_MOCK=1 /
 *   SEEDANCE_MODEL / SEEDANCE_BILLING_MODE / ARK_API_KEY
 * ==========================================================================*/
import { createDirectorServer } from "./director/server.mjs";

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const port = Number(argValue("--port", process.env.DSH_DIRECTOR_PORT ?? "8456"));
const workspace = argValue("--workspace", process.env.DSH_TOOLS_WORKSPACE ?? null);

const server = createDirectorServer({
  port,
  ...(workspace ? { workspace } : {}),
});
server.start();
