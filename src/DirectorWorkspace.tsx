/* ============================================================================
 * Harness Director — 导演工作台（三层工作区重构）
 * 第一层：全局任务侧栏（App.tsx Sidebar）
 * 第二层：本组件 = 项目头栏 + 工作流导航 + 阶段页面（主工作区 ≥760px）
 * 第三层：上下文检查器（右侧，可收起/调宽）
 * 底部：可展开 Agent 抽屉（对话 + 输入 + 执行模式）
 *
 * 设计评审修复（P10/P9/P8）：
 *  - 单一权威标题：项目名（project.title）→ 同步线程标题，消除「新任务/最后一班车」双标题；
 *  - 切换阶段清空检查器选中（消除跨阶段陈旧选中，如 REND-0002 残留在策划页）；
 *  - 阶段不再持续跟随 phase 强制跳 Tab（仅首次加载时对齐一次）；
 *  - 系统异常（FFmpeg 缺失 / 无可用 Provider）在头栏持续可见（非一次性 Toast）。
 * ==========================================================================*/
import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { Harness } from "./harness";
import {
  BatchPreviewItem, DirectorProject, GenerationConfirmation, fetchDirectorProject, directorAction,
} from "./director";
import { DirStage, PHASE_TO_STAGE, STAGE_LABELS } from "./director/design";
import { ProjectHeader } from "./director/ProjectHeader";
import { ContextInspector, InspectTarget } from "./director/ContextInspector";
import { AgentDrawer } from "./director/AgentDrawer";
import { Sel, PlanPage, ScriptPage, ShotsPage, GenerationPage, EditPage, ReviewPage, ExportPage } from "./director/phases";

/** 批量确认面板数据（generate_selected_shots 预览返回） */
interface BatchConfirm {
  shotIds: string[];
  items: BatchPreviewItem[];
  newCount: number;
  cacheCount: number;
  costDisclaimer?: string;
}

