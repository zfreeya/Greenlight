/* Harness Desktop 工具执行服务（零依赖 Node ESM）
 *
 * 桌面端 Agent 的工具后端：模型发出 tool_calls 后由前端转发到这里真实执行。
 * 能力对齐 deepseek-harness 关键工具集：bash / read / write / edit / glob / grep / fetch。
 *
 * 运行：node tools-server/index.mjs [--workspace <dir>] [--port <n>]
 *   环境变量：DSH_TOOLS_WORKSPACE / DSH_TOOLS_PORT（命令行优先）
 *
 * 安全边界（本地个人 Agent）：
 *   - fs 类工具（read/write/edit/glob/grep）只能访问 workspace 目录树；
 *   - bash 以 workspace 为 cwd，可 cd 到任何本机路径（与 dsh 本地 bash 行为一致）；
 *   - 单命令超时与输出截断有硬上限。
 */
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createApp } from "./lib/app.js";
import { skillsRoutes } from "./lib/skills-api.js";

/* Harness 能力后端（Skill / MCP / Capability / Permission）共享上下文 */
const app = createApp();

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const PORT = Number(argValue("--port", process.env.DSH_TOOLS_PORT ?? "8450"));
const WORKSPACE = path.resolve(argValue("--workspace", process.env.DSH_TOOLS_WORKSPACE ?? path.join(os.homedir(), "Harness")));
fs.mkdirSync(WORKSPACE, { recursive: true });

const MAX_BASH_OUTPUT = 30000;
const MAX_FETCH_BYTES = 300000;
const MAX_READ_LINES = 2000;

/* ---------- 工具实现 ---------- */

function resolveInWorkspace(p) {
  const abs = path.resolve(WORKSPACE, p);
  const rel = path.relative(WORKSPACE, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`路径越界：仅允许访问工作目录 ${WORKSPACE}`);
  return abs;
}

function readFile(p, offset = 1, limit = MAX_READ_LINES) {
  const abs = resolveInWorkspace(p);
  if (!fs.existsSync(abs)) throw new Error(`文件不存在：${p}`);
  if (fs.statSync(abs).isDirectory()) throw new Error(`是目录不是文件：${p}`);
  const text = fs.readFileSync(abs, "utf8");
  const lines = text.split("\n");
  const start = Math.max(1, Number(offset) || 1);
  const count = Math.max(1, Math.min(Number(limit) || MAX_READ_LINES, MAX_READ_LINES));
  const slice = lines.slice(start - 1, start - 1 + count).map((t, i) => ({ number: start + i, text: t }));
  return { path: abs, offset: start, totalLines: lines.length, lines: slice };
}

function writeFile(p, content) {
  const abs = resolveInWorkspace(p);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const existed = fs.existsSync(abs);
  fs.writeFileSync(abs, content, "utf8");
  return { path: abs, operation: existed ? "update" : "create", bytes: Buffer.byteLength(content) };
}

function editFile(p, oldStr, newStr, replaceAll = false) {
  const abs = resolveInWorkspace(p);
  if (!fs.existsSync(abs)) throw new Error(`文件不存在：${p}`);
  const before = fs.readFileSync(abs, "utf8");
  const idx = before.indexOf(oldStr);
  if (idx < 0) throw new Error(`未找到要替换的文本（old_string 不匹配）`);
  if (!replaceAll && before.indexOf(oldStr, idx + oldStr.length) >= 0) throw new Error(`old_string 出现多次，请提供更精确的上下文或设置 replace_all=true`);
  const after = replaceAll ? before.split(oldStr).join(newStr) : before.slice(0, idx) + newStr + before.slice(idx + oldStr.length);
  fs.writeFileSync(abs, after, "utf8");
  return { path: abs, before, after };
}

function globToRegExp(pattern) {
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") { i++; re += "(?:.*/)?"; }
        else re += ".*";
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(re + "$");
}

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
}

function glob(pattern, base = ".") {
  const absBase = resolveInWorkspace(base);
  const re = globToRegExp(pattern);
  const hasSlash = pattern.includes("/");
  const files = [];
  walk(absBase, files);
  const out = files
    .map((f) => path.relative(absBase, f))
    .filter((f) => (hasSlash ? re.test(f) : re.test(path.basename(f))))
    .sort();
  return { root: absBase, paths: out };
}

function grep(pattern, base = ".", include = "") {
  const absBase = resolveInWorkspace(base);
  let re;
  try { re = new RegExp(pattern); } catch (e) { throw new Error(`正则无效：${e.message}`); }
  const incRe = include ? globToRegExp(include) : null;
  const files = [];
  walk(absBase, files);
  const matches = [];
  for (const f of files) {
    const rel = path.relative(absBase, f);
    if (incRe && !incRe.test(rel)) continue;
    let text;
    try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
    text.split("\n").forEach((line, i) => {
      if (re.test(line)) matches.push({ path: rel, lineNumber: i + 1, line: line.slice(0, 400) });
    });
    if (matches.length >= 250) break;
  }
  return { matches: matches.slice(0, 250) };
}

