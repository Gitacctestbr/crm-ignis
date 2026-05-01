import React from "react";

type Variant = "default" | "high" | "medium" | "low";

export function Badge({
  variant = "default",
  children,
}: {
  variant?: Variant;
  children: React.ReactNode;
}) {
  const base = "text-[10px] px-2 py-[2px] rounded-full border inline-flex items-center gap-1 font-medium";

  const styles: Record<Variant, string> = {
    default: "border-white/10 text-zinc-400 bg-white/5",
    high:
      "border-[rgba(234,124,48,0.45)] bg-[rgba(234,124,48,0.12)] text-[rgb(var(--accent))] font-bold",
    medium: "border-white/10 text-[rgb(var(--text))] bg-white/5",
    low: "border-white/[0.06] text-[rgb(var(--muted))]/70",
  };

  return <span className={`${base} ${styles[variant]}`}>{children}</span>;
}
