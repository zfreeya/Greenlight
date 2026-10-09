/* ================= Harness 状态模型（四源独立，界面状态一一对应） ================= */

/* 任务状态：任务级语义 */
export type TaskStatus =
  | "idle"                 // 空闲（新任务）
  | "running"              // 执行中
  | "waiting_for_input"    // 等待用户输入
  | "waiting_for_approval" // 等待用户授权（计划待确认）
  | "waiting_for_review"   // 等待验收（成果已出，待检查）
  | "completed"            // 用户已确认
  | "failed"               // 执行失败
  | "cancelled";           // 已取消（用户停止）

/* Agent 状态：Agent 生命周期 */
export type AgentStatus =
  | "idle"       // 空闲
  | "thinking"   // 思考中（请求模型）
  | "using_tool" // 正在执行工具
  | "waiting"    // 等待（计划/选项等用户响应）
  | "stopped"    // 已停止
  | "error";     // 出错

/* 预览状态：预览面板/成果的在线状态 */
export type PreviewStatus =
  | "not_created"   // 尚未创建
  | "starting"      // 正在启动
  | "online"        // 在线（真实探测确认）
  | "stopped"       // 已停止（用户关闭服务）
  | "loading_failed"// 加载失败（文件缺失/服务不可达）
  | "stale";        // 过期（文件已更新，当前显示旧版本）

/* 成果状态：交付物本身的生成状态 */
export type ArtifactStatus =
  | "generating" // 生成中
  | "ready"      // 就绪
  | "outdated"   // 过期（文件被后续改写）
  | "failed";    // 生成失败

export type MsgKind = "ask" | "recall" | "plan" | "text" | "tool";

export interface Msg {
  id: number;
  role: "user" | "agent";
  kind?: MsgKind;
  text?: string;
  chip?: string;
  opts?: string[];
  picked?: number;
  items?: string[];
  atoms?: string[];
  time?: string;
  /* kind === "tool"：真实工具执行活动 */
  toolName?: string;
  toolArgs?: string;
  toolStatus?: "running" | "done" | "error";
  toolResult?: string;
}

export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

/* 成果（交付物）：一等对象，携带成果状态与预览状态 */
export interface Deliverable {
  path: string;            // 文件名（磁盘真实路径）
  name: string;            // 成果名称（展示名）
  t: number;               // 最近更新（epoch ms）
  type: string;            // 网页 / Markdown / 图片 / 文档 ...
  artifact: ArtifactStatus;
  preview: PreviewStatus;
  error?: string;          // 失败原因（生成失败 / 预览失败）
  sourceFile?: string;     // 来源文件（仅存在转换关系时显示）
}

export interface Thread {
  id: string;
  title: string;
  kind: TaskKind;           // 任务标题（用户目标）
  status: TaskStatus;
  agent: AgentStatus;
  msgs: Msg[];
  thinking: boolean;       // 派生：agent ∈ {thinking, using_tool}
  todos: Todo[];
  deliverables: Deliverable[];
  updatedAt: number;
}

export const now = () =>
  `${String(new Date().getHours()).padStart(2, "0")}:${String(new Date().getMinutes()).padStart(2, "0")}`;

let tid = 1;
export function newThread(): Thread {
  return {
    id: "C-" + tid++,
    title: "新任务",
    kind: "general",
    status: "waiting_for_input",
    agent: "idle",
    msgs: [],
    thinking: false,
    todos: [],
    deliverables: [],
    updatedAt: Date.now(),
  };
}

export function greetingMsg(): Msg {
  return {
    id: Date.now(),
    role: "agent",
    kind: "text",
    text: "你好，我是 harness-agent。我可以直接动手：浏览代码仓库、读写文件、运行命令、查资料、写代码。想做什么？",
    time: now(),
  };
}

/* 任务状态 → 视觉类 / 标签 / 悬停解释 */
export function statusBadge(s: TaskStatus): { cls: string; label: string; tip: string } {
  switch (s) {
    case "running": return { cls: "active", label: "执行中", tip: "Agent 正在执行任务" };
    case "waiting_for_approval": return { cls: "active", label: "等待用户授权", tip: "计划已就绪，确认后才执行" };
    case "waiting_for_input": return { cls: "neutral", label: "等待用户输入", tip: "等待你继续输入或选择" };
    case "waiting_for_review": return { cls: "done", label: "等待验收", tip: "Agent 已完成执行，请检查预览结果并决定是否继续修改" };
    case "completed": return { cls: "done", label: "用户已确认", tip: "你已确认本次成果" };
    case "failed": return { cls: "error", label: "执行失败", tip: "执行出现错误，可查看详情后重试" };
    case "cancelled": return { cls: "neutral", label: "已取消", tip: "本次执行已被停止，成果仍保留" };
    default: return { cls: "neutral", label: "准备中", tip: "任务准备中" };
  }
}

/* Agent 状态 → 标签 */
export function agentLabel(a: AgentStatus): string {
  switch (a) {
    case "thinking": return "正在思考";
    case "using_tool": return "正在执行工具";
    case "waiting": return "等待你的回应";
    case "stopped": return "已停止";
    case "error": return "出错";
    default: return "空闲";
  }
}

/* 任务标题：单一数据源（侧栏/顶栏共用）。有成果时派生自当前任务成果，否则用用户标题。 */
export function taskTitle(t: Thread): string {
  if (t.deliverables.length > 0) {
    const d = t.deliverables[t.deliverables.length - 1];
    return d.name.replace(/\.html?$/i, "") + " 预览";
  }
  return t.title && t.title !== "新任务" ? t.title : "新任务";
}

export function formatRelative(epoch: number): string {
  const diff = Date.now() - epoch;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + " 分钟前";
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + " 小时前";
  const d = new Date(epoch);
  return d.getMonth() + 1 + "月" + d.getDate() + "日 " + formatClock(epoch);
}

export function formatClock(epoch: number): string {
  return `${String(new Date(epoch).getHours()).padStart(2, "0")}:${String(new Date(epoch).getMinutes()).padStart(2, "0")}`;
}

/* 执行模式 */
/* ================= Godot 能力状态模型（真实服务驱动） ================= */
export type TaskKind = "general" | "web" | "godot" | "import_godot" | "director";
export type EngineStatus = "unavailable" | "detecting" | "downloading" | "installing" | "ready" | "incompatible" | "crashed";
export type GameStatus = "stopped" | "starting" | "running" | "paused" | "crashed";
export type ProjectStatus = "unknown" | "creating" | "importing" | "ready" | "invalid" | "missing_dependencies";

export function engineLabel(s: EngineStatus): string {
  switch (s) {
    case "detecting": return "检测中";
    case "downloading": return "下载中";
    case "installing": return "安装中";
    case "ready": return "就绪";
    case "incompatible": return "版本不兼容";
    case "crashed": return "已崩溃";
    default: return "未安装";
  }
}
export function gameLabel(s: GameStatus): string {
  switch (s) {
    case "starting": return "启动中";
    case "running": return "运行中";
    case "paused": return "已暂停";
    case "crashed": return "已崩溃";
    default: return "已停止";
  }
}

export type ExecMode = "auto" | "confirm" | "plan-only";
export const EXEC_MODES: { id: ExecMode; label: string; desc: string }[] = [
  { id: "auto", label: "自动执行", desc: "Agent 自主调用工具执行，可能修改文件、运行命令" },
  { id: "confirm", label: "执行前确认", desc: "Agent 每次调用工具前先征求你的授权" },
  { id: "plan-only", label: "仅制定计划", desc: "Agent 只输出计划与方案，不执行任何工具" },
];