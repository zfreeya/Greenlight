/* ============================================================================
 * Harness Director — 七个阶段页面（策划/剧本/分镜/生成/剪辑/审片/导出）
 * 每个页面绑定真实数据与真实动作；空状态带主操作；每阶段一个主操作（P8-3）。
 * ==========================================================================*/
import { useState } from "react";
import { DirectorProject } from "../director";
import { assetUrl } from "../director";
import { EmptyState } from "./EmptyState";
import { ShotCard } from "./ShotCard";
import { GenerationQueue } from "./GenerationQueue";
import { PreviewPlayer } from "./PreviewPlayer";
import { TimelinePanel } from "./TimelinePanel";
import { RenderJobPanel } from "./RenderJobPanel";
import { shotBadge, taskBadge, yuan, formatTime } from "./design";

export type Sel = {
  shotId?: string; take?: { shotId: string; takeId: string } | null;
  clipId?: string | null; renderJobId?: string | null; sceneId?: string | null;
};

/* ---------------- 策划 ---------------- */

export function PlanPage({ proj, ask }: { proj: DirectorProject; ask: (t: string) => void }) {
  const shots = proj.shots || [];
  const takes = shots.reduce((n, s) => n + (s.takes?.length || 0), 0);
  const generated = shots.filter((s) => s.clipAssetId || s.takes?.some((t) => t.status === "ready_for_review" || t.status === "selected" || t.status === "locked")).length;
  const donePct = shots.length ? Math.round((generated / shots.length) * 100) : 0;
  const b = proj.bible || {};
  const next = nextStep(proj);

  if (!proj.purpose && !proj.coreMessage && shots.length === 0) {
    return (
      <div className="d-pane d-pane-center">
        <EmptyState
          icon="◈"
          title="开始你的第一个项目"
          desc="从一句创意开始，导演助理会驱动策划 → 剧本 → 分镜 → 生成 → 剪辑 → 审片 → 导出。任何生成都需要你确认费用，相同请求命中缓存不重复计费。"
          primary="让导演 Agent 制定方案"
          onPrimary={() => ask("请为这个项目制定创作简报与制作方案：目的、受众、时长、画幅、视觉基调。")}
          secondary={[
            { label: "粘贴剧本", onClick: () => ask("这是我导入的剧本，请帮我分析并结构化：") },
            { label: "手动填写", onClick: () => ask("我要手动填写创作简报，请指导我逐项填写。") },
          ]}
        />
      </div>
    );
  }

  return (
    <div className="d-pane">
      <div className="d-pane-head"><h3>创作简报</h3></div>
      <div className="d-kv-grid">
        <Card k="项目简介" v={proj.purpose || "—"} wide />
        <Card k="故事目标" v={String(proj.coreMessage || (proj.story?.logline as string) || "—")} />
        <Card k="时长 / 画幅" v={proj.targetDuration + "s · " + proj.aspectRatio} />
        <Card k="视觉基调" v={[b.visual?.texture, ...(b.visual?.color || [])].filter(Boolean).join(" · ") || "—"} />
      </div>
      <div className="d-kv-grid">
        <Card k="角色" v={(b.characters?.length || 0) + " 位"} />
        <Card k="场景" v={(b.locations?.length || 0) + " 个"} />
        <Card k="预算" v={proj.budgetLimit ? yuan(proj.budgetLimit) : "不限"} />
        <Card k="截止" v={proj.deadline || "—"} />
      </div>
      <div className="d-progress-row">
        <div className="d-progress"><div className="d-progress-bar" style={{ width: donePct + "%" }} /></div>
        <span className="d-progress-num">完成度 {donePct}%（{generated}/{shots.length} 镜头已生成）</span>
      </div>
      <div className="d-next">
        <span className="d-next-label">下一步建议</span>
        <span>{next}</span>
      </div>
    </div>
  );
}

function Card({ k, v, wide }: { k: string; v: string; wide?: boolean }) {
  if (!v || v === "—") return null;
  return <div className={"d-kv-card" + (wide ? " wide" : "")}><span className="d-kv-card-k">{k}</span><span className="d-kv-card-v">{v}</span></div>;
}

