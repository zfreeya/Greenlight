/* ============================================================================
 * Harness Director — 设计工具（产品语言统一 / 状态标签 / 格式化）
 * 产品语言：创作简报 / 导演设定 / 镜头 / Take / 检查器 / 导出任务
 * ==========================================================================*/

/** 阶段（工作流导航） */
export type DirStage = "plan" | "script" | "shots" | "generation" | "edit" | "review" | "export";

export const STAGE_ITEMS: { id: DirStage; label: string; icon: string }[] = [
  { id: "plan", label: "策划", icon: "◈" },
  { id: "script", label: "剧本", icon: "✎" },
  { id: "shots", label: "分镜", icon: "▦" },
  { id: "generation", label: "生成", icon: "▶" },
  { id: "edit", label: "剪辑", icon: "▤" },
  { id: "review", label: "审片", icon: "◎" },
  { id: "export", label: "导出", icon: "⇧" },
];

/** 后端 phase → 前端阶段映射 */
export const PHASE_TO_STAGE: Record<string, DirStage> = {
  intake: "plan", story: "script", direction: "plan", rhythm: "plan", script_lock: "script",
  shot_design: "shots", storyboard: "shots", keyframes: "shots", generation: "generation",
  edit: "edit", sound: "edit", review: "review", export: "export", completed: "export",
};

export const STAGE_LABELS: Record<string, string> = {
  plan: "策划", script: "剧本", shots: "分镜", generation: "生成", edit: "剪辑", review: "审片", export: "导出",
};

/** 镜头状态 → 徽标 */
export function shotBadge(status: string): { label: string; cls: string } {
  const map: Record<string, [string, string]> = {
    planned: ["已计划", "neutral"], approved: ["已批准", "ok"], prompt_ready: ["提示词就绪", "accent"],
    generating: ["生成中", "accent"], generated: ["已生成", "ok"], qc_failed: ["未过审", "err"],
    repair_planned: ["待修复", "warn"], approved_clip: ["已通过", "ok"],
    placed_on_timeline: ["已上时间线", "ok"], locked: ["已锁定", "ok"],
  };
  const m = map[status] || [status, "neutral"];
  return { label: m[0], cls: m[1] };
}

/** Take/Task 状态 → 徽标（统一状态机） */
export function taskBadge(status: string): { label: string; cls: string } {
  const map: Record<string, [string, string]> = {
    draft: ["草稿", "neutral"], awaiting_approval: ["待确认", "warn"], queued: ["排队中", "accent"],
    generating: ["生成中", "accent"], succeeded: ["待下载", "accent"], failed: ["失败", "err"],
    cancelled: ["已取消", "neutral"], downloading: ["下载中", "accent"], ready_for_review: ["可审阅", "ok"],
    selected: ["已选用", "ok"], locked: ["已锁定", "ok"], running: ["运行中", "accent"],
  };
  const m = map[status] || [status, "neutral"];
  return { label: m[0], cls: m[1] };
}

/** 金额（分 → 元） */
export function yuan(fen?: number | null): string {
  const v = Number(fen ?? 0);
  return "¥" + (v / 100).toFixed(2);
}

export function formatTime(epoch?: number): string {
  if (!epoch) return "—";
  const d = new Date(epoch);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function shortId(id: string, n = 10): string {
  return id.length > n ? id.slice(0, n) : id;
}
