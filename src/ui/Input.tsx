import React from "react";

type Props = React.InputHTMLAttributes<HTMLInputElement>;

export function Input({ className = "", ...props }: Props) {
  return (
    <input
      className={
        "w-full text-xs px-4 py-2.5 rounded-xl bg-black/50 " +
        "border border-white/10 outline-none transition-all duration-200 " +
        "placeholder:text-[rgb(var(--muted))]/50 " +
        "focus:border-[#ea7c30] focus:ring-1 focus:ring-[rgba(234,124,48,0.18)] focus:shadow-[0_0_0_3px_rgba(234,124,48,0.12)] " +
        className
      }
      {...props}
    />
  );
}
