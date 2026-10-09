/* ============================================================================
 * Harness Director — 导出任务面板（导出页）
 * 输出预设/分辨率/编码/音频/输出路径/进度/历史版本
 * ==========================================================================*/
import { DirectorProject } from "../director";
import { taskBadge, formatTime } from "./design";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function RenderJobPanel({ proj, url, pid, onExport, busy, onSelectJob }: {
  proj: DirectorProject; url: string; pid: string; onExport: () => void; busy: string | null; onSelectJob: (id: string) => void;
}) {
  const jobs = (proj.renderJobs || []).slice().reverse();
  return (
    <div className="d-pane">
      <div className="d-pane-head">
        <h3>导出</h3>
      </div>
      <div className="d-export-presets">
        <span className="d-export-preset-note">导出预设：H.264 + AAC · 1080p · yuv420p + faststart · 48kHz（FFmpeg 本地渲染，不调用视频生成）</span>
      </div>
      {jobs.length === 0 && <div className="d-inline-empty">尚无导出任务。导出只使用本地素材（FFmpeg），不会调用视频生成。</div>}
      {jobs.map((j) => {
        const b = taskBadge(j.status);
        return (
          <button key={j.renderJobId} className="d-job-row" onClick={() => onSelectJob(j.renderJobId)}>
            <div className="d-job-head">
              <span className="mono">{j.renderJobId}</span>
              <span className={"d-badge " + b.cls}>{b.label}</span>
            </div>
            <div className="d-job-meta">
              <span>{j.outputProfile}</span>
              <span>{j.inputAssets?.length || 0} 个输入</span>
              <span>{formatTime(j.finishedAt || j.createdAt)}</span>
            </div>
            {j.outputPath && (
              <div className="d-job-out mono">…/{j.outputPath.split("/").slice(-1)[0]}</div>
            )}
            {j.outputPath && (
              <div className="d-job-actions">
                <button className="btn btn-secondary btn-sm" onClick={(e) => { e.stopPropagation(); openExport(j.outputPath!, url, pid); }} title={j.outputPath}>
                  {isTauri ? "打开" : "下载"}
                </button>
                {isTauri && (
                  <button className="btn btn-secondary btn-sm" onClick={(e) => { e.stopPropagation(); revealExport(j.outputPath!); }} title="在访达中定位该文件">在访达中显示</button>
                )}
              </div>
            )}
            {j.error && <div className="d-job-err">{String(j.error).slice(0, 140)}</div>}
          </button>
        );
      })}
    </div>
  );
}

function openExport(outputPath: string, url: string, pid: string) {
  const file = outputPath.split("/").slice(-1)[0];
  if (isTauri) {
    import("@tauri-apps/plugin-opener").then((m) => m.openPath(outputPath).catch(() => undefined));
  } else {
    window.open(url + "/export/" + encodeURIComponent(pid) + "/" + encodeURIComponent(file), "_blank");
  }
}
function revealExport(outputPath: string) {
  import("@tauri-apps/plugin-opener").then((m) => m.revealItemInDir(outputPath).catch(() => undefined));
}
