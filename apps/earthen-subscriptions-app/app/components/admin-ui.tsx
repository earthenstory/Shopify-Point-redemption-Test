import type { ReactNode } from "react";

export function AdminStyles() {
  return <style>{`
    .es-admin-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:16px}
    .es-admin-card{display:block;padding:18px;border:1px solid #e1e3e5;border-radius:12px;background:#fff;color:inherit;text-decoration:none}
    .es-admin-card:hover{border-color:#8c9196;box-shadow:0 2px 8px rgba(0,0,0,.06)}
    .es-admin-card h3{margin:0 0 7px;font-size:15px}.es-admin-card p{margin:0;color:#616a75;line-height:1.45}
    .es-metric{padding:18px;border:1px solid #e1e3e5;border-radius:12px;background:#fff}
    .es-metric-label{color:#616a75;font-size:13px}.es-metric-value{font-size:25px;font-weight:650;margin-top:7px}
    .es-table-wrap{overflow:auto;border:1px solid #e1e3e5;border-radius:12px;background:#fff}
    .es-table{border-collapse:collapse;width:100%;min-width:760px}.es-table th,.es-table td{padding:12px 14px;text-align:left;border-bottom:1px solid #e1e3e5;vertical-align:top}
    .es-table th{font-size:12px;color:#616a75;background:#f6f6f7}.es-table tr:last-child td{border-bottom:0}
    .es-badge{display:inline-flex;padding:3px 8px;border-radius:999px;background:#e4e5e7;font-size:12px;text-transform:capitalize}
    .es-badge--success{background:#aee9d1}.es-badge--warning{background:#ffd79d}.es-badge--critical{background:#fed3d1}.es-badge--info{background:#a4e8f2}
    .es-tabs{display:flex;gap:8px;flex-wrap:wrap}.es-tabs a{padding:8px 12px;border-radius:8px;color:#303030;text-decoration:none;background:#f1f2f3}.es-tabs a[aria-current=page]{background:#303030;color:#fff}
    .es-progress{height:9px;background:#e4e5e7;border-radius:999px;overflow:hidden}.es-progress>span{display:block;height:100%;background:#008060}
    .es-check{display:flex;align-items:flex-start;gap:10px;padding:11px 0;border-bottom:1px solid #f1f2f3}.es-check:last-child{border-bottom:0}
    .es-check-dot{width:20px;height:20px;border-radius:50%;display:grid;place-items:center;background:#ffd79d;flex:0 0 auto}.es-check-dot[data-ready=true]{background:#aee9d1}
    .es-form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px}.es-actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
    .es-muted{color:#616a75}.es-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#f6f6f7;padding:2px 5px;border-radius:5px}
    .es-bar-row{display:grid;grid-template-columns:minmax(130px,1fr) 3fr auto;gap:10px;align-items:center;margin:10px 0}.es-bar{height:12px;border-radius:999px;background:#e4e5e7;overflow:hidden}.es-bar span{display:block;height:100%;background:#112557}
  `}</style>;
}

export function MetricCard({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }) {
  return <div className="es-metric">
    <div className="es-metric-label">{label}</div>
    <div className="es-metric-value">{value}</div>
    {detail ? <div className="es-muted">{detail}</div> : null}
  </div>;
}

export function ModuleCard({ href, title, description }: { href: string; title: string; description: string }) {
  return <a className="es-admin-card" href={href}><h3>{title}</h3><p>{description}</p></a>;
}

export function StatusBadge({ status }: { status: string }) {
  const tone = ["active", "completed", "order_created", "sent"].includes(status)
    ? "success"
    : ["failed", "cancelled", "manual_review"].includes(status)
      ? "critical"
      : ["paused", "pending_mandate", "payment_pending", "queued"].includes(status)
        ? "warning"
        : "info";
  return <span className={`es-badge es-badge--${tone}`}>{status.replaceAll("_", " ")}</span>;
}

export function formatMoney(paise: number | null | undefined) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format((paise ?? 0) / 100);
}

export function percent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}
