/**
 * Skill 目录布局发现：skill-name/{SKILL.md, references/, scripts/, assets/}。
 * 只读取元数据层；正文与资源由 loader 按需加载（渐进式披露）。
 */

import fs from "node:fs";
import path from "node:path";
import { parseSkillFrontmatter, harnessExtensions, SKILL_NAME_RE } from "./frontmatter.js";
import { readText } from "../util.js";

const RESOURCE_DIRS = ["references", "scripts", "assets"];

/** 列出目录内文件（相对路径，排除隐藏文件与符号链接逃逸）。 */
function listFiles(dir, base = dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full);
    if (e.isSymbolicLink()) {
      // 拒绝符号链接：安装阶段已确保无逃逸；发现阶段防御性跳过链接目录
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory()) continue;
      out.push(rel);
    } else if (e.isDirectory()) {
      out.push(...listFiles(full, base));
    } else if (e.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * 发现一个 skill 目录。返回 metadata 层摘要（不含 SKILL.md 正文）。
 * @param {string} dir 技能目录绝对路径
 * @returns {object | null} 摘要；非法返回 null（由调用方决定丢弃）
 */
export function discoverSkillDir(dir) {
  const skillMd = path.join(dir, "SKILL.md");
  const raw = readText(skillMd);
  if (raw === null) return null;

  let parsed;
  try {
    parsed = parseSkillFrontmatter(raw, { sourceLabel: path.basename(dir) });
  } catch {
    return null;
  }

  const resources = {};
  for (const rdir of RESOURCE_DIRS) {
    const abs = path.join(dir, rdir);
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (st.isDirectory()) {
      const files = listFiles(abs).map((f) => `${rdir}/${f}`);
      if (files.length) resources[rdir] = files;
    }
  }

  const ext = harnessExtensions(parsed);

  return {
    name: parsed.name,
    description: parsed.description,
    whenToUse: parsed.whenToUse,
    version: parsed.version,
    license: parsed.license,
    compatibility: parsed.compatibility,
    allowedTools: parsed.allowedTools,
    metadata: parsed.metadata,
    resources,
    capabilities: ext.capabilities,
    publisher: ext.publisher,
    harnessVersion: ext.harnessVersion,
    dir,
  };
}

/**
 * 加载 SKILL.md 正文（第二级）。
 * @returns {{ manifest: object, content: string } | null}
 */
export function loadSkillBody(dir) {
  const skillMd = path.join(dir, "SKILL.md");
  const raw = readText(skillMd);
  if (raw === null) return null;
  let parsed;
  try {
    parsed = parseSkillFrontmatter(raw, { sourceLabel: path.basename(dir) });
  } catch {
    return null;
  }
  return { manifest: parsed, content: parsed.content };
}

/**
 * 读取指定资源文件（第三级）。只允许 resources 白名单内的相对路径。
 * @param {string} dir 技能目录
 * @param {string} rel 相对路径，如 references/api.md
 * @returns {string | null}
 */
export function loadSkillResource(dir, rel) {
  if (typeof rel !== "string") return null;
  // 防御：拒绝绝对路径与 .. 逃逸
  const abs = path.resolve(dir, rel);
  if (!abs.startsWith(path.resolve(dir) + path.sep)) return null;
  const text = readText(abs);
  return text;
}

/** 技能名语法校验（供外部调用） */
export function isSkillName(name) {
  return typeof name === "string" && SKILL_NAME_RE.test(name);
}
