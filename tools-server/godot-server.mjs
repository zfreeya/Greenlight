/* Godot 能力侧车（零依赖 Node ESM） */
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}
const PORT = Number(argValue("--port", process.env.DSH_GODOT_PORT ?? "8455"));
const WORKSPACE = path.resolve(argValue("--workspace", process.env.DSH_TOOLS_WORKSPACE ?? path.join(os.homedir(), "Harness")));
const PROJ_ROOT = path.join(WORKSPACE, "godot");
const RUNTIME_STORE = path.join(PROJ_ROOT, "runtime-selection.json");
fs.mkdirSync(PROJ_ROOT, { recursive: true });

function candidatePaths() {
  const home = os.homedir();
  const c = [];
  if (process.platform === "darwin") {
    c.push("/Applications/Godot.app/Contents/MacOS/Godot", "/Applications/Godot_mono.app/Contents/MacOS/Godot",
      path.join(home, "Applications/Godot.app/Contents/MacOS/Godot"), path.join(home, "Applications/Godot_mono.app/Contents/MacOS/Godot"),
      "/opt/homebrew/bin/godot", "/usr/local/bin/godot", "/opt/homebrew/bin/godot4", "/usr/local/bin/godot4");
  } else if (process.platform === "win32") {
    c.push("C:\\Godot\\Godot.exe", "C:\\Program Files\\Godot\\Godot.exe");
  } else {
    c.push("/usr/bin/godot", "/usr/local/bin/godot", path.join(home, "godot/godot"));
  }
  for (const p of (process.env.PATH || "").split(path.delimiter)) { if (p) { c.push(path.join(p, "godot"), path.join(p, "godot4")); } }
  return [...new Set(c)];
}

function parseVersion(out) {
  const m = (out || "").match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: m[3] ? Number(m[3]) : 0, raw: (out || "").split("\n")[0].slice(0, 60) };
}

function runtimeInfo(p) {
  if (!p || !fs.existsSync(p)) return null;
  return new Promise((resolve) => {
    const child = spawn(p, ["--version"], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve(null); }, 8000);
    child.on("error", () => { clearTimeout(t); resolve(null); });
    child.on("close", (code) => {
      clearTimeout(t);
      const v = parseVersion(out);
      if (code === 0 && v) resolve({ path: p, version: v.raw, major: v.major, minor: v.minor, patch: v.patch, mono: /mono/i.test(out), platform: process.platform });
      else resolve(null);
    });
  });
}

async function detectRuntime() {
  const candidates = candidatePaths();
  for (const p of candidates) {
    const info = await runtimeInfo(p);
    if (info) return { found: true, runtime: info, candidates };
  }
  return { found: false, runtime: null, candidates };
}

function loadSelection() { try { return JSON.parse(fs.readFileSync(RUNTIME_STORE, "utf8")); } catch { return null; } }
function saveSelection(sel) { fs.writeFileSync(RUNTIME_STORE, JSON.stringify(sel, null, 2)); return sel; }

let cachedRuntime = null;
async function resolveRuntime() {
  if (cachedRuntime && fs.existsSync(cachedRuntime.path)) return cachedRuntime;
  const sel = loadSelection();
  if (sel && fs.existsSync(sel.path)) { cachedRuntime = sel; return sel; }
  const det = await detectRuntime();
  cachedRuntime = det.runtime;
  return det.runtime;
}

function projectDir(projectId) { return path.join(PROJ_ROOT, String(projectId)); }

