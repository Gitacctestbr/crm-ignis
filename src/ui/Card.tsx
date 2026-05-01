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
    <div className="rounded-xl border border-white/10 bg-white/5 backdrop-blur-sm shadow-[var(--shadow-md)] p-4 transition-all duration-300 hover:border-[rgba(234,124,48,0.25)]">
      {title && (
        <div className="text-[10px] font-semibold uppercase tracking-widest text-[rgb(var(--muted))] mb-3">
          {title}
        </div>
      )}
      {subtitle && (
        <div className="text-xs text-[rgb(var(--muted))] -mt-2 mb-3">{subtitle}</div>
      )}
      {children && <div className={title || subtitle ? "mt-2" : ""}>{children}</div>}
    </div>
  );
}
