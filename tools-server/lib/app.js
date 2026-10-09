/**
 * Harness 能力后端共享上下文（单例）。
 * 持有 SkillRegistry（后续扩展 MCPHost / CapabilityRegistry / PermissionBroker / RunStore）。
 */

import path from "node:path";
import os from "node:os";
import { mkdirp } from "./util.js";
import { SkillRegistry } from "./skill/registry.js";

let instance = null;

export function createApp({ dataDir } = {}) {
  if (instance) return instance;

  const DATA_DIR = path.resolve(
    dataDir ?? process.env.DSH_HARNESS_DATA ?? path.join(os.homedir(), ".harness"),
  );
  mkdirp(DATA_DIR);

  const skillsRoot = path.join(DATA_DIR, "skills");
  const skills = new SkillRegistry({ skillsRoot, dataDir: DATA_DIR });

  // 启动时从磁盘重建（容错：索引文件被删也能恢复）
  skills.rescan();

  instance = { dataDir: DATA_DIR, skillsRoot, skills };
  return instance;
}

/** 测试用：重置单例。 */
export function resetApp() {
  instance = null;
}