function runBash(command, timeoutMs = 60000) {
  const t = Math.min(Math.max(Number(timeoutMs) || 60000, 1000), 300000);
  return new Promise((resolve) => {
    const child = spawn("/bin/bash", ["-lc", command], { cwd: WORKSPACE, env: process.env });
    let out = "", err = "";
    const cap = (buf, s) => { s += buf.toString(); return s.length > MAX_BASH_OUTPUT ? s.slice(0, MAX_BASH_OUTPUT) : s; };
    const kill = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, t);
    child.stdout.on("data", (b) => { out = cap(b, out); });
    child.stderr.on("data", (b) => { err = cap(b, err); });
    child.on("close", (code, signal) => {
      clearTimeout(kill);
      resolve({ exitCode: code, signal, stdout: out.slice(-MAX_BASH_OUTPUT), stderr: err.slice(-MAX_BASH_OUTPUT) });
    });
    child.on("error", (e) => resolve({ exitCode: null, signal: null, stdout: out, stderr: String(e) }));
  });
}

async function fetchUrl(url) {
  const u = new URL(url);
  if (!["http:", "https:"].includes(u.protocol)) throw new Error(`不支持的协议：${u.protocol}`);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(u, { signal: ctrl.signal, redirect: "follow", headers: { "User-Agent": "harness-desktop/0.1" } });
    const buf = Buffer.from(await res.arrayBuffer());
    const body = buf.subarray(0, MAX_FETCH_BYTES).toString("utf8");
    return { status: res.status, contentType: res.headers.get("content-type") ?? "", bytes: buf.length, text: body };
  } finally {
    clearTimeout(t);
  }
}

/* ---------- HTTP 服务 ---------- */

const json = (res, code, obj) => {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(obj));
};

/* 预览静态服务：GET /preview/<相对路径>，仅工作目录内，no-store 便于改完即刷新 */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

const routes = {
  "/bash": (body) => runBash(String(body.command ?? ""), body.timeoutMs),
  "/read": (body) => readFile(String(body.path ?? ""), body.offset, body.limit),
  "/write": (body) => writeFile(String(body.path ?? ""), String(body.content ?? "")),
  "/edit": (body) => editFile(String(body.path ?? ""), String(body.old_string ?? ""), String(body.new_string ?? ""), Boolean(body.replace_all)),
  "/glob": (body) => glob(String(body.pattern ?? "**/*"), String(body.path ?? ".")),
  "/grep": (body) => grep(String(body.pattern ?? ""), String(body.path ?? "."), String(body.include ?? "")),
  "/fetch": (body) => fetchUrl(String(body.url ?? "")),
  ...skillsRoutes(app),
};

http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST,GET,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
    res.end();
    return;
  }
  if (req.method === "GET" && req.url === "/health") return json(res, 200, { status: "ok", workspace: WORKSPACE, pid: process.pid });
  if (req.method === "GET" && req.url && new URL(req.url, "http://127.0.0.1").pathname.startsWith("/preview/")) {
    // 用 pathname 解析：前端会带 ?t= 缓存戳，必须剥离 query
    const pathname = new URL(req.url, "http://127.0.0.1").pathname;
    const rel = decodeURIComponent(pathname.slice("/preview/".length));
    try {
      let abs = resolveInWorkspace(rel);
      if (fs.statSync(abs).isDirectory()) abs = path.join(abs, "index.html");
      const buf = fs.readFileSync(abs);
      // HTTP Range（WebKit 视频/音频播放必需）
      const total = buf.length;
      const range = req.headers.range;
      const m = range && /^bytes=(\d*)-(\d*)$/.exec(range);
      const base = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
      const mime = MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream";
      if (m && (m[1] || m[2])) {
        let start = m[1] ? parseInt(m[1], 10) : null;
        let end = m[2] ? parseInt(m[2], 10) : null;
        if (start === null) { const n = end ?? 0; start = Math.max(0, total - n); end = total - 1; }
        else { if (end === null || end >= total) end = total - 1; }
        if (start > end || start >= total) { res.writeHead(416, { ...base, "Content-Range": "bytes */" + total }); return res.end(); }
        res.writeHead(206, { ...base, "Content-Type": mime, "Content-Length": end - start + 1, "Content-Range": "bytes " + start + "-" + end + "/" + total, "Accept-Ranges": "bytes" });
        return res.end(buf.subarray(start, end + 1));
      }
      res.writeHead(200, { ...base, "Content-Type": mime, "Content-Length": total, "Accept-Ranges": "bytes" });
      res.end(buf);
    } catch {
      json(res, 404, { error: "预览文件不存在：" + rel });
    }
    return;
  }
  if (req.method === "GET" && req.url === "/info") return json(res, 200, { workspace: WORKSPACE, cwd: WORKSPACE, tools: Object.keys(routes) });
  if (req.method === "POST" && routes[req.url]) {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 2_000_000) req.destroy(); });
    req.on("end", async () => {
      let body = {};
      try { body = JSON.parse(raw || "{}"); } catch { return json(res, 400, { error: "请求体不是合法 JSON" }); }
      try {
        const out = await routes[req.url](body);
        json(res, 200, out);
      } catch (e) {
        json(res, 200, { error: String(e.message ?? e) });
      }
    });
    return;
  }
  json(res, 404, { error: "未知端点" });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`[tools-server] listening on http://127.0.0.1:${PORT} workspace=${WORKSPACE}`);
});