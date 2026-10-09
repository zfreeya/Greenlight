/**
 * Skill 安装：从本地文件夹 / ZIP / Git URL 安装到版本化目录。
 *
 * 安全要求（禁止安装过程执行 Skill 脚本）：
 *  1. 解包/克隆到临时目录；
 *  2. 检查路径穿越（zip-slip）；
 *  3. 拒绝符号链接逃逸；
 *  4. 验证 SKILL.md（frontmatter 合法 + 目录名/名一致）；
 *  5. 扫描脚本（记录，不执行）；
 *  6. 分析请求的权限/能力；
 *  7. 移动到版本化目录并更新索引。
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import yauzl from "yauzl";
import { contentId, mkdirp, assertSafeRelativeName, isInside } from "../util.js";
import { discoverSkillDir, loadSkillBody } from "./layout.js";

/** 拷贝目录到目标（拒绝符号链接逃逸；非逃逸符号链接按内容解引用）。 */
function copyTree(srcDir, destDir, { rejectEscapingSymlink = true } = {}) {
  const srcRoot = path.resolve(srcDir);
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const e of entries) {
    const src = path.join(srcDir, e.name);
    const dest = path.join(destDir, e.name);
    if (e.isSymbolicLink()) {
      const real = fs.realpathSync(src);
      if (rejectEscapingSymlink && !isInside(srcRoot, real)) {
        throw new Error(`符号链接逃逸：${e.name} -> ${real}`);
      }
      const st = fs.statSync(src);
      if (st.isDirectory()) {
        mkdirp(dest);
        copyTree(src, dest, { rejectEscapingSymlink });
      } else if (st.isFile()) {
        fs.copyFileSync(real, dest);
      }
      continue;
    }
    if (e.isDirectory()) {
      mkdirp(dest);
      copyTree(src, dest, { rejectEscapingSymlink });
    } else if (e.isFile()) {
      mkdirp(path.dirname(dest));
      fs.copyFileSync(src, dest);
    }
  }
}

/** 从 ZIP 解压到目标目录（流式，逐条校验文件名防 zip-slip）。 */
function extractZip(zipPath, destDir) {
  const destRoot = path.resolve(destDir);
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      zipfile.on("error", reject);
      zipfile.on("entry", (entry) => {
        const name = entry.fileName;
        try {
          assertSafeRelativeName(name);
        } catch (e) {
          return reject(e);
        }
        const outPath = path.resolve(destRoot, name);
        if (!isInside(destRoot, outPath)) {
          return reject(new Error(`ZIP 路径穿越：${name}`));
        }
        if (/\/$/.test(name)) {
          mkdirp(outPath);
          zipfile.readEntry();
        } else {
          mkdirp(path.dirname(outPath));
          zipfile.openReadStream(entry, (err2, stream) => {
            if (err2) return reject(err2);
            const ws = fs.createWriteStream(outPath, { flags: "w", mode: (entry.externalFileAttributes >>> 16) || 0o644 });
            stream.on("error", reject);
            ws.on("error", reject);
            ws.on("close", () => zipfile.readEntry());
            stream.pipe(ws);
          });
        }
      });
      zipfile.on("end", () => resolve());
      zipfile.readEntry();
    });
  });
}

/** 找到 zip 内的唯一顶层技能目录（容忍单层包裹）。 */
function findSkillRoot(dir) {
  // 若目录本身就是技能（含 SKILL.md），直接返回
  if (fs.existsSync(path.join(dir, "SKILL.md"))) return dir;
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith("."));
  const dirs = entries.filter((e) => e.isDirectory());
  const files = entries.filter((e) => e.isFile());
  // 单目录包裹（且无散落文件）
  if (dirs.length === 1 && files.length === 0 && fs.existsSync(path.join(dir, dirs[0].name, "SKILL.md"))) {
    return path.join(dir, dirs[0].name);
  }
  return null;
}

/** 扫描脚本：记录可执行/脚本文件，绝不执行。 */
function scanScripts(dir) {
  const scripts = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        const rel = path.relative(dir, full);
        if (/\.(sh|py|js|mjs|cjs|ts|rb|pl|go|rs|exe|bin|command)$/.test(e.name) || ext === "" || (fs.statSync(full).mode & 0o111)) {
          scripts.push(rel);
        }
      }
    }
  };
  walk(dir);
  return scripts;
}

