import { useEffect, useRef, useState, useCallback } from "react";
import { Thread, Msg, Todo, Deliverable, AgentStatus, ExecMode, EXEC_MODES, newThread, greetingMsg, now } from "./state";
import {
  MemoryConfig, loadMemoryConfig, saveMemoryConfig,
  recallMemory, commitMemory, chatCompletion, LlmToolCall,
} from "./memory";

/* ================= Toast ================= */
export interface ToastItem { id: number; kind: string; title: string; msg?: string }
let toastId = 1;

export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const push = useCallback((kind: string, title: string, msg?: string) => {
    const id = toastId++;
    setToasts((t) => [...t, { id, kind, title, msg }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);
  return { toasts, push };
}

/* ================= 工具服务配置 ================= */
export interface ToolsConfig { url: string; workspace?: string }
const LS_TOOLS = "harness.tools.config";
export function defaultToolsConfig(): ToolsConfig { return { url: "http://127.0.0.1:8450" }; }
export function loadToolsConfig(): ToolsConfig {
  try {
    const raw = localStorage.getItem(LS_TOOLS);
    if (raw) return { ...defaultToolsConfig(), ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return defaultToolsConfig();
}
export function saveToolsConfig(cfg: ToolsConfig) { localStorage.setItem(LS_TOOLS, JSON.stringify(cfg)); }

/* ================= 系统提示（直接回答 + 真实工具） ================= */
const SYSTEM_PROMPT = [
  "你是 DeepSeek Harness 桌面助手，一个能真实动手的编程与任务执行 Agent。你有一整套真实工具：",
  "bash（在工作目录运行 shell 命令）、read/write/edit（读写修改文件）、glob/grep（查找文件与代码）、fetch（抓取网页）、todo_write（维护任务清单）。",
  "行为准则：",
  "1. 严谨第一：先核实再下结论，不猜测、不编造；回答必须引用真实输出与证据。直接回答用户的问题，不绕弯子、不重复问候；凡是能用工具验证的（跑命令、看代码、读仓库、抓网页），先动手拿到真实结果再回答，不要空谈。改动文件前先读现状、说明要改什么，改完给出真实结果。",
  "2. 只有信息确实不足以动手时才问澄清问题，一次只问一个；需要用户在几个选项里选时，最后一行输出 [OPTIONS: 选项A | 选项B | 选项C]。",
  "3. 复杂任务（三步以上）先调用 todo_write 列出计划，再逐步执行；执行中简短汇报，完成后一句话总结真实结果。",
  "4. 用户明确要求输出 [PLAN] 计划或 [OPTIONS] 选项格式时必须严格遵守。",
  "5. 中文回复，简洁具体，引用真实输出，不要寒暄客套。",
  "6. 回复使用 Markdown 排版：要点用列表、重点加粗、代码与命令输出用代码块，让回答清晰易读。",
  "7. 你创建的 .html 网页/游戏会自动出现在右侧预览面板（harness.local）并自动打开，完成后提示「已在右侧预览打开」；不要建议用户双击文件或手动起服务器。",
  "8. 本机已安装 Godot 运行时。用户要求做游戏（2D/3D）时，优先用 Godot 工具链：先 detect_godot_runtime 确认，再 create_godot_project 创建项目、run_godot_project 运行。只有 detect 明确返回未找到时才可降级为网页 Canvas，并在回复里说明原因。",
  "9. 严禁用 bash 全盘搜索（如 find / -name godot*、which/whereis 遍历 PATH）来定位或检测 Godot 运行时；运行时检测一律用 detect_godot_runtime 结构化工具。",
  "10. 复杂游戏按分层推进：先做一个能玩的最小核心，再逐轮加系统（每轮可试玩）。项目文件用 read_godot_script / write_godot_script / edit_godot_script 读写（相对项目目录），不用 bash cat/sed。运行游戏后用 collect_godot_diagnostics 读取结构化错误（含文件与行号），定位后 edit_godot_script 修复，再 restart_godot_game。一次只改一个系统，改完即验证。",
].join("\n");

/* ================= 工具定义（对齐 deepseek-harness 关键工具） ================= */
function buildTools() {
  const str = (description: string) => ({ type: "string", description });
  return [
    { type: "function", function: { name: "bash", description: "在工作目录运行 shell 命令并返回 stdout/stderr。用于运行代码、测试、构建、浏览代码仓库（ls/cat/find/git）等。", parameters: { type: "object", properties: { command: str("要执行的 bash 命令，如 ls -la 或 node test.js") }, required: ["command"] } } },
    { type: "function", function: { name: "read", description: "读取工作目录内的文本文件，返回带行号的内容。", parameters: { type: "object", properties: { path: str("相对工作目录的文件路径"), offset: { type: "integer", description: "起始行号，默认 1" }, limit: { type: "integer", description: "最多返回行数，默认 2000" } }, required: ["path"] } } },
    { type: "function", function: { name: "write", description: "创建或整体覆盖工作目录内的文件。", parameters: { type: "object", properties: { path: str("相对工作目录的文件路径"), content: str("完整文件内容") }, required: ["path", "content"] } } },
    { type: "function", function: { name: "edit", description: "对现有文件做精准文本替换。old_string 必须与文件内容完全一致且唯一（除非 replace_all=true）。", parameters: { type: "object", properties: { path: str("相对工作目录的文件路径"), old_string: str("要被替换的原文"), new_string: str("替换后的新文本"), replace_all: { type: "boolean", description: "是否替换全部匹配，默认 false" } }, required: ["path", "old_string", "new_string"] } } },
    { type: "function", function: { name: "create_game_spec", description: "创建或初始化游戏设计文档 GameSpec（标题、核心循环、胜负条件等）。", parameters: { type: "object", properties: { title: str("游戏标题"), spec: { type: "object", description: "GameSpec 字段（oneSentencePitch/winConditions/failConditions/coreLoop/designPillars 等）" } }, required: ["title"] } } },
    { type: "function", function: { name: "update_game_spec", description: "更新 GameSpec 并记录修改原因，版本号递增。", parameters: { type: "object", properties: { spec: { type: "object", description: "要更新或合并的字段" }, reason: str("修改原因分类"), phase: str("可选项目阶段") }, required: ["spec"] } } },
    { type: "function", function: { name: "inspect_game_spec", description: "读取当前 GameSpec 与修改历史。", parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "configure_input_map", description: "写入 Godot 输入映射。", parameters: { type: "object", properties: { actions: { type: "object", description: "动作名到 events 的映射" } }, required: ["actions"] } } },
    { type: "function", function: { name: "execute_playtest", description: "headless 启动游戏执行自动化玩法测试，返回通过/失败、事件与错误。", parameters: { type: "object", properties: { duration: { type: "integer", description: "运行秒数" } } } } },
    { type: "function", function: { name: "save_game_version", description: "保存当前项目快照为可恢复版本，返回 ts。", parameters: { type: "object", properties: { reason: str("版本原因") } } } },
    { type: "function", function: { name: "compare_game_versions", description: "比较两个版本快照的文件差异。", parameters: { type: "object", properties: { a: { type: "integer", description: "版本 ts" }, b: { type: "integer", description: "版本 ts" } }, required: ["a", "b"] } } },
    { type: "function", function: { name: "export_game_build", description: "导出可运行构建（需要导出模板）。", parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "capture_game_screenshot", description: "获取游戏截图或预览地址。", parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "glob", description: "按 glob 模式查找文件（支持 * 与 **）。", parameters: { type: "object", properties: { pattern: str("glob 模式，如 **/*.ts"), path: str("查找起点目录，默认工作目录根") }, required: ["pattern"] } } },
    { type: "function", function: { name: "grep", description: "在文件内容中按正则搜索，返回匹配行（含文件与行号）。", parameters: { type: "object", properties: { pattern: str("正则表达式"), path: str("搜索目录，默认工作目录根"), include: str("文件名过滤 glob，如 *.ts") }, required: ["pattern"] } } },
    { type: "function", function: { name: "fetch", description: "抓取一个 http/https 网页并返回文本内容（截断到 300KB）。", parameters: { type: "object", properties: { url: str("完整 URL，如 https://example.com") }, required: ["url"] } } },
    { type: "function", function: { name: "todo_write", description: "维护当前任务的待办清单。每次调用传完整清单整体替换。", parameters: { type: "object", properties: { todos: { type: "array", description: "完整待办列表", items: { type: "object", properties: { content: str("事项描述"), status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "状态" } }, required: ["content", "status"] } } }, required: ["todos"] } } },
    { type: "function", function: { name: "detect_godot_runtime", description: "检测系统中已安装的 Godot 运行时。", parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "select_godot_runtime", description: "手动选择 Godot 可执行文件路径并校验版本。", parameters: { type: "object", properties: { path: str("Godot 可执行文件的绝对路径") }, required: ["path"] } } },
    { type: "function", function: { name: "create_godot_project", description: "创建 Godot 2D 项目（生成真实 project.godot/场景/GDScript）。", parameters: { type: "object", properties: { name: str("项目名称") }, required: ["name"] } } },
    { type: "function", function: { name: "inspect_godot_project", description: "读取当前 Godot 项目：名称、主场景、场景/脚本/资源清单。", parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "list_godot_scenes", description: "列出场景与主场景节点树。", parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "validate_godot_project", description: "校验项目（project.godot/主场景/运行时）。", parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "run_godot_project", description: "运行 Godot 项目（受控子进程；无运行时则返回真实缺失错误）。", parameters: { type: "object", properties: { scene: str("可选：要运行的场景") } } } },
    { type: "function", function: { name: "run_godot_scene", description: "运行指定场景。", parameters: { type: "object", properties: { scene: str("场景路径") }, required: ["scene"] } } },
    { type: "function", function: { name: "stop_godot_game", description: "停止正在运行的 Godot 游戏进程。", parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "restart_godot_game", description: "重新运行 Godot 游戏。", parameters: { type: "object", properties: { scene: str("可选：场景") } } } },
    { type: "function", function: { name: "collect_godot_diagnostics", description: "收集 Godot 项目与运行诊断（日志/运行时/项目状态）。", parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "export_godot_web", description: "导出 Web 版本（需要 Godot 运行时与 Web 导出模板）。", parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "capture_game_preview", description: "获取游戏预览截图或预览地址。", parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "read_godot_script", description: "读取 Godot 项目内文件（相对项目目录，带行号）。", parameters: { type: "object", properties: { path: str("相对项目目录的路径，如 scripts/main.gd") }, required: ["path"] } } },
    { type: "function", function: { name: "write_godot_script", description: "创建或整体覆盖 Godot 项目内文件。", parameters: { type: "object", properties: { path: str("相对项目目录的路径"), content: str("完整内容") }, required: ["path", "content"] } } },
    { type: "function", function: { name: "edit_godot_script", description: "对 Godot 项目内文件做精准文本替换。", parameters: { type: "object", properties: { path: str("相对项目目录的路径"), old_string: str("要被替换的原文"), new_string: str("替换后的文本"), replace_all: { type: "boolean" } }, required: ["path", "old_string", "new_string"] } } },
  ];
}

/* ================= 真实 LLM + 真实工具引擎 hook ================= */
const LS_THREADS = "harness.threads.v1";
const LS_CURRENT = "harness.current.v1";
const LS_MODEL = "harness.model.v1";
const LS_WS_PREVIEWS = "harness.wsPreviews.v1";
const LS_EXEC_MODE = "harness.execMode.v1";
const LS_GODOT = "harness.godot.config";
const LS_REDUCE_MOTION = "harness.reduceMotion.v1";
const LS_MAX_THREADS = 50;
const LS_MAX_MSGS_PER_THREAD = 300;

function firstThread(): Thread {
  const t = newThread();
  t.msgs.push(greetingMsg());
  return t;
}

function normalizeThread(t: Partial<Thread>): Thread {
  const base = newThread();
  return {
    ...base, ...t,
    id: typeof t.id === "string" ? t.id : base.id,
    title: typeof t.title === "string" && t.title ? t.title : "新任务",
    kind: t.kind === "godot" || t.kind === "import_godot" || t.kind === "web" ? t.kind : "general",
    status: normalizeTaskStatus(t.status),
    agent: normalizeAgentStatus(t.agent),
    thinking: false,
    msgs: Array.isArray(t.msgs) ? t.msgs.map((m) => ({ ...m, toolStatus: m.toolStatus === "running" ? "error" : m.toolStatus })) : [],
    todos: Array.isArray(t.todos) ? t.todos : [],
    deliverables: Array.isArray(t.deliverables)
      ? (t.deliverables as Array<Partial<import("./state").Deliverable> & Record<string, unknown>>).map((d) => ({
          ...d,
          path: String(d.path ?? ""),
          name: String(d.name ?? "文件"),
          type: (d.type as string) ?? "文件",
          artifact: (d.artifact as import("./state").ArtifactStatus) ?? "ready",
          preview: (d.preview as string) === "failed" ? "loading_failed" : ((d.preview as import("./state").PreviewStatus) ?? "online"),
          error: (d.error as string | undefined) ?? ((d.state as string) === "failed" ? "预览不可用" : undefined),
          t: (d.t as number) ?? Date.now(),
        }))
      : [],
    updatedAt: typeof t.updatedAt === "number" ? t.updatedAt : Date.now(),
  };
}

function normalizeTaskStatus(s?: string): import("./state").TaskStatus {
  switch (s) {
    case "running": case "thinking": return "waiting_for_input"; // 中途刷新：执行被中断
    case "waiting_for_approval": return "waiting_for_approval";
    case "waiting_for_input": case "waiting": case "idle": case "cancelled": return "waiting_for_input";
    case "failed": case "error": return "failed";
    case "waiting_for_review": case "ready": case "done": return "waiting_for_review";
    case "completed": return "completed";
    default: return "waiting_for_input";
  }
}

function normalizeAgentStatus(s?: string): AgentStatus {
  return s === "error" ? "error" : "idle";
}

function loadThreads(): Thread[] {
  try {
    const raw = localStorage.getItem(LS_THREADS);
    if (raw) {
      const list = JSON.parse(raw);
      if (Array.isArray(list) && list.length) return list.map(normalizeThread);
    }
  } catch { /* ignore */ }
  return [firstThread()];
}

/* 模块级初始化一次：避免 StrictMode 双调用造成 id 不一致（白屏根因） */
const INITIAL_THREADS = loadThreads();

/* 内置预览页（工作目录预览标签动态追加其后） */
export const PREVIEW_PAGES = [
  { name: "Harness 官网", url: "preview-demo.html", host: "harness.local" },
  { name: "设计文档", url: "preview-docs.html", host: "docs.harness.local" },
];

export function useHarness() {
  const [threads, setThreads] = useState<Thread[]>(INITIAL_THREADS);
  const [current, setCurrentState] = useState<string>(() => {
    try { return localStorage.getItem(LS_CURRENT) || INITIAL_THREADS[0].id; } catch { return INITIAL_THREADS[0].id; }
  });
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewTab, setPreviewTab] = useState(0);
  /* 工作目录预览标签：agent 写出 .html 后自动加入并打开（harness.local）；
   * 持久化：重启 App 后标签仍在，成果卡「打开预览」不会落到 mock 页 */
  const [wsPreviews, setWsPreviews] = useState<{ path: string; name: string; t: number; threadId?: string }[]>(() => {
    try {
      const raw = localStorage.getItem(LS_WS_PREVIEWS);
      if (raw) {
        const list = JSON.parse(raw);
        if (Array.isArray(list)) return list.filter((x) => x && typeof x.path === "string").slice(0, 20);
      }
    } catch { /* ignore */ }
    return [];
  });
  const wsPreviewsRef = useRef(wsPreviews);
  wsPreviewsRef.current = wsPreviews;
  useEffect(() => {
    try { localStorage.setItem(LS_WS_PREVIEWS, JSON.stringify(wsPreviews.slice(0, 20))); } catch { /* ignore */ }
  }, [wsPreviews]);
  const [device, setDevice] = useState<"desktop" | "tablet" | "mobile">("desktop");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [model, setModelState] = useState<string>(() => {
    try { return localStorage.getItem(LS_MODEL) || "deepseek-v4-pro"; } catch { return "deepseek-v4-pro"; }
  });
  const setModel = (m: string) => { try { localStorage.setItem(LS_MODEL, m); } catch { /* ignore */ } setModelState(m); };
  const [reduceMotion, setReduceMotion] = useState<boolean>(() => {
    try { return localStorage.getItem(LS_REDUCE_MOTION) === "1"; } catch { return false; }
  });
  const setReduceMotionPersist = (v: boolean) => {
    try { localStorage.setItem(LS_REDUCE_MOTION, v ? "1" : "0"); } catch { /* ignore */ }
    setReduceMotion(v);
  };
  const [memCfg, setMemCfgState] = useState<MemoryConfig>(loadMemoryConfig);
  const [toolsCfg, setToolsCfgState] = useState<ToolsConfig>(loadToolsConfig);
  const [godotCfg, setGodotCfgState] = useState<{ url: string }>(() => {
    try { const r = localStorage.getItem(LS_GODOT); if (r) return { url: JSON.parse(r).url || "http://127.0.0.1:8455" }; } catch { /* ignore */ }
    return { url: "http://127.0.0.1:8455" };
  });
  const setGodotCfg = (c: { url: string }) => { try { localStorage.setItem(LS_GODOT, JSON.stringify(c)); } catch { /* ignore */ } setGodotCfgState(c); };
  const [mode, setModeState] = useState<ExecMode>(() => {
    try {
      const m = localStorage.getItem(LS_EXEC_MODE);
      if (m === "auto" || m === "confirm" || m === "plan-only") return m;
    } catch { /* ignore */ }
    return "auto";
  });
  const setMode = (m: ExecMode) => { try { localStorage.setItem(LS_EXEC_MODE, m); } catch { /* ignore */ } setModeState(m); };
  const setMemCfg = (cfg: MemoryConfig) => { saveMemoryConfig(cfg); setMemCfgState(cfg); };
  const setToolsCfg = (cfg: ToolsConfig) => { saveToolsConfig(cfg); setToolsCfgState(cfg); };
  const { toasts, push } = useToasts();

  /* 减弱动态效果：持久化 + 应用到文档根类 */
  useEffect(() => {
    document.documentElement.classList.toggle("reduce-motion", reduceMotion);
  }, [reduceMotion]);

  /* 工具服务工作目录展示 */
  useEffect(() => {
    fetch(toolsCfg.url + "/info").then((r) => r.json()).then((d) => {
      if (d && d.workspace) setToolsCfgState((c) => (c.workspace === d.workspace ? c : { ...c, workspace: d.workspace }));
    }).catch(() => undefined);
  }, [toolsCfg.url]);

  /* 会话持久化：每次变化落 localStorage（重开 App 不丢对话），带容量上限防止配额打满 */
  useEffect(() => {
    try {
      const capped = threads.slice(0, LS_MAX_THREADS).map((t) => ({
        ...t,
        msgs: t.msgs.slice(-LS_MAX_MSGS_PER_THREAD),
      }));
      localStorage.setItem(LS_THREADS, JSON.stringify(capped));
    } catch { /* ignore */ }
  }, [threads]);
  useEffect(() => {
    try { localStorage.setItem(LS_CURRENT, current); } catch { /* ignore */ }
  }, [current]);

  const cur = threads.find((t) => t.id === current) ?? threads[0];
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const currentRef = useRef(current);
  currentRef.current = current;
  /* 同步竞态防护：同一时刻只允许一轮 agent 循环（React 状态更新是异步的，靠 ref 兜底） */
  const busyRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const stopCtrlRef = useRef<AbortController | null>(null);
  const modeRef = useRef<ExecMode>(mode);
  modeRef.current = mode;

  const patchThread = (id: string, fn: (t: Thread) => void) => {
    setThreads((ts) =>
      ts.map((t) => {
        if (t.id !== id) return t;
        const copy: Thread = { ...t, msgs: [...t.msgs], todos: [...t.todos], deliverables: [...t.deliverables], updatedAt: Date.now() };
        fn(copy);
        return copy;
      })
    );
  };

  const pushMsg = (id: string, m: Msg) => patchThread(id, (t) => t.msgs.push(m));

  const patchMsg = (id: string, msgId: number, fn: (m: Msg) => Msg) =>
    patchThread(id, (t) => { t.msgs = t.msgs.map((m) => (m.id === msgId ? fn(m) : m)); });

  /* E2E 测试钩子：?e2e=1 时暴露消息注入（仅用于确定性 UI 渲染测试） */
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("e2e")) {
      (window as unknown as Record<string, unknown>).__e2eInject = (m: Partial<Msg> & { role: "user" | "agent" }) => {
        pushMsg(currentRef.current, { id: Date.now(), time: now(), ...m } as Msg);
      };
    }
  }, []);

  /* ---- 消息 → LLM 历史 ---- */
  const toLlmMessages = (t: Thread, recallCtx: string, godotCtx?: string) => {
    const out: { role: string; content: string }[] = [];
    let sys = SYSTEM_PROMPT;
    if (t.kind === "godot" || t.kind === "import_godot") {
      sys += "\n\n【当前任务类型：Godot 游戏】" + (godotCtx || "请先用 detect_godot_runtime 确认引擎状态。");
    }
    if (recallCtx) {
      out.push({ role: "system", content: sys + "\n\n以下是记忆系统召回的用户画像与长期偏好，请在澄清与计划中主动遵守：\n" + recallCtx });
    } else {
      out.push({ role: "system", content: sys });
    }
    for (const m of t.msgs) {
      if (m.kind === "recall" || m.kind === "tool") continue;
      if (m.role === "user") {
        out.push({ role: "user", content: m.chip ?? m.text ?? "" });
      } else if (m.kind === "plan") {
        out.push({ role: "assistant", content: "[PLAN]\n" + (m.items ?? []).map((i) => "- " + i).join("\n") });
      } else {
        out.push({ role: "assistant", content: m.text ?? "" });
      }
    }
    return out;
  };

  /* ---- 解析回复：选项 / 计划 / 纯文本 ---- */
  const parseReply = (content: string): { kind: "ask" | "plan" | "text"; text: string; opts?: string[]; items?: string[] } => {
    const optsMatch = content.match(/\[OPTIONS:\s*([^\]]+)\]/i);
    if (optsMatch) {
      const opts = optsMatch[1].split("|").map((s) => s.trim()).filter(Boolean).slice(0, 4);
      const text = content.replace(optsMatch[0], "").trim();
      return { kind: "ask", text: text || "请选择：", opts };
    }
    const planIdx = content.search(/\[PLAN\]/i);
    if (planIdx >= 0) {
      const items = content
        .slice(planIdx)
        .split("\n")
        .map((l) => l.replace(/^-\s*/, "").trim())
        .filter((l) => l && !/\[PLAN\]/i.test(l))
        .slice(0, 6);
      const text = content.slice(0, planIdx).trim();
      return { kind: "plan", text: text || "我的计划：", items };
    }
    return { kind: "text", text: content };
  };

  /* ---- 工具执行（tools-server + 本地 todo_write） ---- */
  const toolEvents = useRef<{ name: string; args: unknown; result: string; status: string }[]>([]);
  const lastToolErrorToastAt = useRef(0);
  /** 组合超时与用户停止信号的 AbortSignal */
  const anySignal = (timeoutMs: number): AbortSignal => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(new DOMException("超时", "TimeoutError")), timeoutMs);
    const onStop = () => ac.abort(stopCtrlRef.current?.signal.reason ?? new DOMException("已停止", "AbortError"));
    stopCtrlRef.current?.signal.addEventListener("abort", onStop, { once: true });
    ac.signal.addEventListener("abort", () => {
      clearTimeout(t);
      stopCtrlRef.current?.signal.removeEventListener("abort", onStop);
    }, { once: true });
    return ac.signal;
  };
  /** 执行一个工具调用；返回文本与是否失败（网络失败或服务返回业务错误） */
  const execTool = async (name: string, args: Record<string, unknown>, threadId: string): Promise<{ text: string; failed: boolean }> => {
    const godotNames = ["detect_godot_runtime","select_godot_runtime","create_godot_project","inspect_godot_project","list_godot_scenes","inspect_godot_scene","validate_godot_project","import_godot_assets","run_godot_project","run_godot_scene","stop_godot_game","restart_godot_game","export_godot_web","export_godot_build","collect_godot_diagnostics","open_godot_artifact","capture_game_preview","read_godot_script","write_godot_script","edit_godot_script","create_game_spec","update_game_spec","inspect_game_spec","configure_input_map","execute_playtest","compare_game_versions","save_game_version","export_game_build","capture_game_screenshot"];
    if (godotNames.includes(name)) {
      const epMap: Record<string, string> = {
        detect_godot_runtime: "/detect", select_godot_runtime: "/select", create_godot_project: "/create",
        inspect_godot_project: "/inspect", list_godot_scenes: "/scenes", inspect_godot_scene: "/scenes",
        validate_godot_project: "/validate", import_godot_assets: "/import", run_godot_project: "/run",
        run_godot_scene: "/run", stop_godot_game: "/stop", restart_godot_game: "/restart",
        export_godot_web: "/export-web", export_godot_build: "/export-web", collect_godot_diagnostics: "/diagnostics",
        open_godot_artifact: "/status", capture_game_preview: "/capture",
        read_godot_script: "/read-file", write_godot_script: "/write-file", edit_godot_script: "/edit-file",
        create_game_spec: "/spec-create", update_game_spec: "/spec-update", inspect_game_spec: "/spec-get",
        configure_input_map: "/input-map", execute_playtest: "/playtest", compare_game_versions: "/compare-versions",
        save_game_version: "/checkpoint", export_game_build: "/export-build", capture_game_screenshot: "/capture",
      };
      const p = epMap[name];
      if (!p) {
        const text = JSON.stringify({ ok: false, code: "unknown_tool", error: "未知 Godot 工具：" + name });
        toolEvents.current.push({ name, args, result: text, status: "error" });
        (window as unknown as Record<string, unknown>).__toolEvents = toolEvents.current.slice();
        return { text, failed: true };
      }
      try {
        const res = await fetch(godotCfg.url + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...args, projectId: String(args.projectId || threadId), taskId: threadId }), signal: AbortSignal.timeout(60000) });
        const data = await res.json();
        const text = JSON.stringify(data);
        const failed = Boolean(data && (data.ok === false || "error" in data || data.found === false));
        toolEvents.current.push({ name, args, result: text, status: failed ? "error" : "done" });
        (window as unknown as Record<string, unknown>).__toolEvents = toolEvents.current.slice();
        return { text, failed };
      } catch (e) {
        const text = JSON.stringify({ ok: false, code: "service_unavailable", error: "Godot 服务不可达：" + String(e) });
        toolEvents.current.push({ name, args, result: text, status: "error" });
        (window as unknown as Record<string, unknown>).__toolEvents = toolEvents.current.slice();
        return { text, failed: true };
      }
    }
    if (name === "todo_write") {
      const todos = Array.isArray(args.todos) ? (args.todos as Todo[]) : [];
      patchThread(threadId, (t) => { t.todos = todos.slice(0, 12); });
      const text = JSON.stringify({ ok: true, todos: todos.slice(0, 12) });
      toolEvents.current.push({ name, args, result: text, status: "done" });
      (window as unknown as Record<string, unknown>).__toolEvents = toolEvents.current.slice();
      return { text, failed: false };
    }
    try {
      const res = await fetch(toolsCfg.url + "/" + name, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(args),
        signal: anySignal(180000),
      });
      const data = await res.json();
      const text = JSON.stringify(data);
      const failed = Boolean(data && typeof data === "object" && "error" in data);
      toolEvents.current.push({ name, args, result: text, status: failed ? "error" : "done" });
      (window as unknown as Record<string, unknown>).__toolEvents = toolEvents.current.slice();
      /* HTML 产物 → 工作目录预览 + 任务交付物（以 threadId 为作用域）：
       * 新建 → artifact=ready / preview=starting（随后真实探测）；改写 → artifact=outdated / preview=stale */
      if (!failed && (name === "write" || name === "edit") && typeof args.path === "string" && /\.html?$/i.test(args.path)) {
        const p = String(args.path);
        const base = p.split("/").pop() ?? p;
        const existed = wsPreviewsRef.current.some((x) => x.path === p);
        setWsPreviews((list) => {
          const t = Date.now();
          return list.some((x) => x.path === p)
            ? list.map((x) => (x.path === p ? { ...x, t, threadId } : x))
            : [...list, { path: p, name: base, t, threadId }];
        });
        const dType = /\.html?$/i.test(p) ? "网页应用" : /\.(png|jpe?g|gif|svg|webp)$/i.test(p) ? "图片" : /\.md$/i.test(p) ? "文档" : "文件";
        patchThread(threadId, (tt) => {
          const has = tt.deliverables.some((d) => d.path === p);
          tt.deliverables = has
            ? tt.deliverables.map((d) => (d.path === p ? { ...d, t: Date.now(), artifact: "outdated", preview: "stale" } : d))
            : [...tt.deliverables, { path: p, name: base, t: Date.now(), type: dType, artifact: "ready", preview: "starting", sourceFile: undefined }];
        });
        if (!existed) {
          openDeliverable({ path: p, name: base, t: Date.now(), type: dType, artifact: "ready", preview: "starting" });
          push("success", "已在右侧预览打开", p);
        }
      }
      return { text, failed };
    } catch (e) {
      const stopped = stopRequestedRef.current;
      const text = JSON.stringify({ error: stopped ? "已停止" : "工具服务不可达：" + String(e) });
      toolEvents.current.push({ name, args, result: text, status: "error" });
      (window as unknown as Record<string, unknown>).__toolEvents = toolEvents.current.slice();
      if (!stopped) {
        const n = Date.now();
        if (n - lastToolErrorToastAt.current > 5000) {
          lastToolErrorToastAt.current = n;
          push("error", "工具服务不可达", "检查设置里的工具服务地址，或确认服务已启动");
        }
      }
      return { text, failed: true };
    }
  };

  /* ---- 核心：发送消息（真实 LLM + 真实工具循环 + 真实记忆） ---- */
  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim()) return;
    // 同步竞态防护：React 状态更新是异步的，连续快速发送会同时进入两轮循环
    if (busyRef.current) { push("warn", "正在工作", "稍等它完成再发下一条"); return; }
    busyRef.current = true;
    stopRequestedRef.current = false;
    stopCtrlRef.current = new AbortController();
    const t = threadsRef.current.find((x) => x.id === currentRef.current);
    if (!t) { busyRef.current = false; return; }
    const isFirstUser = !t.msgs.some((m) => m.role === "user");
    const title = isFirstUser ? text.slice(0, 18) : t.title;
    const userMsg: Msg = { id: Date.now(), role: "user", text, time: now() };
    // 关键：LLM 历史必须包含「刚发出的这条消息」。
    // threadsRef 要等 React 重渲染后才更新，同步读它会漏掉刚 push 的消息
    // （症状：第二轮起的回复都在回答上一轮）。因此用本地快照构建历史。
    const snapshot: Thread = { ...t, title, msgs: [...t.msgs, userMsg], thinking: true, todos: [...t.todos] };
    pushMsg(t.id, userMsg);
    patchThread(t.id, (tt) => { tt.thinking = true; tt.agent = "thinking"; tt.status = "running"; });

    let recallCtx = "";
    if (isFirstUser && memCfg.enabled) {
      const rec = await recallMemory(text, memCfg);
      // E2E 钩子：记录本次召回的真实来源（core/proxy/local/none）
      (window as unknown as Record<string, unknown>).__lastRecallSource = rec.source;
      if (rec.source !== "none" && (rec.atoms.length || rec.persona)) {
        pushMsg(t.id, {
          id: Date.now(), role: "agent", kind: "recall",
          text: "我先从记忆里恢复了你的偏好，这次会主动遵守：",
          atoms: rec.atoms.slice(0, 4), time: now(),
        });
        recallCtx = [rec.persona, ...rec.atoms].filter(Boolean).join("\n");
      }
    }

    /* Godot 任务：注入真实引擎状态（就绪+版本+路径），避免 Agent 用 bash 全盘搜索 */
    let godotCtx = "";
    if (snapshot.kind === "godot" || snapshot.kind === "import_godot") {
      try {
        const h = await fetch(godotCfg.url + "/health").then((r) => r.json()).catch(() => null);
        if (h && h.engineStatus === "ready" && h.runtime?.version) {
          godotCtx = "Godot 引擎已就绪（" + h.runtime.version + "，路径 " + h.runtime.path + "）。请直接用 create_godot_project 创建项目、run_godot_project 运行游戏；不要用 bash 搜索或重新检测运行时。";
        } else {
          godotCtx = "Godot 引擎当前不可用（" + (h?.engineStatus ?? "unknown") + "）。请用 detect_godot_runtime 确认；若确实未安装，说明原因并改用网页 Canvas。";
        }
      } catch { godotCtx = "Godot 服务不可达，请先用 detect_godot_runtime 检测。"; }
    }

    const execMode = modeRef.current;
    const execTools = execMode === "plan-only" ? [] : buildTools();
    if (execMode === "plan-only") {
      snapshot.msgs.unshift({ id: -1, role: "agent", kind: "text", text: "（当前模式：仅制定计划，不执行工具。请只输出计划/方案，明确步骤与预期结果。）" });
    }
    const messages: { role: string; content: string; tool_calls?: LlmToolCall[]; tool_call_id?: string }[] =
      toLlmMessages(snapshot, recallCtx, godotCtx);
    const prevDeliverableCount = snapshot.deliverables.length;
    let finalContent = "";
    let finalError = "";
    let stopped = false;
    const MAX_STEPS = 12;

    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        if (stopRequestedRef.current) { stopped = true; break; }
        const res = await chatCompletion(memCfg, model, messages, execTools);
        if (stopRequestedRef.current) { stopped = true; break; }
        if (res.error) { finalError = res.error; break; }
        const calls = res.tool_calls ?? [];
        if (calls.length === 0) { finalContent = res.content; break; }
        messages.push({ role: "assistant", content: res.content, tool_calls: calls });
        for (const call of calls) {
          if (stopRequestedRef.current) { stopped = true; break; }
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* 保持空对象 */ }
          const msgId = Date.now() + Math.floor(Math.random() * 1000);
          pushMsg(t.id, {
            id: msgId, role: "agent", kind: "tool", time: now(),
            toolName: call.function.name,
            toolArgs: JSON.stringify(args).slice(0, 400),
            toolStatus: "running",
          });
          patchThread(t.id, (tt) => { tt.agent = "using_tool"; tt.thinking = true; });
          const { text: result, failed } = await execTool(call.function.name, args, t.id);
          patchThread(t.id, (tt) => { tt.agent = "thinking"; });
          // 停止时工具可能被中断：行状态仍按失败标记
          patchMsg(t.id, msgId, (m) => ({ ...m, toolStatus: failed ? "error" : "done", toolResult: result.slice(0, 4000) }));
          messages.push({ role: "tool", tool_call_id: call.id, content: result.slice(0, 8000) });
        }
        if (stopped) break;
      }
      if (!finalContent && !finalError && !stopped) finalContent = "已经完成了工具调用。";
    } finally {
      busyRef.current = false;
      stopCtrlRef.current = null;
      patchThread(t.id, (tt) => { tt.thinking = false; tt.agent = "idle"; });
    }

    if (stopped) {
      patchThread(t.id, (tt) => {
        tt.agent = "stopped";
        tt.status = "cancelled";
        tt.msgs.push({ id: Date.now(), role: "agent", kind: "text", text: "已停止本次执行。已生成的成果仍然保留，可继续输入新需求。", time: now() });
      });
      return;
    }
    if (finalError) {
      patchThread(t.id, (tt) => {
        tt.agent = "error";
        tt.status = "failed";
        tt.msgs.push({ id: Date.now(), role: "agent", kind: "text", text: "执行失败：" + finalError + "。下一步：检查设置里的 MemoryProxy 地址与密钥后重试，或直接描述你的新需求。", time: now() });
      });
      return;
    }
    const p = parseReply(finalContent);
    patchThread(t.id, (tt) => {
      /* 状态由真实数据驱动：产出交付物→等待验收；计划→等待授权；选项/追问→等待输入 */
      if (tt.deliverables.length > prevDeliverableCount) tt.status = "waiting_for_review";
      else if (p.kind === "plan") tt.status = "waiting_for_approval";
      else if (p.kind === "ask") tt.status = "waiting_for_input";
      else tt.status = "waiting_for_input";
      tt.msgs.push({ id: Date.now(), role: "agent", kind: p.kind, text: p.text, opts: p.opts, items: p.items, time: now() });
    });
    /* 每轮对话写入真实记忆（L0） */
    commitMemory(title, [{ role: "user", text }, { role: "agent", text: finalContent }], memCfg).then((ok) => {
      (window as unknown as Record<string, unknown>).__lastCommit = ok;
      if (ok) push("info", "已沉淀到记忆", "本轮对话已写入 MemoryCore（异步蒸馏 L1/L2/L3）");
    });
  }, [memCfg, model, push, toolsCfg]);

  const pickChip = (mi: number, oi: number) => {
    const t = threadsRef.current.find((x) => x.id === currentRef.current);
    if (!t) return;
    const m = t.msgs[mi];
    if (m.picked !== undefined || t.thinking) return;
    patchThread(t.id, (tt) => { tt.msgs[mi] = { ...m, picked: oi }; });
    sendMessage(m.opts![oi]);
  };

  const confirmPlan = () => sendMessage("开始执行");
  const reconsiderPlan = () => sendMessage("我想修改计划");

  /** 用户编辑任务标题（单一数据源：侧栏/顶栏共用 thread.title） */
  const setTitle = useCallback((title: string) => {
    const id = currentRef.current;
    patchThread(id, (tt) => { tt.title = title.trim() || "新任务"; });
  }, []);

  /** 确认完成：等待验收 → 用户已确认 */
  const confirmTask = useCallback(() => {
    const id = currentRef.current;
    patchThread(id, (tt) => { tt.status = "completed"; });
    push("success", "已确认", "任务标记为「用户已确认」");
  }, [push]);

  /** 停止本次执行（仅停止 Agent；预览服务由成果卡/预览工具栏控制，不受影响） */
  const stop = useCallback(() => {
    if (!busyRef.current) return;
    stopRequestedRef.current = true;
    stopCtrlRef.current?.abort();
    patchThread(currentRef.current, (tt) => { tt.agent = "stopped"; });
  }, []);

  /** 探测交付物预览服务真实状态：200→online；404→loading_failed(文件缺失)；网络错误→loading_failed(服务不可用) */
  const pingDeliverable = useCallback((path: string) => {
    return fetch(toolsCfg.url + "/preview/" + path + "?t=" + Date.now(), { method: "GET" })
      .then((r) => (r.ok ? "online" : "loading_failed"))
      .catch(() => "loading_failed")
      .then((preview) => {
        const pv = preview as "online" | "loading_failed";
        patchThread(currentRef.current, (tt) => {
          tt.deliverables = tt.deliverables.map((d) =>
            d.path === path ? { ...d, preview: pv, error: pv === "online" ? undefined : "预览服务不可用或文件缺失" } : d
          );
        });
        return pv;
      });
  }, [toolsCfg.url]);

  /** 打开交付物预览：标签缺失时自动重建；标签以当前任务为作用域 */
  const openDeliverable = useCallback((d: Deliverable) => {
    const thId = currentRef.current;
    let idx = wsPreviewsRef.current.findIndex((x) => x.path === d.path && x.threadId === thId);
    if (idx < 0) {
      setWsPreviews((list) =>
        list.some((x) => x.path === d.path && x.threadId === thId) ? list : [...list, { path: d.path, name: d.name, t: Date.now(), threadId: thId }]
      );
      idx = wsPreviewsRef.current.length;
    }
    setPreviewTab(PREVIEW_PAGES.length + idx);
    setPreviewOpen(true);
    pingDeliverable(d.path);
  }, [pingDeliverable]);

  /** 重新启动预览服务：starting → 真实探测 */
  const restartPreview = useCallback((path: string) => {
    patchThread(currentRef.current, (tt) => {
      tt.deliverables = tt.deliverables.map((d) => (d.path === path ? { ...d, preview: "starting", error: undefined } : d));
    });
    pingDeliverable(path);
  }, [pingDeliverable]);

  /** 停止预览服务（不触碰成果与 Agent 状态） */
  const stopPreview = useCallback((path: string) => {
    patchThread(currentRef.current, (tt) => {
      tt.deliverables = tt.deliverables.map((d) => (d.path === path ? { ...d, preview: "stopped" } : d));
    });
  }, []);

  /** 刷新预览（重新探测 + 刷新标签缓存戳） */
  const refreshPreviewArtifact = useCallback((path: string) => {
    setWsPreviews((list) => list.map((x) => (x.path === path ? { ...x, t: Date.now() } : x)));
    pingDeliverable(path);
  }, [pingDeliverable]);

  /** 重新生成成果：真实让 Agent 重新产出该文件 */
  const regenerateArtifact = useCallback((name: string) => {
    sendMessage("重新生成 " + name + "，保持相同要求，生成后汇报结果");
  }, [sendMessage]);

  /** 关闭一个工作目录预览标签；若关闭的是当前标签则切回首个内置页 */
  const closeWsPreview = (p: string) => {
    const idx = wsPreviewsRef.current.findIndex((x) => x.path === p);
    setWsPreviews((list) => list.filter((x) => x.path !== p));
    if (idx >= 0 && previewTab === PREVIEW_PAGES.length + idx) setPreviewTab(0);
  };

  const switchThread = (id: string) => {
    setCurrentState(id);
    const t = threadsRef.current.find((x) => x.id === id);
    if (t && !t.msgs.some((m) => m.kind === "recall") && t.msgs.length <= 1) setPreviewOpen(false);
  };

  const newChat = (kind?: "general" | "web" | "godot" | "import_godot") => {
    const t = firstThread();
    if (kind) t.kind = kind;
    setThreads((ts) => [t, ...ts]);
    setCurrentState(t.id);
    setPreviewOpen(false);
  };

  const clearDone = () => {
    setThreads((ts) => {
      const rest = ts.filter((t) => t.status !== "completed");
      return rest.length ? rest : [firstThread()];
    });
    push("success", "已清理");
  };

  return {
    threads, current, cur, setCurrent: switchThread,
    sendMessage, stop, pickChip, confirmPlan, reconsiderPlan, newChat, clearDone,
    setTitle, confirmTask, mode, setMode, openDeliverable, pingDeliverable,
    restartPreview, stopPreview, refreshPreviewArtifact, regenerateArtifact,
    reduceMotion, setReduceMotion: setReduceMotionPersist,
    previewOpen, previewTab, setPreviewTab, device, setDevice,
    setPreviewOpen: (v: boolean) => setPreviewOpen(v),
    openPreview: () => setPreviewOpen(true),
    closePreview: () => setPreviewOpen(false),
    togglePreview: () => setPreviewOpen((v) => !v),
    reloadPreview: () => {
      const frame = document.getElementById("previewFrame") as HTMLIFrameElement | null;
      if (frame) frame.src = frame.src.split("?")[0] + "?t=" + Date.now();
      push("info", "预览已刷新");
    },
    settingsOpen, setSettingsOpen, paletteOpen, setPaletteOpen,
    model, setModel,
    memCfg, setMemCfg,
    toolsCfg, setToolsCfg,
    godotCfg, setGodotCfg,
    wsPreviews, closeWsPreview,
    toasts, push,
    PREVIEW_PAGES,
  };
}

export type Harness = ReturnType<typeof useHarness>;