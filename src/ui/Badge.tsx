import React from "react";

type Variant = "default" | "high" | "medium" | "low";

export function Badge({
  variant = "default",
  children,
}: {
  variant?: Variant;
  children: React.ReactNode;
}) {
  const base = "text-[11px] px-2 py-[2px] rounded-full border inline-flex items-center gap-1";

  const styles: Record<Variant, string> = {
    default: "border-[rgb(var(--border))] text-[rgb(var(--muted))]",
    high: "border-transparent bg-[rgb(var(--accent))] text-black",
    medium: "border-[rgb(var(--border))] text-[rgb(var(--text))]",
    low: "border-[rgb(var(--border))] text-[rgb(var(--muted))]",
  };

  return <span className={`${base} ${styles[variant]}`}>{children}</span>;
}
