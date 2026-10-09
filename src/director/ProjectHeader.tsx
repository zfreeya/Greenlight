/* ============================================================================
 * Harness Director — 项目头栏（单一权威：项目名 + 工作流 + 系统状态）
 * 原则（按设计评审）：
 *  - 项目名是全页面唯一权威名称（窗口/侧栏/头栏同步）；
 *  - 不显示伪「保存状态」、不显示「阶段：X」Pill（Tab 即当前工作区，非阶段）；
 *  - 顶部不放置「导出」主按钮（导出只在导出页有主操作）；
 *  - 「预览」改为「进入剪辑」（真实行为，不名实不符）；
 *  - 技术参数收纳进「项目状态」Popover；异常时头栏出现持续可见的系统状态点。
 * ==========================================================================*/
import { DirectorProject } from "../director";
import { DirStage } from "./design";
import { WorkflowNavigation } from "./WorkflowNavigation";
import { ProjectStatusPopover } from "./ProjectStatusPopover";

export function ProjectHeader({ proj, stage, onStage, ffmpeg, providerChips, systemWarn, onOpenEdit, onSetModel, onSetPaidCap }: {
  proj: DirectorProject;
  stage: DirStage;
  onStage: (s: DirStage) => void;
  ffmpeg: { available?: boolean | null };
  providerChips: { label: string; cls: string }[];
  systemWarn: boolean;
  onOpenEdit: () => void;
  onSetModel?: (model: string) => Promise<void>;
  onSetPaidCap?: (cap: number) => Promise<void>;
}) {
  return (
    <header className="d-header">
      <div className="d-header-left">
        <span className="d-proj-name" title={proj.title}>{proj.title}</span>
      </div>

      <WorkflowNavigation stage={stage} onChange={onStage} proj={proj} />

      <div className="d-header-right">
        {/* 系统状态：有异常时持续可见（非一次性 Toast） */}
        {systemWarn && <span className="d-syswarn" title="系统异常：FFmpeg 缺失或 Provider 不可用，详见项目状态">⚠</span>}
        <ProjectStatusPopover proj={proj} ffmpeg={ffmpeg} providerChips={providerChips} onSetModel={onSetModel} onSetPaidCap={onSetPaidCap} />
        <button className="btn btn-secondary btn-sm" onClick={onOpenEdit} title="进入剪辑工作区（播放器 + 时间线）">进入剪辑</button>
      </div>
    </header>
  );
}