export function DirectorWorkspace({ h }: { h: Harness }) {
  const pid = h.cur.id;
  const url = h.directorCfg.url;
  const [proj, setProj] = useState<DirectorProject | null>(null);
  const [error, setError] = useState("");
  const [stage, setStageState] = useState<DirStage>("plan");
  const [sel, setSel] = useState<Sel>({});
  const [inspOpen, setInspOpen] = useState(true);
  const [inspW, setInspW] = useState(320);
  const [confirm, setConfirm] = useState<{ conf: GenerationConfirmation; shotId: string; forceRegenerate: boolean } | null>(null);
  const [batchConfirm, setBatchConfirm] = useState<BatchConfirm | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [providers, setProviders] = useState<{ name: string; displayName?: string; billingMode?: string; model?: string }[]>([]);
  const [ffmpeg, setFfmpeg] = useState<{ available?: boolean | null }>({});
  const dragRef = useRef(false);
  const firstLoadRef = useRef(true);
  const lastTitleRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const p = await fetchDirectorProject(url, pid);
    if (p) { setProj(p); setError(""); }
    else setError("导演服务不可达：" + url);
  }, [url, pid]);

  useEffect(() => { refresh(); const iv = setInterval(refresh, 2500); return () => clearInterval(iv); }, [refresh]);

  useEffect(() => {
    directorAction(url, "list_providers", {}).then((r) => { if (r?.ok && Array.isArray(r.providers)) setProviders(r.providers as never); }).catch(() => undefined);
    directorAction(url, "ffmpeg_status", {}).then((r) => setFfmpeg(r ?? {})).catch(() => setFfmpeg({ available: null }));
  }, [url]);

  /* 单一权威标题：项目名变化 → 同步线程标题（仅在项目标题自身变化时同步，
   * 用户单独重命名线程不会被覆盖；消除「新任务」与「最后一班车」并存）。 */
  useEffect(() => {
    if (!proj) return;
    if (lastTitleRef.current !== proj.title && h.cur.title !== proj.title) {
      lastTitleRef.current = proj.title;
      h.setTitle(proj.title);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proj?.title]);

  /* 阶段仅在首次加载时对齐项目 phase；此后尊重用户手动切换（不持续强制跳 Tab） */
  useEffect(() => {
    if (!proj) return;
    if (firstLoadRef.current) {
      firstLoadRef.current = false;
      setStageState(PHASE_TO_STAGE[proj.phase] || "plan");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proj?.phase]);

  const action = useCallback(async (tool: string, args: Record<string, unknown> = {}) => {
    setBusy(tool);
    const r = await directorAction(url, tool, { ...args, projectId: pid });
    setBusy(null);
    if (r && (r.ok === false || "error" in r)) h.push("warn", tool, (r.error as string) || (r.hint as string) || "");
    else h.push("success", tool, "");
    refresh();
    return r;
  }, [url, pid, h, refresh]);

  const ask = useCallback((text: string) => { void h.sendMessage(text); }, [h]);

  const setProjectModel = useCallback(async (model: string) => {
    await action("set_project_model", { model });
  }, [action]);

  const setPaidCap = useCallback(async (cap: number) => {
    await action("queue_control", { action: "set_paid_cap", value: cap });
  }, [action]);

  /* 单镜头生成：走确认面板（seedance），供检查器「生成镜头」使用 */
  const generateOne = useCallback(async (shotId: string) => {
    const r = (await action("generate_shot", { shotId, provider: "seedance" })) as { confirmation?: GenerationConfirmation };
    if (r?.confirmation) setConfirm({ conf: r.confirmation, shotId, forceRegenerate: false });
  }, [action]);

  /* 批量：先只读预览（不创建任务），返回每镜缓存/新生成/校验 → 弹批量确认面板 */
  const openBatch = useCallback(async (shotIds: string[]) => {
    const r = (await action("generate_selected_shots", { shotIds, provider: "seedance" })) as {
      ok?: boolean; shotIds?: string[]; items?: BatchPreviewItem[];
      newGenerationCount?: number; cacheHitCount?: number; costDisclaimer?: string;
    };
    if (r?.ok && Array.isArray(r.items)) {
      setBatchConfirm({
        shotIds: r.shotIds || shotIds,
        items: r.items, newCount: r.newGenerationCount || 0,
        cacheCount: r.cacheHitCount || 0, costDisclaimer: r.costDisclaimer,
      });
    }
  }, [action]);

  const confirmBatch = useCallback(async (cap: number | null) => {
    if (!batchConfirm) return;
    await action("generate_selected_shots", {
      shotIds: batchConfirm.shotIds, provider: "seedance", confirmed: true, batchCap: cap,
    });
    setBatchConfirm(null);
  }, [action, batchConfirm]);

  /* 切换阶段：清空检查器选中，避免跨阶段陈旧选中（P10-3） */
  const goStage = useCallback((s: DirStage) => { setSel({}); setStageState(s); }, []);

  /* O3-KR1：快捷动作根据项目状态推断真实下一步，不用罐头话 */
  const nextActions = useMemo(() => {
    if (!proj) return [];
    const shots = proj.shots || [];
    const ungenerated = shots.filter((s) => !s.clipAssetId && !s.takes?.some((t) => t.status === "ready_for_review" || t.status === "selected" || t.status === "locked"));
    const takesReady = shots.some((s) => s.takes?.some((t) => t.status === "ready_for_review" || t.status === "selected" || t.status === "locked"));
    const placed = (proj.timeline?.videoTracks || []).some((t) => t.clips.length);
    const out: { label: string; text: string }[] = [];
    if (!proj.purpose && !proj.coreMessage) {
      out.push({ label: "制定创作简报", text: "请先制定创作简报：目的、受众、时长、画幅、视觉基调，用 create_director_project 写入。" });
    } else if (shots.length === 0) {
      out.push({ label: "拆分镜头", text: "请根据剧本创建结构化镜头表（每镜：叙事目的/起止状态/景别/运镜）。" });
    }
    if (ungenerated.length > 0) {
      out.push({ label: "批量生成剩余镜头（" + ungenerated.length + "）", text: "批量生成剩余镜头：" + ungenerated.map((s) => s.shotId).join("、") + "。先调 generate_selected_shots 展示确认面板（新生成/缓存/上限），用户同意后再带 confirmed=true 提交。" });
    }
    if (takesReady && !placed) {
      out.push({ label: "把 Take 放上时间线", text: "已有通过的 Take 但时间线为空，请把可用的 Take 依序 place_clip_on_timeline 排好。" });
    }
    if (proj.renderDirty?.flag) {
      out.push({ label: "重新导出", text: "时间线有未导出的变更，请检查后触发 export_final（FFmpeg 本地执行，不重新生成视频）。" });
    }
    if (out.length < 2) {
      out.push({ label: "检查连续性", text: "请检查镜头连续性（角色/场景/动作衔接）并给出修改建议。" });
      out.push({ label: "审片", text: "请逐镜审片：节奏/表演/画面/叙事连续性，指出问题并给出修改建议。" });
    }
    return out.slice(0, 3);
  }, [proj]);

  if (!proj) {
    return (
      <div className="d-ws">
        <div className="d-hint">{error || "加载项目中…"}</div>
      </div>
    );
  }

  const providerChips = providers.map((p) => ({
    label: (p.displayName || p.name) + (p.billingMode ? " · " + (p.billingMode === "agent_plan" ? "Agent Plan" : "Platform") : ""),
    cls: p.name === "seedance" ? "accent" : "neutral",
  }));

  /* 系统异常：FFmpeg 缺失 或 无可用 Provider → 头栏持续可见 ⚠（P9-4） */
  const systemWarn = ffmpeg.available === false || providers.length === 0;

  const inspTarget: InspectTarget | null = sel.take
    ? { type: "take", shotId: sel.take.shotId, takeId: sel.take.takeId }
    : sel.shotId ? { type: "shot", shotId: sel.shotId }
    : sel.clipId ? { type: "clip", clipId: sel.clipId }
    : sel.renderJobId ? { type: "renderjob", renderJobId: sel.renderJobId }
    : sel.sceneId ? { type: "scene", sceneId: sel.sceneId }
    : null;

  /* O3-KR2：选中对象进入 Agent 上下文提示，Agent 可基于当前选中聚焦 */
  const selHint = sel.take
    ? " · 选中 " + sel.take.shotId + " / " + sel.take.takeId
    : sel.shotId ? " · 选中 " + sel.shotId
    : sel.clipId ? " · 选中片段 " + sel.clipId
    : sel.renderJobId ? " · 选中 " + sel.renderJobId
    : "";

  return (
    <div className="d-ws">
      {/* 项目头栏 + 工作流导航（单一权威：项目名 / Tab 即工作区 / 系统状态） */}
      <ProjectHeader
        proj={proj}
        stage={stage}
        onStage={goStage}
        ffmpeg={ffmpeg}
        providerChips={providerChips}
        systemWarn={systemWarn}
        onOpenEdit={() => goStage("edit")}
        onSetModel={setProjectModel}
        onSetPaidCap={setPaidCap}
      />

      {/* 主工作区 + 检查器 */}
      <div className="d-body">
        <main className="d-main" style={{ minWidth: 760 }}>
          {stage === "plan" && <PlanPage proj={proj} ask={ask} />}
          {stage === "script" && <ScriptPage proj={proj} ask={ask} />}
          {stage === "shots" && (
            <ShotsPage
              proj={proj} url={url} pid={pid} sel={sel}
              onSelectShot={(shotId) => setSel((s) => ({ ...s, shotId, take: null, clipId: null }))}
              onSelectTake={(shotId, takeId) => setSel((s) => ({ ...s, shotId, take: { shotId, takeId } }))}
              ask={ask} onSetView={() => undefined} action={action}
            />
          )}
          {stage === "generation" && (
            <GenerationPage
              proj={proj} onPoll={refresh}
              onGenerateBatch={openBatch}
              busy={busy}
            />
          )}
          {stage === "edit" && (
            <EditPage
              proj={proj} url={url} pid={pid} sel={sel}
              onSelectShot={(shotId) => setSel((s) => ({ ...s, shotId, take: null }))}
              onSelectClip={(clipId) => setSel((s) => ({ ...s, clipId, shotId: undefined }))}
              onSelectTake={(shotId, takeId) => setSel((s) => ({ ...s, shotId, take: { shotId, takeId } }))}
              action={action} busy={busy}
            />
          )}
          {stage === "review" && <ReviewPage proj={proj} url={url} pid={pid} sel={sel} ask={ask} action={action} busy={busy} onSelectShot={(shotId) => setSel((s) => ({ ...s, shotId }))} onSelectTake={(shotId, takeId) => setSel((s) => ({ ...s, shotId, take: { shotId, takeId } }))} />}
          {stage === "export" && <ExportPage proj={proj} url={url} pid={pid} onExport={() => { void action("export_final"); }} busy={busy} onSelectJob={(renderJobId) => setSel((s) => ({ ...s, renderJobId }))} ask={ask} action={action} />}
        </main>

        {inspOpen && inspTarget && (
          <aside className="d-inspector" style={{ width: inspW }} aria-label="检查器">
            <div className="d-insp-resize" data-resize
              onMouseDown={() => { dragRef.current = true; document.body.classList.add("resizing"); }}
              onMouseMove={(e) => { if (dragRef.current) setInspW(Math.min(440, Math.max(260, e.clientX - (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect().left + 4))); }}
              onMouseUp={() => { dragRef.current = false; document.body.classList.remove("resizing"); }}
            />
            <ContextInspector proj={proj} target={inspTarget} action={action} busy={busy} onGenerate={(sid) => void generateOne(sid)} />
          </aside>
        )}
      </div>

      {/* 批量确认面板：一次授权一批镜头，硬上限自动停，不造假金额 */}
      {batchConfirm && (
        <BatchConfirmModal
          data={batchConfirm}
          busy={busy !== null}
          onCancel={() => setBatchConfirm(null)}
          onConfirm={(cap) => void confirmBatch(cap)}
        />
      )}

      {/* 付费确认面板：任何生成提交前必须确认 */}
      {confirm && (
        <div className="d-modal-backdrop" onClick={() => setConfirm(null)}>
          <div className="d-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="确认生成">
            <h3>确认视频生成</h3>
            <div className="d-confirm-grid">
              <C k="Provider" v={confirm.conf.provider} />
              <C k="通道" v={confirm.conf.channelLabel + (confirm.conf.billingMode ? "（" + confirm.conf.billingMode + "）" : "")} />
              <C k="模型" v={confirm.conf.model} />
              <C k="镜头" v={confirm.shotId} />
              <C k="参数" v={confirm.conf.resolution + " · " + confirm.conf.ratio + " · " + confirm.conf.duration + "s" + (confirm.conf.generateAudio ? " · 带音频" : "")} />
              <C k="命中缓存" v={confirm.conf.cacheHit ? "是（不产生新调用）" : "否"} />
              <C k="预计新生成" v={confirm.conf.newGenerationCount + " 个"} />
              <C k="费用" v={(confirm.conf.cost?.range || confirm.conf.cost?.note || "—") + "（" + confirm.conf.costDisclaimer + "）"} />
            </div>
            <div className="d-modal-actions">
              <button className="btn btn-secondary" onClick={() => setConfirm(null)}>取消</button>
              <button className="btn btn-primary" disabled={busy !== null} onClick={async () => {
                await action("confirm_generation", {
                  shotId: confirm.shotId, provider: confirm.conf.provider, model: confirm.conf.model,
                  billing_mode: confirm.conf.billingMode, forceRegenerate: confirm.forceRegenerate, confirmed: true,
                });
                setConfirm(null);
              }}>确认提交{busy ? "…" : ""}</button>
            </div>
          </div>
        </div>
      )}

      {/* 底部 Agent 抽屉 */}
      <AgentDrawer
        h={h}
        contextHint={proj.title + " · " + (STAGE_LABELS[stage] || stage) + selHint}
        quickActions={nextActions}
      />
    </div>
  );
}


function C({ k, v }: { k: string; v?: string | null }) {
  if (!v) return null;
  return <div className="d-confirm-item"><span className="d-confirm-k">{k}</span><span>{v}</span></div>;
}

/* 批量确认面板：数量/缓存/上限输入（金额不可预估，只承诺条数与缓存） */
function BatchConfirmModal({ data, busy, onCancel, onConfirm }: {
  data: BatchConfirm; busy: boolean;
  onCancel: () => void; onConfirm: (cap: number | null) => void;
}) {
  const [capText, setCapText] = useState(String(data.newCount));
  const blocked = data.items.filter((i) => i.blocked);
  const nothingNew = data.newCount === 0;
  const cap = (() => {
    const n = Math.floor(Number(capText));
    if (!Number.isFinite(n) || n < 1) return null;
    return Math.min(n, data.newCount);
  })();
  return (
    <div className="d-modal-backdrop" onClick={onCancel}>
      <div className="d-modal d-modal-batch" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="确认批量生成">
        <h3>确认批量生成（{data.items.length} 个镜头）</h3>
        <div className="d-confirm-grid">
          <C k="新生成" v={data.newCount + " 条（费用以服务端实际扣费为准）"} />
          <C k="命中缓存" v={data.cacheCount + " 条（0 费用，直接复用）"} />
        </div>
        <div className="d-batch-rows">
          {data.items.map((it) => (
            <div key={it.shotId} className={"d-batch-row" + (it.blocked ? " err" : "")} title={it.blocked ? "校验未通过，本次不会提交" : ""}>
              <span className="mono">{it.shotId}</span>
              <span className={"d-batch-tag " + (it.cacheHit ? "ok" : "new")}>{it.cacheHit ? "缓存" : (it.inflight ? "进行中" : "新生成")}</span>
              <span className="d-batch-dur">{it.duration != null ? it.duration + "s" : "—"}</span>
              {it.blocked && <span className="d-batch-block">校验未通过</span>}
            </div>
          ))}
        </div>
        <div className="d-batch-cap">
          <label htmlFor="batch-cap">本次最多新生成条数</label>
          <input id="batch-cap" type="number" min={1} max={data.newCount} value={capText}
            onChange={(e) => setCapText(e.target.value)} />
          <span className="d-batch-cap-note">上限 {data.newCount}；达到上限后剩余镜头本次不提交，需要时再确认下一批。</span>
        </div>
        {blocked.length > 0 && <div className="d-inline-empty warn">{blocked.length} 个镜头校验未通过，本次不会提交（原因见明细）。</div>}
        {nothingNew && <div className="d-inline-empty">这批镜头全部命中缓存或已在生成中，无需提交新生成。</div>}
        <div className="d-inline-empty">Seedance 按次计费，单条费用以服务端实际扣费为准（本地无法预估）；相同请求命中缓存不重复计费。{data.costDisclaimer || ""}</div>
        <div className="d-modal-actions">
          <button className="btn btn-secondary" onClick={onCancel}>取消</button>
          <button className="btn btn-primary" disabled={busy || nothingNew || cap === null} onClick={() => onConfirm(cap)}>
            {nothingNew ? "无需提交" : ("确认提交这批" + (cap !== null && cap < data.newCount ? "（限 " + cap + " 条）" : ""))}{busy ? "…" : ""}
          </button>
        </div>
      </div>
    </div>
  );
}
