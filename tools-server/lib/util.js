/**
 * 通用工具：路径安全、id 生成、JSON 持久化存储。
 * 零框架，Node ESM，供 skill / mcp / capability / permission / run 模块共用。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** 生成短随机 id（runId / approvalId / toolCallId） */
export function newId(prefix = "id") {
  return `${prefix}-${crypto.randomBytes(8).toString("hex")}`;
}

/** 生成内容寻址 id（skill 安装实例等） */
export function contentId(...parts) {
  const h = crypto.createHash("sha1").update(parts.join("|")).digest("hex");
  return h.slice(0, 12);
}

/**
 * 判定 child 是否严格位于 root 内（不允许 root 本身、不允许 `..` 逃逸）。
 * @returns {boolean}
 */
export function isInside(root, child) {
  const r = path.resolve(root);
  const c = path.resolve(child);
  const rel = path.relative(r, c);
  if (rel === "") return false;
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return false;
  return true;
}

/** 递归创建目录（sync） */
export function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * 读 JSON 文件；不存在或损坏时返回 fallback。
 * @template T
 * @param {string} file
 * @param {T} fallback
 * @returns {T}
 */
export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** 原子写 JSON：先写临时文件再 rename，避免半写损坏。 */
export function writeJson(file, value) {
  mkdirp(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

/** 读取 UTF-8 文本文件，失败返回 null */
export function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * 校验文件名安全（解包/安装用）：拒绝绝对路径、`..`、空字节、路径分隔符。
 */
export function assertSafeRelativeName(name) {
  if (typeof name !== "string" || name.length === 0) throw new Error("非法路径名");
  if (name.includes("\0")) throw new Error("路径包含空字节");
  if (path.isAbsolute(name)) throw new Error("拒绝绝对路径");
  const normalized = name.replace(/\\/g, "/");
  if (normalized.split("/").includes("..")) throw new Error("路径包含 .. 逃逸");
  return normalized;
}

let _segmenter;
function segmenter() {
  _segmenter ??= new Intl.Segmenter("zh", { granularity: "word" });
  return _segmenter;
}

/**
 * 中英文混合分词：用 Intl.Segmenter(word) 做中文分词，英文/数字按词切分。
 * 丢弃单字中文（噪声大、无检索价值）。供描述匹配/检索。
 */
export function tokenize(text) {
  if (!text) return [];
  const tokens = [];
  for (const part of segmenter().segment(String(text))) {
    if (!part.isWordLike) continue;
    const t = part.segment.trim().toLowerCase();
    if (!/[\p{L}\p{N}]/u.test(t)) continue;
    if (/^[\p{Script=Han}]$/u.test(t)) continue; // 单字中文丢弃
    tokens.push(t);
  }
  return tokens;
}
