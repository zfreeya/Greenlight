import { useEffect, useRef, useState } from "react";
import { useHarness, Harness } from "./harness";
import { Msg, Deliverable, TaskStatus, EXEC_MODES, ExecMode, taskTitle, statusBadge, agentLabel, formatRelative, formatClock } from "./state";
import Markdown from "./Markdown";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function winAction(action: "close" | "minimize" | "maximize") {
  if (!isTauri) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const w = getCurrentWindow();
  if (action === "close") await w.close();
  if (action === "minimize") await w.minimize();
  if (action === "maximize") await w.toggleMaximize();
}

function openExternal(url: string) {
  if (isTauri) {
    import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(url).catch(() => undefined));
  } else {
    window.open(url, "_blank", "noopener");
  }
}

const Ic = {
  mark: (<img src="/icon.png" alt="" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "inherit" }} />),
  spark: (<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 2.4 3.3-.5.5 3.3L21 9.6l-1.8 2.8 1.8 2.8-2.8 1.8-.5 3.3-3.3-.5L12 22l-2.4-2.4-3.3.5-.5-3.3L3 15.2l1.8-2.8L3 9.6l2.8-1.8.5-3.3 3.3.5z" /><circle cx="12" cy="11" r="3.2" fill="#fff" /></svg>),
  plus: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>),
  search: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.35-4.35" /></svg>),
  monitor: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></svg>),
  tablet: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" /><path d="M12 18h.01" /></svg>),
  phone: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="7" y="2" width="10" height="20" rx="2.5" /><path d="M12 18h.01" /></svg>),
  gear: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>),
  x: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>),
  chevR: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>),
  chevD: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>),
  check: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>),
  send: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 5l7 7-7 7" /></svg>),
  clip: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>),
  reload: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" /></svg>),
  lock: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="11" width="16" height="9" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>),
  doc: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5z" /><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5" /></svg>),
  panel: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></svg>),
  menu: (<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>),
};

/* ================= 顶栏：任务状态 + Agent 状态 + 操作 ================= */
function TitleBar({ h, sideOpen, onToggleSide }: { h: Harness; sideOpen: boolean; onToggleSide: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const b = statusBadge(h.cur.status);
  const title = taskTitle(h.cur);
  const agentBusy = h.cur.thinking;
  const commit = () => { h.setTitle(draft); setEditing(false); };
  return (
    <div className="win-titlebar" data-tauri-drag-region>
      <div className="traffic">
        <span className="t" onClick={() => winAction("close")} title="关闭"><svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><path d="M2.5 2.5l5 5M7.5 2.5l-5 5" /></svg></span>
        <span className="t" onClick={() => winAction("minimize")} title="最小化"><svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><path d="M2.5 5h5" /></svg></span>
        <span className="t" onClick={() => winAction("maximize")} title="全屏"><svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M3 3h4v4H3z" /></svg></span>
      </div>
      <button className="side-toggle" onClick={onToggleSide} title={sideOpen ? "收起侧栏" : "展开侧栏"} aria-label="切换侧栏">{Ic.panel}</button>
      <div className="win-title">
        {editing ? (
          <input className="title-edit" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
            onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }} />
        ) : (
          <span className="task-title" title={"任务标题（点击修改）" + (b.tip ? "。当前状态：" + b.tip : "")} onClick={() => { setDraft(title); setEditing(true); }}>{title}</span>
        )}
        <span className={"badge " + b.cls} title={b.tip}>{b.label}</span>
        {agentBusy && <span className="agent-chip" title="Agent 状态">{Ic.spark}{agentLabel(h.cur.agent)}</span>}
      </div>
      <div className="win-right">
        <button className={"head-btn" + (h.previewOpen ? " on" : "")} onClick={h.togglePreview} title={h.previewOpen ? "关闭预览面板" : "打开预览面板"} aria-label={h.previewOpen ? "关闭预览面板" : "打开预览面板"} aria-pressed={h.previewOpen}>{Ic.monitor}</button>
        <button className="head-btn" onClick={() => h.setSettingsOpen(true)} title="设置" aria-label="设置">{Ic.gear}</button>
      </div>
    </div>
  );
}

