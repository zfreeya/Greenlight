/* ============================================================================
 * Harness Director — 底部可展开 Agent 抽屉（方案 A）
 * 默认仅紧凑输入栏；展开 360–420px；最大化/收起；Escape 关闭。
 * 宽度保证 ≥360px，杜绝中文逐字竖排。
 * ==========================================================================*/
import { useEffect, useRef, useState } from "react";
import { Harness } from "../harness";
import { Msg, EXEC_MODES } from "../state";
import Markdown from "../Markdown";

export function AgentDrawer({ h, contextHint, quickActions }: {
  h: Harness;
  contextHint: string;
  quickActions: { label: string; text: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [maxed, setMaxed] = useState(false);
  const [text, setText] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [open, h.cur.msgs.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) { setOpen(false); inputRef.current?.blur(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const send = () => {
    const t = text.trim();
    if (!t) return;
    setText("");
    void h.sendMessage(t);
  };

  const thinking = h.cur.thinking;

  return (
    <div className={"d-agent" + (open ? " open" : "") + (maxed ? " max" : "")} aria-label="导演助理">
      {/* 紧凑栏 */}
      <div className="d-agent-bar">
        <button className="d-agent-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <span className="d-agent-orb">{thinking ? <i className="pulse" /> : "✦"}</span>
          <span className="d-agent-caption">导演助理</span>
          <span className="d-agent-hint">{contextHint}</span>
        </button>
        <div className="d-agent-composer">
          <textarea
            ref={inputRef}
            value={text}
            rows={1}
            placeholder="告诉导演助理下一步做什么（Enter 发送，Shift+Enter 换行）"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
            }}
            aria-label="导演助理输入"
          />
          {thinking ? (
            <button className="btn btn-secondary btn-sm" onClick={() => h.stop()}>停止</button>
          ) : (
            <button className="btn btn-primary btn-sm" onClick={send} disabled={!text.trim()}>发送</button>
          )}
          <button className="btn btn-icon btn-sm" onClick={() => setOpen((v) => !v)} title={open ? "收起" : "展开"}>▾</button>
          {open && <button className="btn btn-icon btn-sm" onClick={() => setMaxed((v) => !v)} title={maxed ? "还原" : "最大化"}>{maxed ? "▁" : "▢"}</button>}
        </div>
      </div>

      {/* 展开对话 */}
      {open && (
        <div className="d-agent-body">
          <div className="d-agent-msgs" ref={listRef}>
            {h.cur.msgs.length === 0 && <div className="d-agent-empty">开始对话，导演助理会驱动整个工作流（策划 → 剧本 → 分镜 → 生成 → 剪辑 → 审片 → 导出）。</div>}
            {h.cur.msgs.map((m, idx) => <AgentMsg key={m.id} m={m} idx={idx} h={h} />)}
            {thinking && <div className="d-agent-thinking">导演助理正在工作…</div>}
          </div>
          {quickActions.length > 0 && (
            <div className="d-agent-quick">
              {quickActions.map((q) => (
                <button key={q.label} className="d-chip-btn" onClick={() => { setOpen(true); void h.sendMessage(q.text); }}>{q.label}</button>
              ))}
            </div>
          )}
          <div className="d-agent-meta">
            <select className="inp d-mode" value={h.mode} onChange={(e) => h.setMode(e.target.value as never)} title="执行模式">
              {EXEC_MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
            <span className="d-agent-meta-tip">费用确认会在提交前弹出；生成类操作始终需要你确认。</span>
          </div>
        </div>
      )}
    </div>
  );
}

function AgentMsg({ m, h, idx }: { m: Msg; h: Harness; idx: number }) {
  if (m.kind === "tool") {
    const done = m.toolStatus !== "running";
    return (
      <div className={"d-agent-msg tool " + (m.toolStatus || "")}>
        <span className="d-tool-dot">{done ? "✓" : "…"}</span>
        <span className="d-tool-name">{m.toolName}</span>
      </div>
    );
  }
  if (m.role === "user") {
    return <div className="d-agent-msg user">{m.chip || m.text}</div>;
  }
  if (m.kind === "plan" && m.items) {
    return (
      <div className="d-agent-msg agent">
        <div className="d-agent-head">导演助理</div>
        <ul className="d-plan">{m.items.map((it, i) => <li key={i}>{it}</li>)}</ul>
        {m.text && <div className="d-plan-note">{m.text}</div>}
      </div>
    );
  }
  if (m.kind === "ask" && m.opts) {
    return (
      <div className="d-agent-msg agent">
        <div className="d-agent-head">导演助理</div>
        <div className="d-agent-text"><Markdown text={m.text || ""} /></div>
        <div className="d-opts">
          {(m.opts || []).map((o, i) => (
            <button key={i} className="d-chip-btn" onClick={() => h.pickChip(idx, i)}>{o}</button>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="d-agent-msg agent">
      <div className="d-agent-head">导演助理</div>
      <div className="d-agent-text"><Markdown text={m.text || ""} /></div>
    </div>
  );
}
