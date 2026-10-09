/* ============================================================================
 * Harness Director — 时间线面板（仅剪辑阶段常驻）
 * 可调高度（顶边拖动）；显示 V1/A1 轨道、片段、转场、字幕。
 * ==========================================================================*/
import { useRef, useState } from "react";
import { DirectorProject } from "../director";

export function TimelinePanel({ proj, onSelectClip }: { proj: DirectorProject; onSelectClip: (clipId: string) => void }) {
  const [height, setHeight] = useState(168);
  const dragging = useRef(false);
  const total = proj.timeline?.videoTracks?.reduce((m, t) => t.clips.reduce((x, c) => Math.max(x, c.end || 0), m), 0) || 1;

  return (
    <div className="d-timeline" style={{ height }} onMouseDown={(e) => { if ((e.target as HTMLElement).dataset?.resize) { dragging.current = true; } }}>
      {dragging && (
        <div className="d-tl-resize"
          onMouseMove={(e) => {
            const r = document.querySelector(".d-timeline")?.getBoundingClientRect();
            if (r) setHeight(Math.min(360, Math.max(96, r.bottom - e.clientY)));
          }}
          onMouseUp={() => { dragging.current = false; }}
        />
      )}
      <div className="d-tl-ruler"><span className="d-tl-total">总时长 {total.toFixed(1)}s</span></div>
      {(proj.timeline?.videoTracks || []).map((t) => (
        <div key={t.id} className="d-tl-track">
          <span className="d-tl-id mono">{t.id}</span>
          <div className="d-tl-clips">
            {t.clips.length === 0 && <span className="d-tl-empty">空轨道</span>}
            {t.clips.map((c) => (
              <div key={c.clipId} className="d-tl-clip" style={{ left: (c.start / total) * 100 + "%", width: Math.max(3, ((c.end - c.start) / total) * 100) + "%" }}
                onClick={() => onSelectClip(c.clipId)} title={c.shotId + " " + c.start?.toFixed(1) + "–" + c.end?.toFixed(1) + "s"}>
                <span className="mono">{c.shotId}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
      {(proj.timeline?.audioTracks || []).map((t) => (
        <div key={t.id} className="d-tl-track audio">
          <span className="d-tl-id mono">{t.id}</span>
          <div className="d-tl-clips">
            {(t.clips as { clipId?: string; label?: string; start?: number; duration?: number }[]).map((c, i) => (
              <div key={c.clipId || i} className="d-tl-clip audio" style={{ left: ((c.start || 0) / total) * 100 + "%", width: Math.max(3, ((c.duration || 0) / total) * 100) + "%" }}>
                {c.label || "音频"}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
