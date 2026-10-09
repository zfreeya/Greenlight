/* ============================================================================
 * Harness Director — 上下文检查器（仅选中对象时显示，可收起）
 * 对象：Scene / Shot / Take / Timeline Clip / RenderJob / 全局
 * ==========================================================================*/
import { useState } from "react";
import { DirectorProject, DirectorShot, DirectorTake } from "../director";
import { shotBadge, taskBadge, yuan, shortId } from "./design";

export type InspectTarget =
  | { type: "shot"; shotId: string }
  | { type: "take"; shotId: string; takeId: string }
  | { type: "clip"; clipId: string }
  | { type: "renderjob"; renderJobId: string }
  | { type: "scene"; sceneId: string }
  | { type: "global" };

export function ContextInspector({ proj, target, action, busy, onGenerate }: {
  proj: DirectorProject;
  target: InspectTarget | null;
  action: (t: string, a?: Record<string, unknown>) => Promise<unknown>;
  busy: string | null;
  onGenerate?: (shotId: string) => void;
}) {
  if (!target) return null;
  if (target.type === "global") return <GlobalInspector proj={proj} />;
  if (target.type === "shot") return <ShotInspector proj={proj} shotId={target.shotId} action={action} busy={busy} onGenerate={onGenerate} />;
  if (target.type === "take") return <TakeInspector proj={proj} shotId={target.shotId} takeId={target.takeId} action={action} busy={busy} />;
  if (target.type === "clip") return <ClipInspector proj={proj} clipId={target.clipId} action={action} busy={busy} />;
  if (target.type === "renderjob") return <RenderJobInspector proj={proj} renderJobId={target.renderJobId} />;
  if (target.type === "scene") return <SceneInspector proj={proj} sceneId={target.sceneId} />;
  return null;
}

function Row({ k, v, mono }: { k: string; v?: string | number | null; mono?: boolean }) {
  if (v === undefined || v === null || v === "") return null;
  return <div className="d-ikv"><span className="d-ikv-k">{k}</span><span className={"d-ikv-v" + (mono ? " mono" : "")}>{v}</span></div>;
}

function GlobalInspector({ proj }: { proj: DirectorProject }) {
  const b = proj.bible || {};
  return (
    <div className="d-insp">
      <h4>创作简报</h4>
      <Row k="目的" v={proj.purpose} />
      <Row k="核心信息" v={proj.coreMessage} />
      <Row k="受众" v={proj.targetAudience} />
      <Row k="平台" v={proj.targetPlatform} />
      <h4>导演设定</h4>
      <Row k="角色" v={(b.characters?.length || 0) + " 位"} />
      <Row k="场景" v={(b.locations?.length || 0) + " 个"} />
      <Row k="质感" v={b.visual?.texture} />
      {!proj.purpose && !proj.coreMessage && <div className="d-insp-hint">尚无创作简报。点击「让导演 Agent 制定方案」开始。</div>}
    </div>
  );
}

function ShotInspector({ proj, shotId, action, busy, onGenerate }: { proj: DirectorProject; shotId: string; action: (t: string, a?: Record<string, unknown>) => Promise<unknown>; busy: string | null; onGenerate?: (shotId: string) => void }) {
  const shot: DirectorShot | undefined = proj.shots?.find((s) => s.shotId === shotId);
  if (!shot) return <div className="d-insp">镜头不存在</div>;
  const b = shotBadge(shot.status);
  const takes = shot.takes || [];
  return (
    <div className="d-insp">
      <div className="d-insp-head">
        <span className="mono">{shot.shotId}</span>
        <span className={"d-badge " + b.cls}>{b.label}</span>
      </div>
      <Row k="叙事目的" v={shot.narrativePurpose} />
      <Row k="主体" v={shot.subject} />
      <Row k="动作" v={shot.primaryAction} />
      <Row k="起止状态" v={[shot.startState, shot.endState].filter(Boolean).join(" → ")} />
      <Row k="景别/角度" v={[shot.shotSize, shot.angle].filter(Boolean).join(" / ")} />
      <Row k="运镜" v={[shot.cameraPosition, shot.cameraMovement].filter(Boolean).join(" / ")} />
      <Row k="光线/色彩" v={[shot.lighting, shot.color].filter(Boolean).join(" / ")} />
      <Row k="时长" v={shot.duration ? shot.duration + "s" : null} />
      {shot.dirty?.generation && <div className="d-insp-hint warn">提示词已变更，需重新生成（新 Take，不覆盖旧版）。</div>}
      {takes.length > 0 && (
        <>
          <h4>Take（{takes.length}）</h4>
          {takes.map((t) => {
            const tb = taskBadge(t.status);
            return (
              <div key={t.takeId} className={"d-take-row" + (shot.selectedTakeId === t.takeId ? " sel" : "")}>
                <span className="mono">{shortId(t.takeId, 12)}</span>
                <span className={"d-badge " + tb.cls}>{tb.label}</span>
                {t.errorKind === "download" && <span className="d-insp-hint">下载失败</span>}
              </div>
            );
          })}
        </>
      )}
      <div className="d-insp-actions">
        <button className="btn btn-secondary btn-sm" onClick={() => action("compile_generation_prompt", { shotId, provider: "seedance" })} disabled={busy !== null}>编译提示词</button>
        {onGenerate && (
          <button className="btn btn-primary btn-sm" onClick={() => onGenerate(shotId)} disabled={busy !== null} title="提交前会显示费用确认（Seedance）；相同请求命中缓存不重复计费">生成镜头</button>
        )}
      </div>
    </div>
  );
}