/* ================= 新建任务类型菜单 ================= */
function NewTaskMenu({ h }: { h: Harness }) {
  const [open, setOpen] = useState(false);
  const types: [string, "general" | "web" | "godot" | "import_godot", string][] = [
    ["普通任务", "general", "对话 + 工具执行，如整理文件、写脚本"],
    ["网页应用", "web", "生成可预览的 HTML 网页"],
    ["Godot 游戏", "godot", "创建并运行真实 Godot 2D 游戏项目"],
    ["导入 Godot 项目", "import_godot", "导入已有 Godot 项目目录"],
  ];
  return (
    <div className="newtask-wrap">
      <button className="btn btn-new-chat" onClick={() => setOpen((v) => !v)} title="新建一个任务">{Ic.plus}新建任务</button>
      {open && (
        <div className="newtask-pop" onMouseLeave={() => setOpen(false)}>
          {types.map(([label, kind, desc]) => (
            <button key={kind} className="newtask-item" onClick={() => { setOpen(false); h.newChat(kind); }}>
              <span className="nt-name">{label}</span>
              <span className="nt-desc">{desc}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ================= Godot 游戏工作区（右侧面板，真实服务驱动） ================= */
function GameWorkspace({ h }: { h: Harness }) {
  const [tab, setTab] = useState<"game" | "scene" | "console">("game");
  const [engine, setEngine] = useState<{ status: string; runtime: { path?: string; version?: string } | null }>({ status: "unavailable", runtime: null });
  const [game, setGame] = useState<{ status: string; scene?: string; logs: { stream: string; text: string }[] }>({ status: "stopped", logs: [] });
  const [proj, setProj] = useState<{ ok?: boolean; name?: string; mainScene?: string; scenes?: string[]; scripts?: string[]; tree?: { name: string; type: string; parent: string | null }[] }>({});
  const [selPath, setSelPath] = useState("");
  const g = h.godotCfg.url;
  const pid = h.cur.id;
  const call = async (ep: string, body: Record<string, unknown> = {}) => {
    try { const r = await fetch(g + ep, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, projectId: pid, taskId: pid }) }); return await r.json(); }
    catch { return { ok: false, error: "Godot 服务不可达" }; }
  };
  const refresh = async () => {
    const [hres, sres, dres, scres] = await Promise.all([fetch(g + "/health").then(r => r.json()).catch(() => ({})), call("/status"), call("/diagnostics"), call("/scenes")]);
    setEngine({ status: hres.engineStatus || "unavailable", runtime: hres.runtime || null });
    setGame({ status: sres.game || "stopped", scene: sres.scene, logs: sres.logs || [] });
    setProj({ ...(dres.project || {}), ...(scres.ok ? { tree: scres.tree, scenes: scres.scenes, scripts: scres.scripts, mainScene: scres.mainScene } : {}) });
  };
  useEffect(() => { refresh(); const iv = setInterval(refresh, 3000); return () => clearInterval(iv); }, [g, pid]);
  const btn = (label: string, run: () => void, primary = false) => <button className={"btn " + (primary ? "btn-primary" : "btn-secondary") + " btn-sm"} onClick={run}>{label}</button>;
  return (
    <aside className="game-workspace">
      <div className="gw-head">
        <span className="t">游戏工作区</span>
        <span className={"badge " + (engine.status === "ready" ? "done" : "neutral")}>{engine.status === "ready" ? "引擎就绪" : "引擎未安装"}</span>
        <button className="pv-close" onClick={h.closePreview} title="关闭">{Ic.chevR}</button>
      </div>
      <div className="gw-engine">
        <div className="gw-engine-row">
          <span className="gw-label">Godot 运行时</span>
          <span className="mono">{engine.runtime ? engine.runtime.version || engine.runtime.path : "未检测到"}</span>
          <button className="btn btn-ghost btn-sm" onClick={async () => { await call("/detect"); refresh(); }}>检测</button>
        </div>
        <div className="gw-engine-row">
          <input className="inp-txt" style={{ flex: 1 }} placeholder="手动选择 Godot 可执行文件路径" value={selPath} onChange={(e) => setSelPath(e.target.value)} />
          <button className="btn btn-secondary btn-sm" onClick={async () => { if (selPath) { await call("/select", { path: selPath }); refresh(); } }}>选择</button>
        </div>
        {engine.status === "unavailable" && <div className="gw-hint">未安装 Godot。可手动选择可执行文件，或将 Godot 放入 /Applications/Godot.app 后点「检测」。下载能力将在后续版本提供（不会伪造安装状态）。</div>}
      </div>
      <div className="gw-tabs">
        {(["game", "scene", "console"] as const).map((k) => <button key={k} className={"gw-tab" + (tab === k ? " on" : "")} onClick={() => setTab(k)}>{k === "game" ? "游戏" : k === "scene" ? "场景" : "控制台"}</button>)}
      </div>
      <div className="gw-body">
        {tab === "game" && (
          <div className="gw-game">
            <div className="gw-status">游戏状态：<b>{game.status === "running" ? "运行中" : "已停止"}</b>{game.scene ? " · 场景 " + game.scene : ""}</div>
            <div className="gw-actions">
              {btn("运行", async () => { await call("/run"); refresh(); }, true)}
              {btn("停止", async () => { await call("/stop"); refresh(); })}
              {btn("重启", async () => { await call("/restart"); refresh(); })}
              {btn("导出 Web", async () => { const r = await call("/export-web"); h.push(r.ok ? "success" : "warn", r.ok ? "已导出 Web" : "导出不可用", r.hint || ""); })}
            </div>
            {game.status === "stopped" && engine.status === "unavailable" && <div className="gw-hint">无法运行：需要 Godot 运行时。</div>}
          </div>
        )}
        {tab === "scene" && (
          <div className="gw-scene">
            <div className="gw-label">主场景：{proj.mainScene || "（未设置）"}</div>
            <div className="gw-label">场景 {proj.scenes?.length ?? 0} 个 · 脚本 {proj.scripts?.length ?? 0} 个</div>
            <div className="gw-tree">
              {(proj.tree || []).map((n) => <div key={n.name} className="gw-node"><span className="mono">{n.type}</span>{n.name}</div>)}
            </div>
            {(proj.scenes || []).map((s) => <div key={s} className="gw-node mono">{s}</div>)}
          </div>
        )}
        {tab === "console" && (
          <div className="gw-console mono">
            {(game.logs || []).slice(-30).map((l, i) => <div key={i} className={"gw-log " + l.stream}>{l.text}</div>)}
            {(game.logs || []).length === 0 && <div className="gw-hint">暂无运行日志。</div>}
          </div>
        )}
      </div>
    </aside>
  );
}

/* ================= 侧栏（任务为作用域） ================= */
function Sidebar({ h }: { h: Harness }) {
  return (
    <aside className="sidebar">
      <div className="side-brand">
        <span className="sb-mark">{Ic.mark}</span>
        <span className="sb-name">Harness</span>
      </div>
      <NewTaskMenu h={h} />
      <div className="side-search">
        <div className="search-input" onClick={() => h.setPaletteOpen(true)}>
          {Ic.search}
          <input placeholder="搜索任务" readOnly />
          <span className="kbd">⌘K</span>
        </div>
      </div>
      <div className="side-label">任务</div>
      <div className="thread-list">
        {h.threads.map((t) => {
          const b = statusBadge(t.status);
          const title = taskTitle(t);
          return (
            <div key={t.id} className={"thread-item" + (t.id === h.current ? " on" : "")} onClick={() => h.setCurrent(t.id)} title={title + "（" + b.label + "）"}>
              <span className={"tstatus " + t.status} data-status={t.status} aria-label={b.label} />
              <div className="t-main">
                <div className="tt">{title}</div>
                <div className="tm"><span className="tst">{formatRelative(t.updatedAt)}</span></div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="side-agent">
        <div className={"agent-orb" + (h.cur.thinking ? " busy" : "")}>{Ic.spark}</div>
        <div className="meta">
          <div className="who">harness-agent</div>
          <div className="state side-conn"><span className="pdot idle" />在线</div>
        </div>
      </div>
    </aside>
  );
}

/* ================= 消息头 ================= */
function AgentHead({ time }: { time?: string }) {
  return (
    <div className="a-head">
      <span className="a-mark">{Ic.spark}</span>
      <span className="a-name">harness-agent</span>
      {time && <span className="a-time">{time}</span>}
    </div>
  );
}

/* 工具 → 人类可读摘要（原始 JSON 永不默认显示） */
function toolLineSummary(g: Msg): string {
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(g.toolArgs || "{}"); } catch { /* ignore */ }
  const name = g.toolName || "tool";
  const p = String(args.path || "");
  if (name === "read") return "已读取 " + p + (args.offset ? " · 从 " + args.offset + " 行起" : "");
  if (name === "write") return (g.toolResult && /"operation":"create"/.test(g.toolResult) ? "已创建 " : "已更新 ") + p;
  if (name === "edit") return "已修改 " + p;
  if (name === "bash") return "已运行命令 " + String(args.command || "").slice(0, 40);
  if (name === "glob") { try { const n = JSON.parse(g.toolResult || "{}").paths?.length ?? 0; return "已查找 " + n + " 个文件"; } catch { return "已查找文件"; } }
  if (name === "grep") { try { const n = JSON.parse(g.toolResult || "{}").matches?.length ?? 0; return "已搜索 " + n + " 个匹配"; } catch { return "已搜索内容"; } }
  if (name === "fetch") return "已抓取 " + String(args.url || "").slice(0, 40);
  if (name === "todo_write") return "已更新任务清单";
  if (name === "read_godot_script") return "已读取脚本 " + String(args.path || "");
  if (name === "write_godot_script") return "已写入脚本 " + String(args.path || "");
  if (name === "edit_godot_script") return "已修改脚本 " + String(args.path || "");
  if (name === "detect_godot_runtime") return (g.toolResult && /"found":true/.test(g.toolResult)) ? "已识别 Godot 运行时" : "未检测到 Godot 运行时";
  if (name === "select_godot_runtime") return (g.toolResult && /"ok":true/.test(g.toolResult)) ? "已选择 Godot 运行时" : "Godot 运行时选择失败";
  if (name === "create_godot_project") return "已创建 Godot 项目";
  if (name === "inspect_godot_project") return "已检查 Godot 项目";
  if (name === "list_godot_scenes") return "已列出场景与节点";
  if (name === "validate_godot_project") return "已校验 Godot 项目";
  if (name === "run_godot_project" || name === "run_godot_scene") return (g.toolResult && /"ok":true/.test(g.toolResult)) ? "已运行场景 " + String(args.scene || "") : "运行失败（运行时缺失）";
  if (name === "stop_godot_game") return "已停止游戏";
  if (name === "restart_godot_game") return "已重新启动游戏";
  if (name === "collect_godot_diagnostics") return "已收集 Godot 诊断";
  if (name === "export_godot_web") return (g.toolResult && /"ok":true/.test(g.toolResult)) ? "已导出 Web 版本" : "Web 导出失败（模板或运行时缺失）";
  return "已执行 " + name;
}
function toolGroupSummary(tools: Msg[], startId: number): string {
  const parts = tools.map((g) => toolLineSummary(g));
  const sec = Math.max(0, Math.round((tools[tools.length - 1].id - startId) / 1000));
  return parts.join("、") + " · " + tools.length + " 个步骤" + (sec > 0 ? " · 耗时 " + sec + " 秒" : "");
}

/* ================= 工具调用组（统一折叠；展开才见原始参数/返回值/复制） ================= */
function ToolGroup({ group, open, onToggle, past, startId }: { group: Msg[]; open: boolean; onToggle: () => void; past?: boolean; startId?: number }) {
  const running = group.some((g) => g.toolStatus === "running");
  const hasErr = group.some((g) => g.toolStatus === "error");
  const copyText = async (txt: string) => { try { await navigator.clipboard.writeText(txt); } catch { /* ignore */ } };
  return (
    <div className={"tool-group" + (hasErr ? " err" : "") + (open ? " open" : "") + (past ? " past" : "")}>
      <button className="tool-summary" onClick={onToggle} aria-expanded={open}>
        <span className="tg-status">{running ? <span className="tg-run"><i /><i /><i /></span> : hasErr ? <span className="tg-x">!</span> : Ic.check}</span>
        <span className="tg-text">{past ? "此前执行 · " + toolGroupSummary(group, startId ?? group[0].id) : running ? "正在执行…" : hasErr ? "部分工具执行失败 · " + toolGroupSummary(group, startId ?? group[0].id) : toolGroupSummary(group, startId ?? group[0].id)}</span>
        <span className={"tg-chev" + (open ? " up" : "")}>{Ic.chevD}</span>
      </button>
      {open && (
        <div className="tool-items">
          {group.map((g) => (
            <div key={g.id} className={"tool-line mono" + (g.toolStatus === "done" ? " ok" : g.toolStatus === "error" ? " err" : "")}>
              <div className="tl-head">
                <span className="tl-name">{g.toolName}</span>
                <span className="tl-args">{g.toolArgs}</span>
                {g.toolStatus === "running" && <span className="tool-wait"><i /><i /><i /></span>}
              </div>
              {g.toolResult && (
                <div className="tl-out">
                  <pre>{g.toolResult}</pre>
                  <button className="tl-copy" onClick={() => copyText(g.toolResult!)} title="复制输出">复制</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ================= 成果卡：四态（正常/预览停止/过期/生成失败） ================= */
function DeliverableCard({ h, d, onFocusInput }: { h: Harness; d: Deliverable; onFocusInput: (p: string) => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [diagOpen, setDiagOpen] = useState(false);
  const url = h.toolsCfg.url + "/preview/" + d.path;
  const task = h.cur.status;
  const online = d.preview === "online";
  const previewLabel = d.preview === "online" ? "预览在线" : d.preview === "stopped" ? "预览已停止" : d.preview === "starting" ? "预览正在启动" : d.preview === "stale" ? "内容可能不是最新版本" : "预览加载失败";
  const previewCls = d.preview === "online" ? "on" : d.preview === "starting" ? "starting" : "off";
  const openPreview = () => h.openDeliverable(d);
  const openBrowser = () => openExternal(url);
  const viewFile = () => {
    if (isTauri) {
      import("@tauri-apps/plugin-opener").then(({ revealItemInDir }) => revealItemInDir(h.toolsCfg.workspace + "/" + d.path).catch(() => h.push("warn", "无法定位文件", d.path)));
    } else {
      h.push("info", "文件", d.path);
    }
  };
  const copyLink = async () => { try { await navigator.clipboard.writeText(url); h.push("success", "已复制链接", url); } catch { h.push("warn", "复制失败", "请手动复制地址栏链接"); } };

  /* 主操作：按状态最多一个 */
  let primary: { label: string; run: () => void } | null = null;
  if (d.artifact === "failed") primary = { label: "重试生成", run: () => h.regenerateArtifact(d.name) };
  else if (d.artifact === "outdated") primary = { label: "重新生成成果", run: () => h.regenerateArtifact(d.name) };
  else if (d.preview === "stopped") primary = { label: "重新启动预览", run: () => h.restartPreview(d.path) };
  else if (d.preview === "loading_failed") primary = { label: "重新加载预览", run: () => h.refreshPreviewArtifact(d.path) };
  else if (d.preview === "starting") primary = { label: "正在启动…", run: () => h.restartPreview(d.path) };
  else if (d.preview === "stale") primary = { label: "刷新预览", run: () => h.refreshPreviewArtifact(d.path) };
  else if (d.artifact === "ready" && d.preview === "online") primary = { label: "确认完成", run: h.confirmTask };
  else primary = { label: "打开预览", run: openPreview };

  /* 直接次操作（≤2） */
  const secondaries: { label: string; run: () => void }[] = [];
  if (d.preview === "stopped" || d.preview === "loading_failed") {
    secondaries.push({ label: "查看文件", run: viewFile });
    secondaries.push({ label: "查看诊断", run: () => setDiagOpen((v) => !v) });
  } else if (task === "waiting_for_review" || task === "completed") {
    secondaries.push({ label: "继续修改", run: () => onFocusInput("针对当前任务继续修改：") });
    secondaries.push({ label: "在浏览器打开", run: openBrowser });
  } else {
    secondaries.push({ label: "打开预览", run: openPreview });
    secondaries.push({ label: "在浏览器打开", run: openBrowser });
  }

  const isGame = /(tetris|snake|2048|game|games|俄罗斯|贪吃|消除|射击|平台|mario|pong)/i.test(taskTitle(h.cur)) || /(tetris|snake|2048|game|俄罗斯|贪吃)/i.test(d.name);
  const suggestions: [string, string][] = d.type === "网页应用"
    ? (isGame
        ? [["优化游戏视觉", "优化这个游戏的视觉表现"], ["添加最高分记录", "为游戏添加最高分记录（localStorage）"], ["增加音效", "为游戏增加音效"]]
        : [["美化页面", "美化这个页面的视觉表现"], ["增加响应式", "为页面增加移动端响应式适配"], ["添加交互", "为页面增加一些交互细节"]])
    : [["完善内容", "进一步完善这个文件的内容"], ["增加导出", "为这个成果增加导出/打包能力"]];
  const showSuggestions = online && (task === "waiting_for_review" || task === "completed");

  return (
    <div className={"deliverable-card" + (d.artifact === "failed" ? " dl-failed" : d.artifact === "outdated" ? " dl-outdated" : "")}>
      <div className="dc-head">
        <div>
          <div className="dc-title">{d.name}</div>
          <div className="dc-type">{d.type} · 文件 {d.path} · 更新于 {formatClock(d.t)}</div>
        </div>
        <span className={"dc-status " + previewCls}><span className="dc-dot" />{previewLabel}</span>
      </div>
      <div className="dc-desc">{d.artifact === "failed" ? "成果生成失败：" + (d.error || "未知原因") : d.artifact === "outdated" ? "文件已被后续修改，当前预览可能不是最新版本。" : "成果已生成，可在预览面板或浏览器中查看。"}</div>
      <div className="dc-url mono">{url}</div>
      <div className="dc-actions">
        {primary && <button className="btn btn-primary" onClick={primary.run} disabled={d.preview === "starting"}>{primary.label}</button>}
        {secondaries.map((s) => <button key={s.label} className="btn btn-secondary" onClick={s.run}>{s.label}</button>)}
        <div className="dl-more">
          <button className="btn btn-ghost dl-more-btn" onClick={() => setMenuOpen((v) => !v)} aria-label="更多操作" title="更多操作">{Ic.menu}</button>
          {menuOpen && (
            <div className="dl-menu" onMouseLeave={() => setMenuOpen(false)}>
              <button onClick={() => { setMenuOpen(false); openPreview(); }}>打开预览</button>
              <button onClick={() => { setMenuOpen(false); copyLink(); }}>复制链接</button>
              <button onClick={() => { setMenuOpen(false); h.refreshPreviewArtifact(d.path); }}>刷新预览</button>
              <button onClick={() => { setMenuOpen(false); h.restartPreview(d.path); }}>重新启动预览</button>
              <button onClick={() => { setMenuOpen(false); h.stopPreview(d.path); }}>关闭预览</button>
            </div>
          )}
        </div>
      </div>
      {diagOpen && (
        <div className="dc-diag mono">
          <div>服务地址：{h.toolsCfg.url}</div>
          <div>工作目录：{h.toolsCfg.workspace || "未连接"}</div>
          <div>文件：{d.path}</div>
          <div>状态：{d.preview} {d.error ? " · " + d.error : ""}</div>
        </div>
      )}
      {showSuggestions && (
        <div className="accept-chips">
          {suggestions.map(([label, msg]) => <button key={label} className="accept-chip" onClick={() => h.sendMessage(msg)}>{label}</button>)}
        </div>
      )}
      <details className="dc-help">
        <summary>操作说明</summary>
        <p>在预览面板或系统浏览器中打开成果；预览停止时请先「重新启动预览」。停止 Agent 不影响预览服务。</p>
      </details>
    </div>
  );
}

/* ================= 任务摘要区 ================= */
function TaskSummary({ h, shrunk }: { h: Harness; shrunk: boolean }) {
  const b = statusBadge(h.cur.status);
  const dl = h.cur.deliverables[h.cur.deliverables.length - 1];
  return (
    <div className={"task-summary" + (shrunk ? " shrunk" : "")}>
      <div className="ts-row">
        <div className="ts-goal">
          <span className="ts-label">任务目标</span>
          <span className="ts-value">{taskTitle(h.cur)}</span>
        </div>
        <div className="ts-status">
          <span className="ts-label">当前状态</span>
          <span className={"badge " + b.cls} title={b.tip}>{b.label}</span>
        </div>
      </div>
      <div className="ts-row ts-sub">
        {dl && <div className="ts-item"><span className="ts-label">最近成果</span><span className="ts-value mono">{dl.name}</span></div>}
        {dl && <div className="ts-item"><span className="ts-label">预览状态</span><span className={"ts-value " + (dl.preview === "online" ? "ok" : dl.preview === "stopped" || dl.preview === "loading_failed" ? "err" : "warn")}>{dl.preview === "online" ? "在线" : dl.preview === "starting" ? "启动中" : dl.preview === "stopped" ? "已停止" : dl.preview === "stale" ? "过期" : "加载失败"}</span></div>}
        <div className="ts-item"><span className="ts-label">最近更新</span><span className="ts-value mono">{formatRelative(h.cur.updatedAt)}</span></div>
        {!shrunk && dl && (dl.preview === "online" || dl.preview === "starting") && (
          <button className="btn btn-primary btn-sm ts-action" onClick={() => h.openDeliverable(dl)}>{Ic.monitor}打开预览</button>
        )}
      </div>
    </div>
  );
}

/* ================= 消息行 ================= */
function MsgRow({ m, h, mi }: { m: Msg; h: Harness; mi: number }) {
  if (m.role === "user") {
    return <div className="msg user"><div className="bubble">{m.chip ?? m.text}</div></div>;
  }
  if (m.kind === "ask") {
    const opts = m.opts ?? [];
    return (
      <div className="msg agent">
        <AgentHead time={m.time} />
        <div className="text"><Markdown text={m.text ?? ""} /></div>
        {opts.length > 0 && (
          <div className="chips">
            {opts.map((o, i) => (
              <button key={i} className={"chip" + (m.picked === i ? " picked" : "") + (m.picked !== undefined && m.picked !== i ? " gone" : "")} disabled={m.picked !== undefined} onClick={() => h.pickChip(mi, i)}>{o}</button>
            ))}
          </div>
        )}
      </div>
    );
  }
  if (m.kind === "recall") {
    return (
      <div className="msg agent">
        <AgentHead time={m.time} />
        <div className="text">{m.text}</div>
        <div className="mem-block">
          <div className="mem-label">来自记忆 · L1/L2 召回</div>
          {(m.atoms ?? []).map((a, i) => <div className="mem-atom" key={i}>{a}</div>)}
        </div>
      </div>
    );
  }
  if (m.kind === "plan") {
    const items = m.items ?? [];
    return (
      <div className="msg agent">
        <AgentHead time={m.time} />
        <div className="text"><Markdown text={m.text ?? ""} /></div>
        {items.length > 0 && (
          <div className="plan-card">
            <div className="pt">计划</div>
            {items.map((it, i) => <div className="pi" key={i}><b>{i + 1}</b><span>{it}</span></div>)}
            <div className="pa">
              <button className="btn btn-primary btn-sm" onClick={h.confirmPlan}>开始执行</button>
              <button className="btn btn-ghost btn-sm" onClick={h.reconsiderPlan}>改一改</button>
            </div>
          </div>
        )}
      </div>
    );
  }
  return <div className="msg agent"><AgentHead time={m.time} /><div className="text"><Markdown text={m.text ?? ""} /></div></div>;
}

/* ================= 底部 Agent 操作台 ================= */
function Console({ h, text, setText, send, inputRef, prompt, clearPrompt }: { h: Harness; text: string; setText: (v: string) => void; send: () => void; inputRef: { current: HTMLTextAreaElement | null }; prompt: string; clearPrompt: () => void }) {
  const [modeOpen, setModeOpen] = useState(false);
  const modeMeta = EXEC_MODES.find((m) => m.id === h.mode) || EXEC_MODES[0];
  const wsName = (h.toolsCfg.workspace || "").split("/").filter(Boolean).pop() || "工作目录";
  const agentBusy = h.cur.thinking;
  const pickMode = (m: ExecMode) => { h.setMode(m); setModeOpen(false); if (m === "auto") h.push("info", "已切换自动执行", "自动执行下 Agent 可能修改文件并运行命令，请确认任务描述清晰"); };
  return (
    <div className="console-bar">
      <div className="console">
        <div className="console-row">
          <button className="tool-btn" title="附件" aria-label="附件" onClick={() => h.push("info", "附件", "将打开文件选择器")}>{Ic.clip}</button>
          <textarea ref={inputRef} id="chatInput" rows={1}
            placeholder={prompt || "描述你希望 Agent 完成的任务……"}
            value={text}
            onChange={(e) => { if (prompt) clearPrompt(); setText(e.target.value); e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px"; }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
          />
          <div className="mode-wrap">
            <button className="mode-chip" onClick={() => setModeOpen((v) => !v)} title="选择执行模式" aria-expanded={modeOpen}>{Ic.spark}{modeMeta.label}<span className="mode-caret">{Ic.chevD}</span></button>
            {modeOpen && (
              <div className="mode-pop">
                {EXEC_MODES.map((m) => (
                  <button key={m.id} className={"mode-item" + (m.id === h.mode ? " sel" : "")} onClick={() => pickMode(m.id)}>
                    <span className="mode-name">{m.label}</span>
                    <span className="mode-desc">{m.desc}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {agentBusy ? (
            <button className="send-btn stop" onClick={h.stop} title="停止本次执行" aria-label="停止本次执行"><span className="stop-ico" /></button>
          ) : (
            <button className="send-btn" onClick={send} title="发送" aria-label="发送">{Ic.send}</button>
          )}
        </div>
        <div className="console-hint">
          <span className="mono">Enter</span> 发送 · <span className="mono">Shift+Enter</span> 换行 · <span className="mono">⌘K</span> 命令
          <span className="hint-right mono">{h.toolsCfg.workspace ? wsName : "工具服务未连接"}</span>
        </div>
      </div>
    </div>
  );
}

/* ================= 对话区：任务摘要 + 执行分组 + 成果卡 + 操作台 ================= */
function ChatView({ h }: { h: Harness }) {
  const [text, setText] = useState("");
  const [prompt, setPrompt] = useState("");
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [shrunk, setShrunk] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const focusInput = (p: string) => { setPrompt(p); inputRef.current?.focus(); };
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => setShrunk(el.scrollTop > 56);
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [h.cur.msgs.length, h.cur.thinking, h.cur.deliverables.length]);
  const send = () => { h.sendMessage(text); setText(""); };

  const prelude: { m: Msg; idx: number }[] = [];
  const preludeTools: Msg[] = [];
  const episodes: { user: { m: Msg; idx: number }; rows: { m: Msg; idx: number }[]; tools: Msg[] }[] = [];
  let curE: typeof episodes[number] | null = null;
  h.cur.msgs.forEach((m, i) => {
    if (m.role === "user") { curE = { user: { m, idx: i }, rows: [], tools: [] }; episodes.push(curE); return; }
    if (!curE) { if (m.kind === "tool") preludeTools.push(m); else prelude.push({ m, idx: i }); return; }
    if (m.kind === "tool") curE.tools.push(m); else curE.rows.push({ m, idx: i });
  });

  return (
    <main className="chat">
      <div className="msg-scroll" ref={scrollRef}>
        <div className="msg-col">
          <TaskSummary h={h} shrunk={shrunk} />
          {h.cur.todos.length > 0 && (
            <div className="todo-card">
              <div className="todo-title">任务清单</div>
              {h.cur.todos.map((td, i) => (
                <div key={i} className={"todo-item " + td.status}>
                  <span className="todo-check">{td.status === "completed" ? Ic.check : td.status === "in_progress" ? "·" : ""}</span>
                  <span className="todo-text">{td.content}</span>
                </div>
              ))}
            </div>
          )}
          {preludeTools.length > 0 && (
            <ToolGroup group={preludeTools} startId={preludeTools[0].id} open={!!openGroups["pre"]} onToggle={() => setOpenGroups((s) => ({ ...s, pre: !s.pre }))} />
          )}
          {prelude.map((p) => <MsgRow key={p.m.id} m={p.m} h={h} mi={p.idx} />)}
          {episodes.map((ep, ei) => {
            const isLatest = ei === episodes.length - 1;
            const grpKey = "ep" + ei;
            const open = !!openGroups[grpKey];
            const recallRows = ep.rows.filter((r) => r.m.kind === "recall");
            const otherRows = ep.rows.filter((r) => r.m.kind !== "recall");
            return (
              <div className="episode" key={"e" + ei}>
                <MsgRow m={ep.user.m} h={h} mi={ep.user.idx} />
                {recallRows.map((r) => <MsgRow key={r.m.id} m={r.m} h={h} mi={r.idx} />)}
                {ep.tools.length > 0 && (
                  <ToolGroup group={ep.tools} startId={ep.user.m.id} past={!isLatest} open={open} onToggle={() => setOpenGroups((s) => ({ ...s, [grpKey]: !s[grpKey] }))} />
                )}
                {otherRows.map((r) => <MsgRow key={r.m.id} m={r.m} h={h} mi={r.idx} />)}
              </div>
            );
          })}
          {h.cur.thinking && (
            <div className="msg agent">
              <div className="a-head"><span className="a-mark">{Ic.spark}</span><span className="a-name">harness-agent</span></div>
              <div className="thinking"><span className="tt">{agentLabel(h.cur.agent)}</span><i /><i /><i /></div>
            </div>
          )}
          {h.cur.deliverables.length > 0 && (
            <DeliverableCard h={h} d={h.cur.deliverables[h.cur.deliverables.length - 1]} onFocusInput={focusInput} />
          )}
        </div>
      </div>
      <Console h={h} text={text} setText={setText} send={send} inputRef={inputRef} prompt={prompt} clearPrompt={() => setPrompt("")} />
    </main>
  );
}

/* ================= 右侧预览面板（简化工具栏 + 当前任务标签 + 过期/停止遮罩） ================= */
function PreviewPane({ h, previewPct, onFocusChat, onFocusPreview }: { h: Harness; previewPct: number; onFocusChat: () => void; onFocusPreview: () => void }) {
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  useEffect(() => { if (h.previewOpen && !loaded) setLoaded(true); }, [h.previewOpen, loaded]);
  /* 只显示当前任务产生的预览标签 */
  const taskTabs = h.wsPreviews.filter((p) => !p.threadId || p.threadId === h.cur.id);
  const historyCount = h.wsPreviews.length - taskTabs.length;
  const tabs = [
    ...h.PREVIEW_PAGES.map((p) => ({ kind: "demo" as const, ...p })),
    ...taskTabs.map((p) => ({ kind: "ws" as const, name: p.name, path: p.path, t: p.t, host: "harness.local" })),
  ];
  const cur = tabs[Math.min(h.previewTab, tabs.length - 1)] ?? tabs[0];
  const src = cur.kind === "demo" ? cur.url : h.toolsCfg.url + "/preview/" + cur.path + "?t=" + cur.t;
  const addr = cur.kind === "demo" ? cur.host : cur.host + "/preview/" + cur.path;
  /* 当前成果的预览状态（驱动遮罩） */
  const curArtifact = cur.kind === "ws" ? h.cur.deliverables.find((d) => d.path === cur.path) : undefined;
  const masked = cur.kind === "ws" && (curArtifact?.preview === "stopped" || curArtifact?.preview === "stale");
  const reload = () => {
    setLoading(true); setError(false);
    const btn = document.getElementById("reloadBtn");
    if (btn) { btn.classList.remove("reload-spin"); void (btn as HTMLElement).offsetWidth; btn.classList.add("reload-spin"); }
    h.reloadPreview();
    if (cur.kind === "ws" && curArtifact) h.refreshPreviewArtifact(cur.path);
  };
  return (
    <aside id="previewPane" className={"preview-pane" + (h.previewOpen ? " open" : "")} style={h.previewOpen ? { width: "calc(" + previewPct + " * (100% - 268px))" } : undefined}>
      <div className="pv-inner" style={h.previewOpen ? { width: "calc(" + previewPct + " * (100% - 268px))" } : undefined}>
        <div className="pv-head">
          <span className="t">{cur.kind === "ws" ? (curArtifact?.name ?? cur.name) : "预览"}</span>
          {historyCount > 0 && <span className="pill mono" title="其他任务的预览标签不在此显示">历史预览 {historyCount}</span>}
          <div className="pv-focus">
            <button className="abtn" onClick={onFocusChat} title="专注对话">对话</button>
            <button className="abtn" onClick={onFocusPreview} title="专注预览">预览</button>
          </div>
          <button className="pv-close" onClick={h.closePreview} title="关闭预览面板">{Ic.chevR}</button>
        </div>
        <div className="browser-bar">
          <div className="tabs-row">
            {tabs.map((p, i) => (
              <div key={p.kind === "demo" ? p.name : p.path} className={"btab" + (h.previewTab === i ? " on" : "")} onClick={() => h.setPreviewTab(i)}>
                <span className="bdot" />{p.name}
                {p.kind === "ws" && <button className="btab-x" title="关闭标签" onClick={(e) => { e.stopPropagation(); h.closeWsPreview(p.path); }}>×</button>}
              </div>
            ))}
          </div>
          <div className="addr-row">
            <div className="nav-btns">
              <button className="abtn" id="reloadBtn" onClick={reload} title="刷新预览">{Ic.reload}</button>
              <button className="abtn" onClick={() => openExternal(src)} title="在浏览器打开">{Ic.monitor}</button>
            </div>
            <div className="address-bar">{Ic.lock}<span className="addr">{addr}</span></div>
            <div className="dev-switch" id="devSwitch">
              <button className={h.device === "desktop" ? "on" : ""} onClick={() => h.setDevice("desktop")} title="桌面">{Ic.monitor}</button>
              <button className={h.device === "tablet" ? "on" : ""} onClick={() => h.setDevice("tablet")} title="平板">{Ic.tablet}</button>
              <button className={h.device === "mobile" ? "on" : ""} onClick={() => h.setDevice("mobile")} title="手机">{Ic.phone}</button>
            </div>
          </div>
        </div>
        <div className="preview-stage">
          {loaded && (
            <div className="pv-stage-inner">
              {loading && <div className="pv-loading">正在加载预览…</div>}
              {error && (
                <div className="pv-error">
                  <div className="pv-err-msg">预览加载失败。可能原因：文件不存在或服务已停止。</div>
                  <button className="btn btn-primary btn-sm" onClick={reload}>重新加载</button>
                </div>
              )}
              {masked && (
                <div className="pv-mask">
                  <div className="pv-mask-msg">{curArtifact?.preview === "stopped" ? "预览服务已停止。当前显示的是上次加载的内容，可能不是最新版本。" : "内容可能不是最新版本，文件已被后续修改。"}</div>
                  <div className="pv-mask-actions">
                    {curArtifact && (
                      <>
                        <button className="btn btn-primary btn-sm" onClick={() => h.restartPreview(curArtifact.path)}>重新启动预览</button>
                        <button className="btn btn-secondary btn-sm" onClick={() => openExternal(src)}>在浏览器打开旧版本</button>
                        <button className="btn btn-secondary btn-sm" onClick={() => h.openDeliverable(curArtifact)}>查看文件</button>
                      </>
                    )}
                  </div>
                </div>
              )}
              <iframe ref={frameRef} id="previewFrame" className={"dev-" + h.device} title="预览" src={src}
                onLoad={() => { setLoading(false); setError(false); }}
                onError={() => { setLoading(false); setError(true); }}
              />
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

/* ================= 命令面板 ================= */
const PALETTE = [
  { name: "新建任务", hint: "⌘N", icon: Ic.plus, run: (h: Harness) => { h.setPaletteOpen(false); h.newChat(); } },
  { name: "打开预览", hint: "", icon: Ic.monitor, run: (h: Harness) => { h.setPaletteOpen(false); h.openPreview(); } },
  { name: "打开设置", hint: "", icon: Ic.gear, run: (h: Harness) => { h.setPaletteOpen(false); h.setSettingsOpen(true); } },
  { name: "清空已确认任务", hint: "", icon: Ic.x, run: (h: Harness) => { h.setPaletteOpen(false); h.clearDone(); } },
  { name: "打开设计文档", hint: "", icon: Ic.doc, run: (h: Harness) => { h.setPaletteOpen(false); h.setPreviewTab(1); h.openPreview(); } },
];

function CommandPalette({ h }: { h: Harness }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const cmds = PALETTE.filter((c) => !q || c.name.includes(q));
  const cur = Math.min(sel, cmds.length - 1);
  useEffect(() => { if (h.paletteOpen) { setQ(""); setSel(0); } }, [h.paletteOpen]);
  if (!h.paletteOpen) return null;
  return (
    <div id="palette" className="show" onClick={(e) => { if (e.target === e.currentTarget) h.setPaletteOpen(false); }}>
      <div className="palette">
        <div className="palette-input">
          {Ic.search}
          <input autoFocus placeholder="搜索命令…" value={q} onChange={(e) => { setQ(e.target.value); setSel(0); }} />
          <span className="kbd">Esc</span>
        </div>
        <div className="palette-list">
          {cmds.length === 0 && <div className="palette-empty">没有匹配的命令</div>}
          {cmds.map((c, i) => (
            <div key={c.name} className={"palette-item" + (i === cur ? " sel" : "")} onMouseMove={() => setSel(i)} onClick={() => c.run(h)}>
              <span className="pi-icon">{c.icon}</span>
              <span className="pi-name">{c.name}</span>
              {c.hint && <span className="pi-hint">{c.hint}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ================= 设置弹窗 ================= */
function SettingsModal({ h }: { h: Harness }) {
  if (!h.settingsOpen) return null;
  return (
    <div id="settingsModal" className="overlay show" onClick={(e) => { if (e.target === e.currentTarget) h.setSettingsOpen(false); }}>
      <div className="sheet">
        <div className="pv-head">
          <span className="t">设置</span>
          <button className="pv-close" onClick={() => h.setSettingsOpen(false)} title="关闭">{Ic.x}</button>
        </div>
        <div className="set-group">
          <div className="g-title">Agent</div>
          <div className="set-row">
            <div><div className="lbl">默认模型</div><div className="desc">对话与执行使用的真实模型</div></div>
            <select className="inp" id="setModel" value={h.model} onChange={(e) => h.setModel(e.target.value)}>
              <option value="deepseek-chat">deepseek-chat（快）</option>
              <option value="deepseek-v4-pro">deepseek-v4-pro（强）</option>
              <option value="deepseek-v4-flash">deepseek-v4-flash（极速）</option>
            </select>
          </div>
          <div className="set-row">
            <div><div className="lbl">执行模式</div><div className="desc">Agent 调用工具前是否需要确认</div></div>
            <select className="inp" value={h.mode} onChange={(e) => h.setMode(e.target.value as ExecMode)}>
              <option value="auto">自动执行</option>
              <option value="confirm">执行前确认</option>
              <option value="plan-only">仅制定计划</option>
            </select>
          </div>
        </div>
        <div className="set-group">
          <div className="g-title">工具执行（Agent Tools）</div>
          <div className="set-row">
            <div><div className="lbl">工具服务地址</div><div className="desc">bash / 文件 / 网页工具后端，默认 http://127.0.0.1:8450</div></div>
            <input className="inp-txt" style={{ width: 180 }} value={h.toolsCfg.url} onChange={(e) => h.setToolsCfg({ ...h.toolsCfg, url: e.target.value })} />
          </div>
          <div className="set-row">
            <div><div className="lbl">工作目录</div><div className="desc">Agent 读写文件的根目录（由工具服务指定）</div></div>
            <span style={{ fontSize: 11, color: "var(--color-ink-muted)", fontFamily: "var(--font-mono)" }}>{h.toolsCfg.workspace ?? "（服务未连接）"}</span>
          </div>
        </div>
        <div className="set-group">
          <div className="g-title">记忆（TencentDB Agent Memory）</div>
          <div className="set-row">
            <div><div className="lbl">启用记忆</div><div className="desc">会话前后自动召回 / 沉淀（L0-L3）</div></div>
            <label className="switch"><input type="checkbox" checked={h.memCfg.enabled} onChange={(e) => h.setMemCfg({ ...h.memCfg, enabled: e.target.checked })} /><span className="track" /><span className="knob" /></label>
          </div>
          <div className="set-row">
            <div><div className="lbl">MemoryCore 地址</div><div className="desc">记忆内核网关，默认 http://127.0.0.1:8420</div></div>
            <input className="inp-txt" style={{ width: 180 }} value={h.memCfg.coreUrl} onChange={(e) => h.setMemCfg({ ...h.memCfg, coreUrl: e.target.value })} />
          </div>
          <div className="set-row">
            <div><div className="lbl">MemoryProxy 地址</div><div className="desc">可选，LLM 代理注入层</div></div>
            <input className="inp-txt" style={{ width: 180 }} value={h.memCfg.serverUrl} onChange={(e) => h.setMemCfg({ ...h.memCfg, serverUrl: e.target.value })} />
          </div>
          <div className="set-row">
            <div><div className="lbl">空间 / 团队</div><div className="desc">对应 Proxy 路径 /{'{space}'}/{'{team}'}</div></div>
            <div style={{ display: "flex", gap: 6 }}>
              <input className="inp-txt" style={{ width: 70 }} value={h.memCfg.spaceId} onChange={(e) => h.setMemCfg({ ...h.memCfg, spaceId: e.target.value })} />
              <input className="inp-txt" style={{ width: 90 }} value={h.memCfg.teamId} onChange={(e) => h.setMemCfg({ ...h.memCfg, teamId: e.target.value })} />
            </div>
          </div>
          <div className="set-row">
            <div><div className="lbl">User Key</div><div className="desc">MemoryHub 签发的 sk-mem-...，留空走本地直连</div></div>
            <input className="inp-txt" style={{ width: 180 }} type="password" placeholder="sk-mem-…" value={h.memCfg.userKey} onChange={(e) => h.setMemCfg({ ...h.memCfg, userKey: e.target.value })} />
          </div>
        </div>
        <div className="set-group">
          <div className="g-title">外观</div>
          <div className="set-row">
            <div><div className="lbl">减弱动态效果</div><div className="desc">关闭过渡与呼吸动画</div></div>
            <label className="switch"><input type="checkbox" checked={h.reduceMotion} onChange={(e) => h.setReduceMotion(e.target.checked)} /><span className="track" /><span className="knob" /></label>
          </div>
        </div>
        <div className="set-group">
          <div className="g-title">快捷键</div>
          <div className="set-row"><div className="lbl">Enter / Shift+Enter</div><div className="desc">发送 / 换行</div></div>
          <div className="set-row"><div className="lbl">⌘K / ⌘N / Esc</div><div className="desc">命令面板 / 新建任务 / 关闭浮层</div></div>
          <div className="set-row"><div className="lbl">⌘W</div><div className="desc">关闭窗口</div></div>
        </div>
        <div className="sheet-foot"><button className="btn btn-primary" onClick={() => h.setSettingsOpen(false)}>完成</button></div>
      </div>
    </div>
  );
}

/* ================= Toast ================= */
function Toasts({ h }: { h: Harness }) {
  return (
    <div id="toasts">
      {h.toasts.map((t) => (
        <div key={t.id} className={"toast " + t.kind}>
          <div className="t-txt"><b>{t.title}</b>{t.msg && <div style={{ opacity: 0.75 }}>{t.msg}</div>}</div>
        </div>
      ))}
    </div>
  );
}

/* ================= App（三栏：侧栏 + 任务区 + 预览区，可拖拽分隔） ================= */
export default function App() {
  const h = useHarness();
  const [sideOpen, setSideOpen] = useState(() => typeof window !== "undefined" && window.innerWidth > 920);
  const [previewPct, setPreviewPct] = useState(0.52);
  const dragging = useRef(false);

  useEffect(() => {
    if (isTauri) {
      import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
        const w = getCurrentWindow();
        w.show();
        w.unminimize();
        w.setFocus();
      });
    }
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const shell = document.querySelector(".shell") as HTMLElement | null;
      if (!shell) return;
      const rect = shell.getBoundingClientRect();
      const avail = rect.width - 268;
      if (avail <= 0) return;
      const pct = Math.min(0.75, Math.max(0.35, (rect.right - e.clientX) / avail));
      setPreviewPct(pct);
    };
    const onUp = () => { dragging.current = false; document.body.classList.remove("resizing"); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); h.setPaletteOpen(!h.paletteOpen); return; }
      if (h.paletteOpen) {
        if (e.key === "Escape") { h.setPaletteOpen(false); return; }
        return;
      }
      if (e.key === "Escape") { h.setSettingsOpen(false); h.closePreview(); return; }
      if (mod && e.key.toLowerCase() === "n") { e.preventDefault(); h.newChat(); return; }
      if (e.isComposing) return;
      if (mod && e.key.toLowerCase() === "w") { e.preventDefault(); winAction("close"); return; }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [h]);

  return (
    <>
      <div id="window" className={"app-on" + (sideOpen ? " side-open" : "") + (h.previewOpen ? " pv-open" : "")}>
        <TitleBar h={h} sideOpen={sideOpen} onToggleSide={() => setSideOpen((v) => !v)} />
        <div className="shell">
          <Sidebar h={h} />
          <ChatView h={h} />
          {h.previewOpen && <div className="pv-divider" title="拖动调整预览宽度" onMouseDown={() => { dragging.current = true; document.body.classList.add("resizing"); }} />}
          {h.cur.kind === "godot" || h.cur.kind === "import_godot"
            ? <GameWorkspace h={h} />
            : <PreviewPane h={h} previewPct={previewPct} onFocusChat={() => h.closePreview()} onFocusPreview={() => setPreviewPct(0.72)} />}
        </div>
      </div>
      <CommandPalette h={h} />
      <SettingsModal h={h} />
      <Toasts h={h} />
    </>
  );
}