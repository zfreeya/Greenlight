/* ============================================================================
 * Harness Director — 工作流导航（策划/剧本/分镜/生成/剪辑/审片/导出）
 * 带完成/警告圆点（不只表达选中）；<1180px 时压缩为「当前步骤 + 流程下拉」。
 * ==========================================================================*/
import { useState } from "react";
import { DirectorProject } from "../director";
import { DirStage, STAGE_ITEMS } from "./design";

export function WorkflowNavigation({ stage, onChange, proj }: {
  stage: DirStage; onChange: (s: DirStage) => void; proj: DirectorProject;
}) {
  const dots = stageDots(proj);
  return (
    <nav className="d-nav" aria-label="工作流">
      {STAGE_ITEMS.map((s) => (
        <button
          key={s.id}
          className={"d-nav-item" + (stage === s.id ? " on" : "")}
          onClick={() => onChange(s.id)}
          aria-current={stage === s.id ? "step" : undefined}
          title={s.label + (dots[s.id] ? (dots[s.id]!.warn ? "（有异常）" : "（有进展）") : "")}
        >
          <span className="d-nav-icon">{s.icon}</span>
          <span className="d-nav-label">{s.label}</span>
          {dots[s.id] && <span className={"d-nav-dot " + (dots[s.id]!.warn ? "warn" : "ok")} />}
        </button>
      ))}
    </nav>
  );
}

/** 各阶段完成/警告圆点（基于真实项目数据） */
function stageDots(proj: DirectorProject): Partial<Record<DirStage, { ok?: boolean; warn?: boolean }>> {
  const shots = proj.shots || [];
  const takes = shots.reduce((n, s) => n + (s.takes?.length || 0), 0);
  const hasBrief = Boolean(proj.purpose || proj.coreMessage);
  const hasShots = shots.length > 0;
  const hasGenerated = shots.some((s) => s.clipAssetId || s.takes?.length);
  const placed = (proj.timeline?.videoTracks || []).some((t) => t.clips.length);
  const hasQc = shots.some((s) => s.qc);
  const hasExport = (proj.renderJobs || []).length > 0;
  return {
    plan: hasBrief ? { ok: true } : undefined,
    script: hasShots ? { ok: true } : undefined,
    shots: hasShots ? { ok: true } : undefined,
    generation: hasGenerated ? { ok: true } : (shots.length ? { warn: true } : undefined),
    edit: placed ? { ok: true } : undefined,
    review: hasQc ? { ok: true } : undefined,
    export: hasExport ? { ok: true } : undefined,
  };
}
