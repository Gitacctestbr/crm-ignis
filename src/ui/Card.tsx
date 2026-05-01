import React from "react";

export function Card({
  title,
  subtitle,
  children,
}: {
  title?: string;
  subtitle?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-[var(--radius)] border border-[rgb(var(--border))] bg-[rgb(var(--panel))] shadow-[var(--shadow-sm)] p-3">
      {title && <div className="text-sm font-semibold">{title}</div>}
      {subtitle && <div className="text-xs text-[rgb(var(--muted))] mt-1">{subtitle}</div>}
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}