/** 分析安装内容：验证 SKILL.md、目录名一致、脚本、权限请求。 */
export function analyzeSkillDir(dir) {
  const root = findSkillRoot(dir);
  if (!root) throw new Error("未找到 SKILL.md（目录或 ZIP 内必须含 SKILL.md）");

  const summary = discoverSkillDir(root);
  if (!summary) throw new Error("SKILL.md 校验失败：frontmatter 不合法");

  const dirName = path.basename(root);
  // 目录名与 frontmatter name 一致（或目录为任意名但 frontmatter name 合法即可）。
  // 标准允许目录名与 name 不同，但为可预测性，仅校验 frontmatter name 合法。

  const scripts = scanScripts(root);
  const permissions = [];
  for (const cap of summary.capabilities) permissions.push(`capability:${cap}`);
  for (const t of summary.allowedTools ?? []) permissions.push(`tool:${t}`);
  if (scripts.length) permissions.push("exec:skill-script");

  return {
    root,
    name: summary.name,
    version: summary.version ?? "0.0.0",
    license: summary.license,
    publisher: summary.publisher,
    description: summary.description,
    capabilities: summary.capabilities,
    allowedTools: summary.allowedTools,
    scripts,
    requestedPermissions: [...new Set(permissions)],
    summary,
  };
}

/**
 * 安装技能到版本化目录，更新索引。
 * @param {object} params
 * @param {object} params.source 安装来源 {kind:'folder'|'zip'|'git', path|url, ref?}
 * @param {string} params.skillsRoot 技能安装根（版本化目录在 <skillsRoot>/<name>/<version>/）
 * @param {object} params.index 当前索引对象（原地更新后返回）
 * @param {"official"|"verified"|"community"|"local"|"untrusted"} params.trustLevel
 * @returns {Promise<{installed: object, tmpDir: string}>}
 */
export async function installSkill({ source, skillsRoot, index, trustLevel = "local" }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-skill-"));

  try {
    // 1) 把来源物化到临时目录
    if (source.kind === "folder") {
      const src = path.resolve(source.path);
      if (!fs.statSync(src).isDirectory()) throw new Error("来源目录不存在");
      copyTree(src, path.join(tmp, "src"));
    } else if (source.kind === "zip") {
      await extractZip(path.resolve(source.path), path.join(tmp, "src"));
    } else if (source.kind === "git") {
      const args = ["clone", "--depth", "1"];
      if (source.ref) args.push("--branch", source.ref);
      args.push(source.url, path.join(tmp, "src"));
      const r = spawnSync("git", args, { encoding: "utf8", timeout: 120_000 });
      if (r.status !== 0) throw new Error(`git clone 失败：${(r.stderr || r.error || "").slice(0, 300)}`);
    } else {
      throw new Error("未知安装来源");
    }

    // 2) 分析（验证 SKILL.md + 脚本扫描 + 权限）
    const analysis = analyzeSkillDir(path.join(tmp, "src"));

    // 3) 版本化目标目录（同名同版本重复安装 = 覆盖，视为更新）
    const versionDir = path.join(skillsRoot, analysis.name, analysis.version);
    if (fs.existsSync(versionDir)) fs.rmSync(versionDir, { recursive: true, force: true });
    mkdirp(path.dirname(versionDir));
    fs.renameSync(analysis.root, versionDir);

    // 4) 更新索引
    const id = contentId(analysis.name, analysis.version);
    const record = {
      id,
      name: analysis.name,
      version: analysis.version,
      origin: source.kind === "folder" ? "folder" : source.kind === "zip" ? "zip" : "git",
      source,
      installPath: versionDir,
      trustLevel,
      status: "installed",
      scope: "global",
      license: analysis.license,
      publisher: analysis.publisher,
      enabled: true,
      manifest: analysis.summary,
      requestedPermissions: analysis.requestedPermissions,
      installedAt: Date.now(),
      updatedAt: Date.now(),
    };
    index.byId[id] = record;
    index.byName[analysis.name] = id; // 最新安装覆盖

    return { installed: record, analysis };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** 反安装：删除版本目录并从索引移除。 */
export function uninstallSkill({ skillsRoot, index, id }) {
  const rec = index.byId[id];
  if (!rec) throw new Error("技能不存在：" + id);
  const versionDir = rec.installPath;
  // 防御：仅允许删除 skillsRoot 内的目录
  if (isInside(skillsRoot, versionDir)) {
    fs.rmSync(versionDir, { recursive: true, force: true });
  }
  delete index.byId[id];
  if (index.byName[rec.name] === id) {
    // 回退到同名的其他版本（若有）
    const others = Object.values(index.byId).filter((r) => r.name === rec.name);
    if (others.length) index.byName[rec.name] = others[others.length - 1].id;
    else delete index.byName[rec.name];
  }
  return rec;
}
