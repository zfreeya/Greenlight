/* ============================================================================
 * Harness Director — 镜头卡片（分镜页视觉中心，P8-1：真实缩略图）
 *  - 优先：已批准/已选用 Take 的视频首帧（<video preload="metadata">，WebKit 兼容）
 *  - 其次：asset.manifest 提取帧图片
 *  - 都没有时：文字占位（景别/编号）
 * 显示：编号/时长/景别/运镜/人物/场景/连续性/生成状态/Take 数
 * ==========================================================================*/
import { DirectorShot } from "../director";
import { shotBadge } from "./design";

export function ShotCard({ shot, frameUrl, selected, onSelect }: {
  shot: DirectorShot; frameUrl?: string | null; selected: boolean; onSelect: () => void;
}) {
  const b = shotBadge(shot.status);
  const takes = shot.takes || [];
  const genDirty = Boolean(shot.dirty?.generation);
  const isVideo = Boolean(frameUrl && /\.(mp4|mov|webm)(\?|#|$)/i.test(frameUrl));
  return (
    <button className={"d-shot-card" + (selected ? " on" : "")} onClick={onSelect} aria-pressed={selected}>
      <div className="d-shot-thumb">
        {frameUrl && isVideo ? (
          <video
            src={frameUrl + (frameUrl.includes("#") ? "" : "#t=0.1")}
            muted playsInline preload="metadata"
            onError={(e) => { (e.target as HTMLVideoElement).style.display = "none"; }}
          />
        ) : frameUrl ? (
          <img src={frameUrl} alt="" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
        ) : (
          <span className="d-shot-thumb-ph">{shot.shotSize || "分镜"}</span>
        )}
        <span className="d-shot-id mono">{shot.shotId}</span>
      </div>
      <div className="d-shot-body">
        <div className="d-shot-title-row">
          <span className={"d-badge " + b.cls}>{b.label}</span>
          {genDirty && <span className="d-badge warn">需重新生成</span>}
          {takes.length > 0 && <span className="d-shot-takes">Take×{takes.length}</span>}
        </div>
        <div className="d-shot-sub" title={shot.subject || shot.narrativePurpose}>{shot.subject || shot.narrativePurpose || "（无描述）"}</div>
        <div className="d-shot-meta">
          <span>{shot.duration}s</span>
          {shot.shotSize && <span>{shot.shotSize}</span>}
          {shot.cameraMovement && <span>{shot.cameraMovement}</span>}
        </div>
      </div>
    </button>
  );
}
