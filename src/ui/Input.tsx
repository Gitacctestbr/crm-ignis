import React from "react";

type Props = React.InputHTMLAttributes<HTMLInputElement>;

export function Input({ className = "", ...props }: Props) {
  return (
    <input
      className={
        "w-full text-xs px-3 py-2 rounded-[var(--radius)] bg-transparent " +
        "border border-[rgb(var(--border))] outline-none " +
        "focus:border-[rgb(var(--accent))] " +
        className
      }
      {...props}
    />
  );
}