function nextStep(proj: DirectorProject): string {
  if (!proj.purpose && !proj.coreMessage) return "让导演 Agent 制定创作简报";
  if ((proj.shots || []).length === 0) return "创建镜头表（可让 Agent 按剧本拆分镜头）";
  const ungenerated = (proj.shots || []).filter((s) => !s.clipAssetId && !s.takes?.length);
  if (ungenerated.length) return "生成第一个镜头（生成前会显示费用确认；相同请求命中缓存不重复计费）";
  const placed = (proj.timeline?.videoTracks || []).some((t) => t.clips.length);
  if (!placed) return "把已通过的 Take 放上时间线";
  return "剪辑 → 审片 → 导出成片（FFmpeg 本地完成）";
}

/* ---------------- 剧本 ---------------- */

export function ScriptPage({ proj, ask }: { proj: DirectorProject; ask: (t: string) => void }) {
  const s = proj.story || {};
  const scenes = proj.scenes?.length ? proj.scenes : Array.isArray(s.scenes) ? s.scenes as { name?: string; summary?: string }[] : [];
  return (
    <div className="d-pane">
      <div className="d-pane-head"><h3>剧本</h3><button className="btn btn-secondary btn-sm" onClick={() => ask("请检查剧本：节奏、场景与连续性，并给出修改建议。")}>让 Agent 检查剧本</button></div>
      <div className="d-kv-grid">
        <Card k="Logline" v={String(s.logline || "")} wide />
        <Card k="主题" v={String(s.theme || "")} />
        <Card k="情绪弧线" v={String(s.emotionalArc || "")} />
      </div>
      <h4>场景（{scenes.length}）</h4>
      {scenes.length === 0 && <div className="d-inline-empty">暂无场景。可让 Agent 生成，或粘贴剧本后自动分析。</div>}
      {(scenes as { name?: string; summary?: string }[]).map((sc, i) => (
        <div key={i} className="d-script-scene"><b>{sc.name || "场景 " + (i + 1)}</b><div>{sc.summary || ""}</div></div>
      ))}
      {proj.importedScript && <details className="d-details"><summary>已导入剧本原文</summary><pre className="d-pre">{proj.importedScript.text.slice(0, 4000)}</pre></details>}
    </div>
  );
}

/* ---------------- 分镜 ---------------- */

