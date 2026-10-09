/* ============================================================================
 * Harness Director — 空状态（带明确第一步主操作，不依赖警告框）
 * ==========================================================================*/
export function EmptyState({ icon, title, desc, primary, secondary, onPrimary }: {
  icon?: string; title: string; desc: string;
  primary?: string; onPrimary?: () => void;
  secondary?: { label: string; onClick: () => void }[];
}) {
  return (
    <div className="d-empty">
      {icon && <div className="d-empty-icon">{icon}</div>}
      <div className="d-empty-title">{title}</div>
      <div className="d-empty-desc">{desc}</div>
      <div className="d-empty-actions">
        {primary && onPrimary && (
          <button className="btn btn-primary" onClick={onPrimary}>{primary}</button>
        )}
        {(secondary || []).map((s) => (
          <button key={s.label} className="btn btn-secondary" onClick={s.onClick}>{s.label}</button>
        ))}
      </div>
    </div>
  );
}