function TakeInspector({ proj, shotId, takeId, action, busy }: { proj: DirectorProject; shotId: string; takeId: string; action: (t: string, a?: Record<string, unknown>) => Promise<unknown>; busy: string | null }) {
  const shot = proj.shots?.find((s) => s.shotId === shotId);
  const take: DirectorTake | undefined = shot?.takes?.find((t) => t.takeId === takeId);
  if (!take) return <div className="d-insp">Take 不存在</div>;
  const tb = taskBadge(take.status);
  const asset = proj.assets?.find((a) => a.assetId === take.assetId);
  return (
    <div className="d-insp">
      <div className="d-insp-head">
        <span className="mono">{shortId(take.takeId, 14)}</span>
        <span className={"d-badge " + tb.cls}>{tb.label}</span>
      </div>
      <Row k="模型" v={take.model} mono />
      <Row k="generation_key" v={take.generationKey ? shortId(take.generationKey, 16) : null} mono />
      <Row k="文件哈希" v={take.fileHash ? shortId(take.fileHash, 12) : null} mono />
      <Row k="尺寸/时长" v={take.width ? take.width + "×" + take.height + " · " + (take.duration ?? "?") + "s" : null} />
      <Row k="编码" v={take.codec} mono />
      {take.error && <div className="d-insp-hint err">{take.errorKind === "download" ? "下载失败：" : "生成失败："}{take.error}</div>}
      {asset && <Row k="资产" v={asset.assetId} mono />}
      <div className="d-insp-actions">
        <button className="btn btn-secondary btn-sm" onClick={() => action("select_take", { shotId, takeId })} disabled={busy !== null}>选用此 Take</button>
        {take.errorKind === "download" && (
          <button className="btn btn-secondary btn-sm" onClick={() => action("retry_download", { shotId, takeId })} disabled={busy !== null}>重试下载</button>
        )}
        <button className="btn btn-secondary btn-sm" onClick={() => action("lock_take", { shotId, takeId })} disabled={busy !== null}>锁定</button>
      </div>
      <div className="d-insp-foot">注意：重新生成会创建新 Take，不会覆盖本版。</div>
    </div>
  );
}

function ClipInspector({ proj, clipId, action, busy }: { proj: DirectorProject; clipId: string; action: (t: string, a?: Record<string, unknown>) => Promise<unknown>; busy: string | null }) {
  const clip = proj.timeline?.videoTracks?.flatMap((t) => t.clips).find((c) => c.clipId === clipId);
  if (!clip) return <div className="d-insp">片段不存在</div>;
  return (
    <div className="d-insp">
      <h4>片段 {shortId(clip.clipId, 12)}</h4>
      <Row k="镜头" v={clip.shotId} mono />
      <Row k="入点/出点" v={clip.start?.toFixed(1) + "s – " + clip.end?.toFixed(1) + "s"} />
      <Row k="音量" v={clip.volume != null ? Math.round(clip.volume * 100) + "%" : null} />
      <Row k="淡入/淡出" v={(clip.fadeIn ? clip.fadeIn + "s" : "0") + " / " + (clip.fadeOut ? clip.fadeOut + "s" : "0")} />
      <div className="d-insp-actions">
        <button className="btn btn-secondary btn-sm" onClick={() => action("update_clip", { clipId, volume: 0.5, fadeIn: 0.5 })} disabled={busy !== null}>降半音量</button>
        <button className="btn btn-secondary btn-sm" onClick={() => action("update_clip", { clipId, mute: true })} disabled={busy !== null}>静音</button>
      </div>
      <div className="d-insp-foot">编辑片段只标记「需重新导出」，不会触发视频生成。</div>
    </div>
  );
}

function RenderJobInspector({ proj, renderJobId }: { proj: DirectorProject; renderJobId: string }) {
  const job = proj.renderJobs?.find((j) => j.renderJobId === renderJobId);
  if (!job) return <div className="d-insp">导出任务不存在</div>;
  return (
    <div className="d-insp">
      <h4>导出任务 {job.renderJobId}</h4>
      <Row k="状态" v={job.status} />
      <Row k="输出" v={job.outputPath ? "…/" + job.outputPath.split("/").slice(-1)[0] : null} mono />
      <Row k="输出配置" v={job.outputProfile} mono />
      <Row k="输入资产" v={(job.inputAssets?.length || 0) + " 个"} />
      {job.error && <div className="d-insp-hint err">{String(job.error).slice(0, 200)}</div>}
    </div>
  );
}

function SceneInspector({ proj, sceneId }: { proj: DirectorProject; sceneId: string }) {
  const scene = proj.scenes?.find((s) => s.sceneId === sceneId);
  if (!scene) return <div className="d-insp">场景不存在</div>;
  return (
    <div className="d-insp">
      <h4>{scene.title || scene.sceneId}</h4>
      <Row k="剧情目的" v={scene.narrativePurpose} />
      <Row k="时间" v={scene.timeOfDay} />
      <Row k="情绪" v={scene.mood} />
      <Row k="色彩" v={scene.color} />
      <Row k="声音设计" v={scene.soundDesign} />
      <Row k="镜头" v={(scene.shotIds?.length || 0) + " 个"} />
    </div>
  );
}

export { shotBadge };
