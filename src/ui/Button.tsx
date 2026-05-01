import React from "react";

type Variant = "primary" | "secondary" | "ghost";

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
};

export function Button({ variant = "secondary", className = "", ...props }: Props) {
  const base =
    "text-xs px-3 py-1.5 rounded-full border transition-all duration-200 select-none " +
    "disabled:opacity-40 disabled:cursor-not-allowed";

  const styles: Record<Variant, string> = {
    primary:
      "border-transparent bg-[rgb(var(--accent))] text-black font-bold neon-button " +
      "hover:shadow-[0_6px_22px_rgba(234,124,48,0.55)] hover:opacity-95 active:opacity-85",
    secondary:
      "border-white/10 bg-white/5 text-zinc-300 " +
      "hover:bg-white/10 hover:border-[rgba(234,124,48,0.5)] hover:text-[rgb(var(--text))] active:bg-white/[0.15]",
    ghost:
      "border-transparent bg-transparent text-[rgb(var(--muted))] " +
      "hover:text-[rgb(var(--text))] hover:bg-white/5",
  };

  return <button className={`${base} ${styles[variant]} ${className}`} {...props} />;
}
