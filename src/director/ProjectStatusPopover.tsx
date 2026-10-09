/* ============================================================================
 * Harness Director — 项目状态 Popover（P8-6：拆成「制作设置」/「系统能力」两组）
 *  - 制作设置：模型 / 分辨率 / 画幅 / 帧率 / 预算 / 已用（项目制作参数）
 *  - 系统能力：FFmpeg / Provider / 项目版本（环境与系统状态，异常红字）
 *  - 模型未指定时显示「未指定模型」（不再写误导性的「（设置页配置）」）
 * ==========================================================================*/
import { useEffect, useRef, useState } from "react";
import { DirectorProject } from "../director";
import { yuan } from "./design";

export function ProjectStatusPopover({ proj, ffmpeg, providerChips, onSetModel, onSetPaidCap }: {
  proj: DirectorProject; ffmpeg: { available?: boolean | null }; providerChips: { label: string; cls: string }[];
  onSetModel?: (model: string) => Promise<void>;
  onSetPaidCap?: (cap: number) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [editModel, setEditModel] = useState(false);
  const [modelDraft, setModelDraft] = useState("");
  const [savingModel, setSavingModel] = useState(false);
  const [editPaidCap, setEditPaidCap] = useState(false);
  const [paidCapDraft, setPaidCapDraft] = useState("");
  const [savingPaidCap, setSavingPaidCap] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
  }, [open]);

  const prod = proj.production || {};
  const budget = prod.actualCost || 0;
  const limit = proj.budgetLimit || 0;
  const paidCap = Number(prod.paidGenerationCap) || 0;
  const paidUsed = Number(prod.paidSubmissions) || 0;
  const model = Array.isArray(prod.modelVersions) && prod.modelVersions.length
    ? String(prod.modelVersions[0])
    : proj.production?.modelVersions?.[0]
      ? String(proj.production.modelVersions[0])
      : null;

  const save = async () => {
    setSavingModel(true);
    try { await onSetModel?.(modelDraft.trim()); setEditModel(false); }
    finally { setSavingModel(false); }
  };

  const savePaidCap = async () => {
    const n = Math.floor(Number(paidCapDraft));
    if (!Number.isFinite(n) || n < 0) return;
    setSavingPaidCap(true);
    try { await onSetPaidCap?.(n); setEditPaidCap(false); }
    finally { setSavingPaidCap(false); }
  };

  return (
    <div className="d-status-wrap" ref={ref}>
      <button className="d-status-btn" onClick={() => setOpen((v) => !v)} aria-haspopup="dialog" aria-expanded={open}>
        <span className="d-status-glyph">◍</span>
        <span>项目状态</span>
      </button>
      {open && (
        <div className="d-status-pop" role="dialog" aria-label="项目状态">
          <div className="d-status-title">项目状态</div>

          <div className="d-status-group-label">制作设置</div>
          <div className="d-status-grid">
            {editModel ? (
              <div className="d-stat d-stat-edit">
                <span className="d-stat-k">模型</span>
                <span className="d-stat-v d-model-edit">
                  <input
                    value={modelDraft}
                    placeholder="如 doubao-seedance-1-0-pro-250528"
                    onChange={(e) => setModelDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") setEditModel(false); }}
                    aria-label="模型 ID"
                  />
                  <button className="btn btn-sm btn-primary" disabled={savingModel || !modelDraft.trim()} onClick={() => void save()}>保存</button>
                </span>
              </div>
            ) : (
              <div className="d-stat d-stat-click" role="button" tabIndex={0} onClick={() => { setModelDraft(model || ""); setEditModel(true); }} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { setModelDraft(model || ""); setEditModel(true); } }} title={model ? "点击修改模型 ID" : "点击设置模型 ID"}>
                <span className="d-stat-k">模型</span>
                <span className={"d-stat-v" + (model ? " mono" : " warn")}>{model || "未指定模型"}</span>
              </div>
            )}
            <Stat k="分辨率" v={proj.resolution || "—"} mono />
            <Stat k="画幅" v={proj.aspectRatio || "—"} />
            <Stat k="帧率" v={(proj.fps || 24) + " fps"} />
            <Stat k="预算（仅记录）" v={limit ? yuan(limit) : "不限"} title="平台不回传扣费数据，金额上限无法执行，仅作记录" />
            <Stat k="已用" v={yuan(budget)} warn={limit > 0 && budget >= limit} />
            {editPaidCap ? (
              <div className="d-stat d-stat-edit">
                <span className="d-stat-k">付费生成上限</span>
                <span className="d-stat-v d-model-edit">
                  <input type="number" min={0} value={paidCapDraft} placeholder="0 = 不限"
                    onChange={(e) => setPaidCapDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void savePaidCap(); if (e.key === "Escape") setEditPaidCap(false); }}
                    aria-label="付费生成条数上限" />
                  <button className="btn btn-sm btn-primary" disabled={savingPaidCap} onClick={() => void savePaidCap()}>保存</button>
                </span>
              </div>
            ) : (
              <div className="d-stat d-stat-click" role="button" tabIndex={0} onClick={() => { setPaidCapDraft(String(paidCap || 0)); setEditPaidCap(true); }} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { setPaidCapDraft(String(paidCap || 0)); setEditPaidCap(true); } }} title="点击修改付费生成条数上限（真实执行）">
                <span className="d-stat-k">付费生成</span>
                <span className={"d-stat-v" + (paidCap > 0 && paidUsed >= paidCap ? " warn" : "")}>
                  {paidUsed + " / " + (paidCap > 0 ? paidCap : "不限") + " 条"}
                </span>
              </div>
            )}
          </div>
          {!model && <div className="d-status-model-hint">未指定模型时，生成会被如实拒绝（"未收录模型能力"）。点模型项即可设置。</div>}
          <div className="d-status-model-hint">付费生成上限真实执行（本地占位免费不占额度）；金额预算因平台不回传扣费数据，仅作记录。</div>

          <div className="d-status-group-label">系统能力</div>
          <div className="d-status-grid">
            <Stat k="FFmpeg" v={ffmpeg.available ? "就绪" : (ffmpeg.available === null ? "检测中" : "未安装")} cls={ffmpeg.available ? "ok" : "warn"} />
            <Stat k="项目版本" v={"v" + (proj.version || 1)} />
          </div>

          {providerChips.length > 0 && (
            <>
              <div className="d-status-sub">生成通道</div>
              <div className="d-status-chips">
                {providerChips.map((c, i) => <span key={i} className={"d-chip " + c.cls}>{c.label}</span>)}
              </div>
            </>
          )}
          {providerChips.length === 0 && (
            <>
              <div className="d-status-sub">生成通道</div>
              <div className="d-status-chips"><span className="d-chip warn">无可用 Provider</span></div>
            </>
          )}
          <div className="d-status-foot">
            渲染脏 {proj.renderDirty?.flag ? "是" : "否"} · 生成脏 {proj.shots?.filter((s) => s.dirty?.generation).length || 0} 个镜头
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ k, v, mono, warn, cls, title }: { k: string; v: string; mono?: boolean; warn?: boolean; cls?: string; title?: string }) {
  return (
    <div className="d-stat" title={title}>
      <span className="d-stat-k">{k}</span>
      <span className={"d-stat-v" + (mono ? " mono" : "") + (warn ? " warn" : "") + (cls ? " " + cls : "")}>{v}</span>
    </div>
  );
}