export function ShotsPage({ proj, url, pid, sel, onSelectShot, onSelectTake, ask, onSetView, action }: {
  proj: DirectorProject; url: string; pid: string;
  sel: Sel; onSelectShot: (id: string) => void; onSelectTake: (shotId: string, takeId: string) => void;
  ask: (t: string) => void; onSetView: (v: "grid" | "list") => void; action: (t: string, a?: Record<string, unknown>) => Promise<unknown>;
}) {
  const [view, setView] = useState<"grid" | "list">("grid");
  const shots = proj.shots || [];
  return (
    <div className="d-pane">
      <div className="d-pane-head">
        <h3>分镜（{shots.length}）</h3>
        <div className="d-view-toggle">
          <button className={"btn btn-sm " + (view === "grid" ? "btn-primary" : "btn-secondary")} onClick={() => { setView("grid"); onSetView("grid"); }}>卡片</button>
          <button className={"btn btn-sm " + (view === "list" ? "btn-primary" : "btn-secondary")} onClick={() => { setView("list"); onSetView("list"); }}>列表</button>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={() => ask("请根据剧本创建结构化镜头表（每镜：叙事目的/起止状态/景别/运镜）。")}>让 AI 拆分镜头</button>
      </div>
      {shots.length === 0 && (
        <EmptyState
          icon="▦"
          title="还没有镜头"
          desc="让导演助理按剧本拆分镜头，或先用产品模板建 4 镜头（特写/桌面/手持/促销结尾，对应 07 保温杯单），或从已有视频反推镜头表（先出画面再补设定）。镜头生成前始终有费用确认。"
          primary="让 AI 拆分镜头"
          onPrimary={() => ask("请根据剧本创建结构化镜头表（每镜：叙事目的/起止状态/景别/运镜）。")}
          secondary={[
            { label: "用产品模板（4 镜头）", onClick: () => void action("create_shot_list_from_template", { template: "product_4shot", product: proj.title }) },
            { label: "从已有视频开始", onClick: () => ask("我要从已有视频开始制作（先出画面再补设定）：请先告诉我视频文件的本地绝对路径，然后用 import_user_video 导入、sample_frames 抽帧、reverse_storyboard 反推镜头草稿。草稿给我确认后才会用 create_shot_list 写入镜头表，全程不产生付费调用。") },
          ]}
        />
      )}
      {shots.length > 0 && view === "grid" && (
        <div className="d-shot-grid">
          {shots.map((s) => (
            <ShotCard
              key={s.shotId}
              shot={s}
              frameUrl={frameUrlOf(proj, url, pid, s)}
              selected={sel.shotId === s.shotId}
              onSelect={() => onSelectShot(s.shotId)}
            />
          ))}
        </div>
      )}
      {shots.length > 0 && view === "list" && (
        <table className="d-table">
          <thead><tr><th>镜头</th><th>状态</th><th>叙事目的</th><th>时长</th><th>景别</th><th>运镜</th><th>主体</th><th>Take</th></tr></thead>
          <tbody>
            {shots.map((s) => {
              const b = shotBadge(s.status);
              return (
                <tr key={s.shotId} className={sel.shotId === s.shotId ? "sel" : ""} onClick={() => onSelectShot(s.shotId)}>
                  <td className="mono">{s.shotId}</td>
                  <td><span className={"d-badge " + b.cls}>{b.label}</span></td>
                  <td>{s.narrativePurpose}</td>
                  <td>{s.duration}s</td>
                  <td>{s.shotSize}</td>
                  <td>{s.cameraMovement}</td>
                  <td>{s.subject}</td>
                  <td>{s.takes?.length || 0}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {shots.length > 0 && <div className="d-pane-foot">连续性检查：选中镜头后在右侧检查器查看 Take；「选择 Take」不影响其它镜头。</div>}

      {/* 反向工作流（O2-KR2）：已导入的用户视频 → 抽帧 → 反推镜头草稿 */}
      {(proj.assets || []).filter((a) => a.kind === "video_user").map((uv) => {
        const frames = uv.manifest?.frames || [];
        return (
          <div key={uv.assetId} className="d-pane d-reverse">
            <div className="d-pane-head">
              <h4>从已有视频开始：{uv.title || uv.assetId}</h4>
              <button className="btn btn-secondary btn-sm" onClick={() => ask("请对已导入的用户视频（assetId=" + uv.assetId + "）执行 reverse_storyboard 反推镜头草稿：按时间分段，每段给出起止/景别/运镜/主体/叙事目的，展示草稿等我确认，确认后再用 create_shot_list 写入镜头表。")}>让 Agent 反推镜头表</button>
            </div>
            <div className="d-kv-grid">
              <Card k="时长" v={uv.duration != null ? uv.duration + "s" : "—"} />
              <Card k="分辨率" v={uv.width && uv.height ? uv.width + "×" + uv.height : "—"} />
              <Card k="帧率" v={uv.probe?.fps ? uv.probe.fps + " fps" : "—"} />
            </div>
            {frames.length === 0 ? (
              <div className="d-inline-empty">
                尚未抽帧。让 Agent 执行 sample_frames 后这里会显示帧网格，或
                <button className="btn btn-secondary btn-sm" onClick={() => void action("sample_frames", { assetId: uv.assetId })}>立即抽帧</button>
              </div>
            ) : (
              <div className="d-frame-grid">
                {frames.map((f, i) => (
                  <div key={i} className="d-frame-cell">
                    <img src={assetUrl(url, pid, (uv.frameDir || "") + "/" + f.file)} alt={"帧 " + i} loading="lazy" />
                    <span className="d-frame-at">{f.atSec != null ? f.atSec + "s" : ""}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="d-pane-foot">反推结果是草稿，必须你确认后才写入镜头表；导入/抽帧/反推全程本地免费，只有后续生成走付费通道（有确认面板）。</div>
          </div>
        );
      })}
    </div>
  );
}

/** 分镜缩略图：优先已批准/已选用 Take 的资产首帧（视频用 <video> 渲染首帧）；其次 manifest 提取帧；无则 null */
function frameUrlOf(proj: DirectorProject, url: string, pid: string, shot: { clipAssetId?: string; takes?: { assetId?: string; status: string }[] }) {
  const best = (shot.takes || []).find((t) => t.status === "ready_for_review" || t.status === "selected" || t.status === "locked");
  const assetId = best?.assetId || shot.clipAssetId;
  const asset = assetId ? proj.assets?.find((a) => a.assetId === assetId) : null;
  if (!asset) return null;
  if (asset.frameDir && asset.manifest?.frames?.[0]) return assetUrl(url, pid, asset.frameDir + "/" + asset.manifest.frames[0].file);
  // 真实视频资产（Seedance 下载 / FFmpeg 渲染）：直接返回视频 URL，卡片以首帧预览
  if (/\.(mp4|mov|webm)(\?|#|$)/i.test(asset.path || "")) return assetUrl(url, pid, asset.path);
  return null;
}

/* ---------------- 生成 ---------------- */

export function GenerationPage({ proj, onPoll, onGenerateBatch, busy }: {
  proj: DirectorProject; onPoll: () => void;
  onGenerateBatch: (shotIds: string[]) => void; busy: string | null;
}) {
  const shots = proj.shots || [];
  const ungenerated = shots.filter((s) => !s.clipAssetId && !s.takes?.some((t) => t.status === "ready_for_review" || t.status === "selected" || t.status === "locked"));
  const allDone = shots.length > 0 && ungenerated.length === 0;
  return (
    <div className="d-pane-stack">
      <div className="d-pane">
        <div className="d-pane-head">
          <h3>生成</h3>
          <button
            className="btn btn-primary"
            disabled={ungenerated.length === 0 || busy !== null}
            title={ungenerated.length ? "一次授权这批镜头，队列自动跑；确认面板里可限制本次最多新生成条数" : (allDone ? "所有镜头均已生成" : "先创建镜头表")}
            onClick={() => onGenerateBatch(ungenerated.map((s) => s.shotId))}
          >
            {busy ? "处理中…" : (ungenerated.length ? "批量生成剩余镜头（" + ungenerated.length + "）" : (allDone ? "全部已生成" : "暂无待生成镜头"))}
          </button>
        </div>
        <div className="d-pane-foot">主操作会一次授权全部剩余镜头：确认面板显示新生成/缓存命中数量，可设上限；队列自动执行，不再逐条打断。命中缓存不重复计费。</div>
      </div>
      <GenerationQueue proj={proj} onPoll={onPoll} />
      <div className="d-pane">
        <h4>费用提示</h4>
        <ul className="d-note-list">
          <li>Seedance 按次计费，单条费用以服务端实际扣费为准（本地无法预估）。</li>
          <li>相同请求（同模型/提示词/参考/参数）命中缓存，直接复用，不重复计费。</li>
          <li>修改字幕、转场、音乐、音量、时间线只触发本地 FFmpeg 重新导出。</li>
        </ul>
      </div>
    </div>
  );
}

/* ---------------- 剪辑 ---------------- */

export function EditPage({ proj, url, pid, sel, onSelectShot, onSelectClip, onSelectTake, action, busy }: {
  proj: DirectorProject; url: string; pid: string; sel: Sel;
  onSelectShot: (id: string) => void; onSelectClip: (id: string) => void; onSelectTake: (shotId: string, takeId: string) => void;
  action: (t: string, a?: Record<string, unknown>) => Promise<unknown>; busy: string | null;
}) {
  const selShot = sel.shotId ? proj.shots?.find((s) => s.shotId === sel.shotId) : null;
  const selectedTake = sel.take ? selShot?.takes?.find((t) => t.takeId === sel.take!.takeId) : null;
  const hasClips = (proj.timeline?.videoTracks || []).some((t) => t.clips.length);
  return (
    <div className="d-edit">
      <div className="d-edit-top">
        <PreviewPlayer proj={proj} url={url} pid={pid} assetId={selectedTake?.assetId || selShot?.clipAssetId} />
        <div className="d-edit-side">
          <h4>素材与 Take</h4>
          {(proj.shots || []).map((s) => (
            <div key={s.shotId} className={"d-edit-shot" + (sel.shotId === s.shotId ? " on" : "")} onClick={() => onSelectShot(s.shotId)}>
              <span className="mono">{s.shotId}</span>
              {(s.takes || []).map((t) => (
                <button key={t.takeId} className={"d-edit-take" + (sel.take?.takeId === t.takeId ? " on" : "")}
                  onClick={(e) => { e.stopPropagation(); onSelectTake(s.shotId, t.takeId); }}>
                  {taskBadge(t.status).label}
                </button>
              ))}
              {(s.takes || []).length === 0 && <span className="d-edit-noshot">无 Take</span>}
            </div>
          ))}
        </div>
      </div>
      <div className="d-edit-foot">
        <TimelinePanel proj={proj} onSelectClip={onSelectClip} />
        <div className="d-edit-footbar">
          <span>剪辑操作（裁切/转场/音量/淡入淡出）只标记「需重新导出」，不触发视频生成。</span>
          <button
            className="btn btn-primary btn-sm"
            disabled={!hasClips || busy !== null}
            title={hasClips ? "按时间线渲染本地预览（FFmpeg，不调用生成通道）" : "先把 Take 放上时间线"}
            onClick={() => { void action("render_preview"); }}
          >
            {busy === "render_preview" ? "渲染中…" : "渲染预览"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- 审片 ---------------- */

export function ReviewPage({ proj, url, pid, sel, onSelectShot, onSelectTake, ask, action, busy }: {
  proj: DirectorProject; url: string; pid: string; sel: Sel;
  onSelectShot: (id: string) => void; onSelectTake: (shotId: string, takeId: string) => void; ask: (t: string) => void;
  action: (t: string, a?: Record<string, unknown>) => Promise<unknown>; busy: string | null;
}) {
  const selShot = sel.shotId ? proj.shots?.find((s) => s.shotId === sel.shotId) : null;
  const selectedTake = sel.take ? selShot?.takes?.find((t) => t.takeId === sel.take!.takeId) : null;
  const cc = proj.continuityChecks;
  return (
    <div className="d-review">
      <div className="d-review-player">
        <div className="d-pane-head">
          <h3>审片</h3>
          <button className="btn btn-secondary btn-sm" onClick={() => ask("请逐镜审片：节奏/表演/画面/叙事连续性，指出问题并给出修改建议。")}>让 Agent 审片</button>
          <button className="btn btn-secondary btn-sm" disabled={busy !== null} title="用本地 FFmpeg 抽帧对比相邻镜头色彩（检查器 v0），不调用生成通道" onClick={() => void action("continuity_check")}>
            {busy === "continuity_check" ? "检查中…" : "跑连续性检查"}
          </button>
        </div>
        <PreviewPlayer proj={proj} url={url} pid={pid} assetId={selectedTake?.assetId || selShot?.clipAssetId} />
        {cc?.pairs && (
          <div className="d-pane d-cc">
            <div className="d-pane-head">
              <h4>连续性检查（相邻镜头：A 末帧 vs B 首帧）</h4>
              {cc.csvPath && <button className="btn btn-secondary btn-sm" onClick={() => window.open(url + "/export/" + encodeURIComponent(pid) + "/" + encodeURIComponent(cc.csvPath!), "_blank")}>下载差异 CSV</button>}
            </div>
            <table className="d-table">
              <thead><tr><th>镜头 A</th><th>镜头 B</th><th>亮度差</th><th>RGB 差</th><th>直方图差</th><th>结论</th></tr></thead>
              <tbody>
                {cc.pairs.map((x, i) => (
                  <tr key={i} className={x.verdict === "warn" ? "warn" : x.verdict === "error" ? "err" : ""}>
                    <td className="mono">{x.shotIdA}</td>
                    <td className="mono">{x.shotIdB}</td>
                    <td>{x.lumaDiff ?? "—"}</td>
                    <td>{x.rgbDiff ?? "—"}</td>
                    <td>{x.histDiff ?? "—"}</td>
                    <td><span className={"d-badge " + (x.verdict === "ok" ? "ok" : x.verdict === "warn" ? "warn" : "err")}>{x.verdict === "ok" ? "通过" : x.verdict === "warn" ? "颜色漂移" : "检查失败"}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="d-pane-foot">v0 只做颜色级对比（阈值是初始假设），用真实交付数据校准；不做人脸/语义识别。</div>
          </div>
        )}
      </div>
      <div className="d-review-list">
        <h4>审片清单</h4>
        {(proj.shots || []).map((s) => {
          const b = shotBadge(s.status);
          const qc = s.qc;
          return (
            <div key={s.shotId} className={"d-review-item" + (sel.shotId === s.shotId ? " on" : "")} onClick={() => onSelectShot(s.shotId)}>
              <span className="mono">{s.shotId}</span>
              <span className={"d-badge " + b.cls}>{b.label}</span>
              {qc && <span className={"d-badge " + (qc.verdict === "pass" ? "ok" : "warn")}>{qc.verdict}</span>}
              <span className="d-review-sub">{s.subject || ""}</span>
            </div>
          );
        })}
        {(proj.shots || []).length === 0 && <div className="d-inline-empty">先完成生成，再来审片。</div>}
      </div>
    </div>
  );
}

/* ---------------- 导出 ---------------- */

export function ExportPage({ proj, url, pid, onExport, busy, onSelectJob, ask, action }: {
  proj: DirectorProject; url: string; pid: string; onExport: () => void; busy: string | null; onSelectJob: (id: string) => void; ask: (t: string) => void; action: (t: string, a?: Record<string, unknown>) => Promise<unknown>;
}) {
  const hasClips = (proj.timeline?.videoTracks || []).some((t) => t.clips.length);
  const genDirtyCount = (proj.shots || []).filter((s) => s.dirty?.generation).length;
  const renderDirty = Boolean(proj.renderDirty?.flag);
  const blocked = !hasClips || genDirtyCount > 0;
  const [orderCsv, setOrderCsv] = useState<string | null>(null);
  return (
    <div className="d-pane-stack">
      <div className="d-pane">
        <div className="d-pane-head">
          <h3>导出成片</h3>
          <button
            className="btn btn-primary"
            disabled={blocked || busy !== null}
            title={!hasClips ? "时间线为空，先把 Take 放上时间线" : (genDirtyCount > 0 ? "有镜头需要重新生成，先回「生成」页处理" : "按时间线渲染成片（FFmpeg 本地完成，不调用生成通道）")}
            onClick={onExport}
          >
            {busy === "export_final" ? "导出中…" : "开始导出"}
          </button>
          <button className="btn btn-secondary btn-sm" disabled={busy !== null} title="导出订单记账 CSV（镜头/Take/任务/重试/成本），前 5 单必须逐单记账" onClick={async () => {
            const r = (await action("order_summary")) as { ok?: boolean; csv?: string };
            if (r?.ok && r.csv) setOrderCsv(r.csv);
          }}>
            {busy === "order_summary" ? "生成中…" : "导出订单记录"}
          </button>
        </div>
        {orderCsv && (
          <div className="d-pane-foot">
            订单记录已生成：<a href={url + "/export/" + encodeURIComponent(pid) + "/" + encodeURIComponent(orderCsv)} target="_blank" rel="noreferrer">下载 CSV（{orderCsv}）</a>
          </div>
        )}
        {!hasClips && <div className="d-inline-empty warn">时间线为空：请先到「剪辑」把已通过的 Take 放上时间线。</div>}
        {genDirtyCount > 0 && <div className="d-inline-empty warn">有 {genDirtyCount} 个镜头标记为「需重新生成」（提示词/参数已变更）：导出前请先重新生成，否则成片会缺失最新画面。</div>}
        {renderDirty && <div className="d-inline-empty warn">时间线有未导出的变更：重新导出仅由本地 FFmpeg 执行，不会重新生成视频、不产生新费用。</div>}
        <div className="d-pane-foot">导出 = 时间线 → FFmpeg 本地渲染。字幕/转场/音量等变更只触发重新导出；只有生成镜头本身才调用视频生成通道。</div>
      </div>
      <RenderJobPanel proj={proj} url={url} pid={pid} onExport={onExport} busy={busy} onSelectJob={onSelectJob} />
    </div>
  );
}
