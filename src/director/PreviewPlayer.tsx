/* ============================================================================
 * Harness Director — 预览播放器（审片/剪辑用）
 * 播放已下载 Take 资产（本地代理/原始），不调用生成 API。
 * ==========================================================================*/
import { DirectorProject } from "../director";
import { assetUrl } from "../director";

export function PreviewPlayer({ proj, url, pid, assetId }: {
  proj: DirectorProject; url: string; pid: string; assetId?: string | null;
}) {
  const asset = assetId ? proj.assets?.find((a) => a.assetId === assetId) : null;
  const src = asset && asset.path ? assetUrl(url, pid, asset.path) : null;
  return (
    <div className="d-player">
      {src ? (
        <video key={src} src={src + "?t=" + (asset ? asset.path.length : 0)} controls playsInline />
      ) : (
        <div className="d-player-empty">
          <div className="d-player-glyph">▶</div>
          <div>选择已生成 Take 后在此预览（本地素材，不触发生成）</div>
        </div>
      )}
    </div>
  );
}