function readProject(projectId) {
  const dir = projectDir(projectId);
  const gd = path.join(dir, "project.godot");
  if (!fs.existsSync(gd)) return { ok: false, code: "missing_project_file", dir };
  let name = "", mainScene = "", features = "", version = "";
  for (const line of fs.readFileSync(gd, "utf8").split("\n")) {
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim().replace(/^"|"$/g, "");
    if (k === "config/name") name = v;
    if (k === "run/main_scene") mainScene = v;
    if (k === "config/features") features = v;
    if (k === "config/version") version = v;
  }
  const files = walk(dir);
  const scenes = files.filter((f) => /\.tscn$/.test(f)).map((f) => path.relative(dir, f)).sort();
  const scripts = files.filter((f) => /\.gd$/.test(f)).map((f) => path.relative(dir, f)).sort();
  const assets = files.filter((f) => !/\.tscn$/.test(f) && !/\.gd$/.test(f) && !/\.godot$/.test(f)).map((f) => path.relative(dir, f)).sort();
  const wsBase = path.relative(WORKSPACE, dir);
  return { ok: true, dir, path: wsBase, name, mainScene, features, version, scenes, scripts, assets, wsScenes: scenes.map((s) => wsBase + "/" + s), wsScripts: scripts.map((s) => wsBase + "/" + s) };
}

