import React from "react";

export interface MetricInputProps {
  label: string;
  value: number;
  onChange: (next: number) => Promise<void> | void;
  onInc1: () => void;
  onInc5: () => void;
  disabled?: boolean;
  hint?: string;
}

function cx(...parts: Array<string | false | undefined | null>): string {
  return parts.filter(Boolean).join(" ");
}

function parseNonNegativeInt(s: string): number {
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

type PendingSave = {
  raw: string;
  fn: (next: number) => Promise<void> | void;
};

function MetricInputImpl({
  label,
  value,
  onChange,
  onInc1,
  onInc5,
  disabled,
  hint,
}: MetricInputProps) {
  const [localValue, setLocalValue] = React.useState<string>(String(value));
  const [isEditing, setIsEditing] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // pending save snapshot: pins the onChange ref captured at typing time so
  // that a later context switch (board/date change in parent) cannot redirect
  // the write to the wrong row ("atropelamento de contexto").
  const pendingRef = React.useRef<PendingSave | null>(null);

  React.useEffect(() => {
    if (!isEditing) {
      setLocalValue(String(value));
    }
  }, [value, isEditing]);

  React.useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      // Flush pending write on unmount so data typed right before navigating
      // away is not lost.
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending) {
        try {
          void pending.fn(parseNonNegativeInt(pending.raw));
        } catch {
          /* fire-and-forget */
        }
      }
    };
  }, []);

  async function flushPending(pending: PendingSave) {
    const committed = parseNonNegativeInt(pending.raw);
    setLocalValue(String(committed));
    setSaveError(null);
    setIsSaving(true);
    try {
      await pending.fn(committed);
    } catch {
      setSaveError("Falha ao salvar");
    } finally {
      setIsSaving(false);
    }
  }

  function scheduleDebounce(raw: string) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const pending: PendingSave = { raw, fn: onChange };
    pendingRef.current = pending;
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      pendingRef.current = null;
      void flushPending(pending);
    }, 800);
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value;
    if (raw === "" || /^\d+$/.test(raw)) {
      setLocalValue(raw);
      scheduleDebounce(raw);
    }
  }

  function handleFocus() {
    setIsEditing(true);
    setSaveError(null);
  }

  function handleBlur() {
    setIsEditing(false);
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const pending = pendingRef.current ?? { raw: localValue, fn: onChange };
    pendingRef.current = null;
    void flushPending(pending);
  }

  return (
    <div className="flex items-center gap-2 py-2">
      <div className="flex-1 min-w-0">
        <div className="text-[10px] uppercase tracking-wider font-semibold text-[rgb(var(--muted))]">
          {label}
        </div>
        {hint != null ? (
          <div className="text-[10px] text-[rgba(234,124,48,0.75)] font-mono mt-0.5">{hint}</div>
        ) : null}
        {saveError != null ? (
          <div className="text-[10px] text-red-400 font-mono mt-0.5">{saveError}</div>
        ) : null}
      </div>

      <div className="relative">
        <input
          inputMode="numeric"
          pattern="[0-9]*"
          disabled={disabled}
          className={cx(
            "text-sm w-16 px-2 py-1.5 rounded-xl bg-black/50 border font-mono font-bold text-center outline-none transition-all duration-150",
            saveError
              ? "border-red-600 focus:border-red-500"
              : isEditing
              ? "border-[#ea7c30] shadow-[0_0_0_3px_rgba(234,124,48,0.18)]"
              : "border-white/10 focus:border-[#ea7c30] focus:shadow-[0_0_0_3px_rgba(234,124,48,0.12)]",
            disabled ? "opacity-60" : "",
          )}
          value={localValue}
          onChange={handleChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
        />
        {isSaving && (
          <span className="absolute right-1 top-1/2 -translate-y-1/2 text-[rgba(234,124,48,0.8)] text-[9px] font-mono pointer-events-none">
            ●
          </span>
        )}
      </div>

      <button
        type="button"
        disabled={disabled}
        className={cx(
          "text-[10px] w-8 h-8 rounded-full border border-white/10 bg-white/5 font-bold transition-all duration-150",
          "hover:border-[rgba(234,124,48,0.55)] hover:bg-[rgba(234,124,48,0.10)] hover:text-[rgb(var(--accent))]",
          disabled ? "opacity-50" : "",
        )}
        onClick={onInc1}
        title="+1"
      >
        +1
      </button>

      <button
        type="button"
        disabled={disabled}
        className={cx(
          "text-[10px] w-8 h-8 rounded-full border border-white/10 bg-white/5 font-bold transition-all duration-150",
          "hover:border-[rgba(234,124,48,0.55)] hover:bg-[rgba(234,124,48,0.10)] hover:text-[rgb(var(--accent))]",
          disabled ? "opacity-50" : "",
        )}
        onClick={onInc5}
        title="+5"
      >
        +5
      </button>
    </div>
  );
}

export const MetricInput = React.memo(MetricInputImpl);
