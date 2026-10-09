/* ============================================================================
 * Harness Director — 生成队列（生成页核心）
 * 每个任务：镜头/模型/参数/预计费用/状态/进度/Take/缓存命中/重试
 * ==========================================================================*/
import { DirectorProject } from "../director";
import { taskBadge, yuan, shortId } from "./design";

export function GenerationQueue({ proj, onPoll }: { proj: DirectorProject; onPoll: () => void }) {
  const tasks = proj.generationTasks || [];
  const queue = tasks.slice().reverse();
  return (
    <div className="d-pane">
      <div className="d-pane-head">
        <h3>生成队列</h3>
        <button className="btn btn-secondary btn-sm" onClick={onPoll}>刷新</button>
      </div>
      {queue.length === 0 && (
        <div className="d-inline-empty">暂无生成任务。选择镜头后点击「生成镜头」，确认费用后提交（相同请求会命中缓存，不重复计费）。</div>
      )}
      {queue.map((t) => {
        const b = taskBadge(t.status);
        const shot = proj.shots?.find((s) => s.shotId === t.shotId);
        const cacheHit = Boolean((shot?.takes || []).some((tk) => tk.generationKey && tk.generationKey === (t as { generationKey?: string }).generationKey));
        return (
          <div key={t.taskId} className={"d-queue-item" + (t.status === "failed" ? " err" : "")}>
            <div className="d-queue-main">
              <div className="d-queue-title">
                <span className="mono">{shortId(t.taskId, 14)}</span>
                <span className={"d-badge " + b.cls}>{b.label}</span>
                {cacheHit && <span className="d-badge ok">缓存命中</span>}
              </div>
              <div className="d-queue-meta">
                <span>镜头：{t.shotId}</span>
                <span>模型：{t.model || "—"}</span>
                <span>预计：{yuan(t.estimatedCost)}</span>
                {t.errorKind === "download" && <span className="d-queue-dl">下载失败（仅可重试下载，不会重新生成）</span>}
              </div>
              {t.error && <div className="d-queue-err">{String(t.error).slice(0, 160)}</div>}
            </div>
          </div>
        );
      })}
      <div className="d-pane-foot">任何「生成」「重新生成」都会在确认面板显示费用；改字幕/转场/音量只触发本地重新导出。</div>
    </div>
  );
}