function walk(dir, out = []) {
  let e;
  try { e = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const x of e) {
    if (x.name === ".godot" || x.name === "node_modules") continue;
    const p = path.join(dir, x.name);
    if (x.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

function sceneNodeTree(tscnPath) {
  let txt;
  try { txt = fs.readFileSync(tscnPath, "utf8"); } catch { return []; }
  const nodes = [];
  for (const line of txt.split("\n")) {
    const m = line.match(/^\[node name="([^"]+)" type="([^"]+)"(?: parent="([^"]+)")?/);
    if (m) nodes.push({ name: m[1], type: m[2], parent: m[3] || null });
  }
  return nodes;
}

/* 项目作用域文件读写（相对项目目录，拒绝越界） */
function resolveProjectFile(projectId, relPath) {
  const dir = projectDir(projectId);
  const abs = path.resolve(dir, String(relPath || ""));
  const rel = path.relative(dir, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("路径越界：仅允许访问项目目录内文件");
  return abs;
}
function readProjectFile(projectId, relPath) {
  const abs = resolveProjectFile(projectId, relPath);
  if (!fs.existsSync(abs)) throw new Error("文件不存在：" + relPath);
  const lines = fs.readFileSync(abs, "utf8").split("\n");
  return { path: relPath, totalLines: lines.length, lines: lines.map((txt, i) => ({ number: i + 1, text: txt })) };
}
function writeProjectFile(projectId, relPath, content) {
  const abs = resolveProjectFile(projectId, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const existed = fs.existsSync(abs);
  fs.writeFileSync(abs, String(content ?? ""), "utf8");
  return { path: relPath, operation: existed ? "update" : "create" };
}
function editProjectFile(projectId, relPath, oldStr, newStr, replaceAll) {
  const abs = resolveProjectFile(projectId, relPath);
  const before = fs.readFileSync(abs, "utf8");
  const idx = before.indexOf(oldStr);
  if (idx < 0) throw new Error("未找到要替换的文本");
  if (!replaceAll && before.indexOf(oldStr, idx + oldStr.length) >= 0) throw new Error("old_string 出现多次，请提供更精确上下文或 replace_all=true");
  const after = replaceAll ? before.split(oldStr).join(newStr) : before.slice(0, idx) + newStr + before.slice(idx + oldStr.length);
  fs.writeFileSync(abs, after, "utf8");
  return { path: relPath, before, after };
}
/* GDScript 错误解析：从日志里提取 文件/行/错误 结构 */
function parseErrors(logs) {
  const errors = [];
  for (const l of logs || []) {
    // Godot 错误格式：SCRIPT ERROR / ERROR / Parse Error / WARNING
    const m = l.text.match(/(?:SCRIPT ERROR|ERROR):\s*(.*)/i);
    if (m) {
      const loc = l.text.match(/([\w./-]+\.(?:gd|tscn|scn))\s*[:]\s*(\d+)/);
      errors.push({ level: "error", message: m[1].slice(0, 300), file: loc ? loc[1] : null, line: loc ? Number(loc[2]) : null });
    } else if (/Parse Error/i.test(l.text)) {
      errors.push({ level: "error", message: l.text.slice(0, 300), file: null, line: null });
    } else if (/WARNING:/i.test(l.text)) {
      errors.push({ level: "warning", message: l.text.slice(0, 300), file: null, line: null });
    }
  }
  return errors.slice(0, 50);
}

const processes = new Map();
function logLine(projectId, stream, text) {
  const p = processes.get(projectId);
  if (!p) return;
  for (const l of text.split("\n")) if (l.trim()) p.logs.push({ stream, t: Date.now(), text: l });
  if (p.logs.length > 500) p.logs = p.logs.slice(-500);
}

async function startGodot(projectId, taskId, scene) {
  const dir = projectDir(projectId);
  if (!fs.existsSync(path.join(dir, "project.godot"))) return { ok: false, code: "missing_project_file" };
  const det = await resolveRuntime();
  if (!det) return { ok: false, code: "runtime_missing", hint: "未找到 Godot 运行时。请在 Harness 中检测或手动选择 Godot 可执行文件。" };
  if (processes.get(projectId)?.status === "running") return { ok: false, code: "already_running" };
  const args = ["--path", dir];
  if (scene) args.push(scene);
  const child = spawn(det.path, args, { env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  const rec = { child, logs: [], startedAt: Date.now(), status: "running", exit: null, taskId, scene };
  processes.set(projectId, rec);
  child.stdout.on("data", (d) => logLine(projectId, "out", d.toString()));
  child.stderr.on("data", (d) => logLine(projectId, "err", d.toString()));
  child.on("error", (e) => { rec.status = "crashed"; rec.logs.push({ stream: "err", t: Date.now(), text: String(e) }); });
  child.on("close", (code, signal) => {
    rec.status = rec.userStopped || code === 0 ? "stopped" : "crashed";
    rec.exit = { code, signal };
    if (!rec.userStopped && code !== 0) rec.logs.push({ stream: "err", t: Date.now(), text: "进程退出码 " + code + (signal ? " signal " + signal : "") });
  });
  return { ok: true, pid: child.pid, scene: scene || "（默认主场景）" };
}

function stopGodot(projectId) {
  const rec = processes.get(projectId);
  if (!rec || rec.status !== "running") return { ok: true, code: "not_running" };
  rec.userStopped = true;
  try { process.kill(-rec.child.pid, "SIGTERM"); } catch { try { rec.child.kill("SIGTERM"); } catch {} }
  setTimeout(() => { if (rec.status === "running") { try { process.kill(-rec.child.pid, "SIGKILL"); } catch {} } }, 2000);
  return { ok: true };
}

function createProject(projectId, name) {
  const dir = projectDir(projectId);
  fs.mkdirSync(path.join(dir, "scenes"), { recursive: true });
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  const pname = name || "platformer";
  fs.writeFileSync(path.join(dir, "project.godot"), [
    "; Engine configuration file.",
    "config_version=5",
    "",
    "[application]",
    'config/name="' + pname + '"',
    'run/main_scene="res://scenes/main.tscn"',
    'config/features=PackedStringArray("4.3")',
    'config/icon="res://icon.svg"',
    "",
    "[display]",
    "window/size/viewport_width=1152",
    "window/size/viewport_height=648",
    'window/stretch/mode="canvas_items"',
    "",
    "[rendering]",
    'renderer/rendering_method="gl_compatibility"',
    'renderer/rendering_method.mobile="gl_compatibility"',
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "scenes", "main.tscn"), [
    "[gd_scene load_steps=3 format=3]",
    "",
    '[ext_resource type="Script" path="res://scripts/main.gd" id="1"]',
    "",
    '[node name="Main" type="Node2D"]',
    'script = ExtResource("1")',
    "",
    '[node name="Player" type="CharacterBody2D" parent="."]',
    "position = Vector2(576, 500)",
    "",
    '[node name="Sprite" type="Sprite2D" parent="Player"]',
    "",
    '[node name="Collision" type="CollisionShape2D" parent="Player"]',
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "scripts", "main.gd"), [
    "extends Node2D",
    "",
    "# 2D 平台跳跃基础：角色左右移动 + 二段跳 + 重力/落地",
    "const SPEED := 320.0",
    "const JUMP_VELOCITY := -560.0",
    "const GRAVITY := 1400.0",
    "const FALL_MULTIPLIER := 1.6  # 落地更快（下坠加速）",
    "",
    "var velocity := Vector2.ZERO",
    "var jumps_left := 2",
    "",
    "func _physics_process(delta: float) -> void:",
    "    var player := $Player as CharacterBody2D",
    "    if not is_on_floor(player):",
    "        velocity.y += GRAVITY * (FALL_MULTIPLIER if velocity.y > 0 else 1.0) * delta",
    "    else:",
    "        jumps_left = 2",
    "        velocity.y = 0",
    '    var dir := Input.get_axis("ui_left", "ui_right")',
    "    velocity.x = dir * SPEED",
    '    if Input.is_action_just_pressed("ui_accept") and jumps_left > 0:',
    "        velocity.y = JUMP_VELOCITY",
    "        jumps_left -= 1",
    "    player.velocity = velocity",
    "    player.move_and_slide()",
    "",
    "func is_on_floor(player: CharacterBody2D) -> bool:",
    "    return player.is_on_floor()",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="#3F6D9C"/></svg>');
  return readProject(projectId);
}

const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }); res.end(JSON.stringify(obj)); };
const routes = {
  "/detect": async () => detectRuntime(),
  "/select": async (b) => {
    const p = String(b.path || "");
    if (!p) return { ok: false, code: "empty_path" };
    const info = await runtimeInfo(p);
    if (!info) return { ok: false, code: "invalid_runtime", hint: "路径不存在、不可执行，或 --version 无法识别版本。" };
    saveSelection(info);
    return { ok: true, runtime: info };
  },
  "/create": async (b) => { const r = createProject(String(b.projectId || "p1"), String(b.name || "")); return { ok: true, project: r }; },
  "/import": async (b) => {
    const dir = String(b.path || "");
    if (!fs.existsSync(path.join(dir, "project.godot"))) return { ok: false, code: "missing_project_file", hint: "目录缺少 project.godot" };
    return { ok: true, project: { dir } };
  },
  "/inspect": async (b) => readProject(String(b.projectId || "p1")),
  "/scenes": async (b) => {
    const r = readProject(String(b.projectId || "p1"));
    if (!r.ok) return r;
    const main = r.mainScene ? path.join(r.dir, r.mainScene.replace("res://", "")) : null;
    return { ok: true, scenes: r.scenes, scripts: r.scripts, mainScene: r.mainScene, tree: main ? sceneNodeTree(main) : [] };
  },
  "/validate": async (b) => {
    const r = readProject(String(b.projectId || "p1"));
    const issues = [];
    if (!r.ok) issues.push({ code: "missing_project_file", level: "error", msg: "缺少 project.godot" });
    else {
      if (!r.mainScene) issues.push({ code: "missing_main_scene", level: "error", msg: "未设置主场景（run/main_scene）" });
      else if (!fs.existsSync(path.join(r.dir, r.mainScene.replace("res://", "")))) issues.push({ code: "main_scene_not_found", level: "error", msg: "主场景文件不存在：" + r.mainScene });
      const sel = await resolveRuntime();
      if (!sel) issues.push({ code: "runtime_missing", level: "error", msg: "未检测到 Godot 运行时（不影响项目文件，但无法运行）" });
    }
    return { ok: true, projectId: String(b.projectId || "p1"), valid: issues.filter((i) => i.code !== "runtime_missing").length === 0, issues };
  },
  "/run": async (b) => startGodot(String(b.projectId || "p1"), String(b.taskId || ""), b.scene ? String(b.scene) : ""),
  "/stop": async (b) => stopGodot(String(b.projectId || "p1")),
  "/restart": async (b) => { stopGodot(String(b.projectId || "p1")); return startGodot(String(b.projectId || "p1"), String(b.taskId || ""), b.scene ? String(b.scene) : ""); },
  "/status": async (b) => {
    const pid = String(b.projectId || "p1");
    const rec = processes.get(pid);
    const sel = await resolveRuntime();
    return { game: rec?.status ?? "stopped", pid: rec?.child?.pid ?? null, scene: rec?.scene ?? null, startedAt: rec?.startedAt ?? null, runtime: sel, errors: parseErrors(rec?.logs ?? []), logs: (rec?.logs ?? []).slice(-40).map((l) => ({ stream: l.stream, t: l.t, text: l.text })) };
  },
  "/export-web": async (b) => {
    const sel = await resolveRuntime();
    if (!sel) return { ok: false, code: "runtime_missing", hint: "需要 Godot 运行时才能导出 Web。" };
    const v = sel.major + "." + sel.minor + (sel.patch ? "." + sel.patch : "");
    const base = process.platform === "win32" ? path.join(os.homedir(), "AppData", "Roaming", "Godot", "export_templates", v) : path.join(os.homedir(), ".local", "share", "godot", "export_templates", v);
    const hasWeb = fs.existsSync(path.join(base, "web_dlink_debug.zip")) || fs.existsSync(path.join(base, "web_debug.zip"));
    if (!hasWeb) return { ok: false, code: "missing_templates", hint: "缺少 Web 导出模板（" + base + "）。需通过 Godot 官方或编辑器安装后重试。" };
    return { ok: false, code: "not_implemented", hint: "已检测到导出模板，但当前受控导出通道将在后续版本实现。" };
  },
  "/diagnostics": async (b) => {
    const pid = String(b.projectId || "p1");
    const rec0 = processes.get(pid);
    return { project: readProject(pid), runtime: (await resolveRuntime()), game: rec0?.status ?? "stopped", errors: parseErrors(rec0?.logs ?? []), logs: (rec0?.logs ?? []).slice(-60).map((l) => ({ stream: l.stream, t: l.t, text: l.text })) };
  },
  "/capture": async () => ({ ok: false, code: "unsupported_native", hint: "原生运行模式不支持截图；Web 预览模式可直接查看当前画面。" }),
  "/read-file": async (b) => readProjectFile(String(b.projectId || "p1"), String(b.path || "")),
  "/write-file": async (b) => writeProjectFile(String(b.projectId || "p1"), String(b.path || ""), b.content),
  "/edit-file": async (b) => editProjectFile(String(b.projectId || "p1"), String(b.path || ""), String(b.old_string || ""), String(b.new_string || ""), Boolean(b.replace_all)),
};

http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST,GET,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }); res.end(); return; }
  if (req.method === "GET" && req.url === "/health") {
    const sel = loadSelection();
    return json(res, 200, { status: "ok", workspace: WORKSPACE, runtime: (await resolveRuntime()), engineStatus: (await resolveRuntime()) ? "ready" : "unavailable", active: [...processes.keys()].filter((k) => processes.get(k)?.status === "running") });
  }
  if (req.method === "POST" && routes[req.url]) {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 2_000_000) req.destroy(); });
    req.on("end", async () => {
      let body = {};
      try { body = JSON.parse(raw || "{}"); } catch { return json(res, 400, { error: "请求体不是合法 JSON" }); }
      try { return json(res, 200, await routes[req.url](body)); }
      catch (e) { return json(res, 200, { ok: false, code: "internal_error", error: String(e?.message ?? e) }); }
    });
    return;
  }
  json(res, 404, { error: "未知端点" });
}).listen(PORT, "127.0.0.1", () => {
  console.log("[godot-server] listening on http://127.0.0.1:" + PORT + " workspace=" + WORKSPACE);
});