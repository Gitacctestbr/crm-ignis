import React from "react";

type Variant = "primary" | "secondary" | "ghost";

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
};

export function Button({ variant = "secondary", className = "", ...props }: Props) {
  const base =
    "text-xs px-3 py-1 rounded-[var(--radius)] border transition select-none " +
    "hover:bg-white/5 active:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed";

  const styles: Record<Variant, string> = {
    primary: "border-transparent bg-[rgb(var(--accent))] text-black hover:opacity-95 active:opacity-90",
    secondary: "border-[rgb(var(--border))] bg-transparent text-[rgb(var(--text))]",
    ghost: "border-transparent bg-transparent text-[rgb(var(--text))] hover:bg-white/5",
  };

  return <button className={`${base} ${styles[variant]} ${className}`} {...props} />;
}
