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
    <div className="flex items-center gap-2 py-1">
      <div className="flex-1">
        <div className="text-xs">{label}</div>
        {hint != null ? <div className="text-[11px] text-[rgb(var(--muted))]">{hint}</div> : null}
        {saveError != null ? <div className="text-[11px] text-red-500 font-mono">{saveError}</div> : null}
      </div>

      <div className="relative">
        <input
          inputMode="numeric"
          pattern="[0-9]*"
          disabled={disabled}
          className={cx(
            "text-xs w-20 px-2 py-2 rounded-[var(--radius)] bg-[rgb(var(--panel))] border font-mono outline-none transition-colors",
            saveError
              ? "border-red-600 focus:border-red-500"
              : isEditing
              ? "border-[rgb(var(--accent))]"
              : "border-[rgb(var(--border))] focus:border-[rgb(var(--accent))]",
            disabled ? "opacity-60" : "",
          )}
          value={localValue}
          onChange={handleChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
        />
        {isSaving && (
          <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[rgb(var(--muted))] text-[10px] font-mono pointer-events-none">
            •••
          </span>
        )}
      </div>

      <button
        type="button"
        disabled={disabled}
        className={cx(
          "text-[11px] px-2 py-2 rounded-[var(--radius)] border border-[rgb(var(--border))] hover:bg-white/5",
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
          "text-[11px] px-2 py-2 rounded-[var(--radius)] border border-[rgb(var(--border))] hover:bg-white/5",
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
