import type { ReactNode } from "react";

export function MetricGrid({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gap: 12,
        gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
      }}
    >
      {children}
    </div>
  );
}

export function MetricCard({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: "neutral" | "success" | "warning" | "critical" | "info";
}) {
  return (
    <div
      style={{
        background: "#ffffff",
        border: "1px solid #e3e3e3",
        borderLeft: `4px solid ${toneColor(tone)}`,
        borderRadius: 8,
        minHeight: 96,
        padding: 14,
      }}
    >
      <s-text color="subdued">{label}</s-text>
      <div style={{ fontSize: 24, fontWeight: 650, lineHeight: 1.2, marginTop: 6 }}>
        {value}
      </div>
      {detail ? (
        <div style={{ marginTop: 6 }}>
          <s-text color="subdued">{detail}</s-text>
        </div>
      ) : null}
    </div>
  );
}

export function EmptyState({
  heading,
  message,
}: {
  heading: string;
  message: string;
}) {
  return (
    <div
      style={{
        background: "#ffffff",
        border: "1px dashed #c9cccf",
        borderRadius: 8,
        padding: 20,
        textAlign: "center",
      }}
    >
      <div style={{ fontWeight: 650, marginBottom: 6 }}>{heading}</div>
      <s-text color="subdued">{message}</s-text>
    </div>
  );
}

export function StatusBadge({
  children,
  tone,
}: {
  children: ReactNode;
  tone: "success" | "warning" | "critical" | "info" | "neutral";
}) {
  return <s-badge tone={tone}>{children}</s-badge>;
}

export function formatNumber(value: number | null | undefined) {
  return new Intl.NumberFormat("en-IN").format(Number(value ?? 0));
}

export function formatSigned(value: number) {
  return `${value > 0 ? "+" : ""}${formatNumber(value)}`;
}

export function formatCurrency(value: number | null | undefined) {
  return new Intl.NumberFormat("en-IN", {
    currency: "INR",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(Number(value ?? 0));
}

export function formatDate(value: string | Date) {
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    timeZone: "Asia/Kolkata",
    year: "numeric",
  }).format(new Date(value));
}

export function formatDateTime(value: string | Date) {
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    timeZone: "Asia/Kolkata",
    year: "numeric",
  }).format(new Date(value));
}

export function shortId(id: string) {
  return id.length > 12 ? `${id.slice(0, 8)}...${id.slice(-4)}` : id;
}

function toneColor(tone: "neutral" | "success" | "warning" | "critical" | "info") {
  switch (tone) {
    case "success":
      return "#008060";
    case "warning":
      return "#b98900";
    case "critical":
      return "#d72c0d";
    case "info":
      return "#2c6ecb";
    default:
      return "#8c9196";
  }
}
