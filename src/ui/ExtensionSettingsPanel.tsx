import React from "react";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  subscribeSettings,
  type ExtensionSettings,
} from "../settings/extensionSettings";

export function ExtensionSettingsPanel() {
  const [settings, setSettings] = React.useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void loadSettings().then((s) => {
      if (cancelled) return;
      setSettings(s);
      setLoaded(true);
    });
    const off = subscribeSettings((next) => {
      if (cancelled) return;
      setSettings(next);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  async function toggle<K extends keyof ExtensionSettings>(key: K, value: ExtensionSettings[K]) {
    setSaving(true);
    try {
      const merged = await saveSettings({ [key]: value } as Partial<ExtensionSettings>);
      setSettings(merged);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-[var(--radius)] border border-[rgb(var(--border))] bg-[rgb(var(--panel))] p-3">
      <div className="text-xs font-extrabold mb-1">Integração com Instagram</div>
      <div className="text-[11px] text-[rgb(var(--muted))] mb-3">
        Comportamento do painel CRM IGNIS injetado nas páginas do Instagram.
      </div>

      <ToggleRow
        label="Abrir painel automaticamente ao visitar perfil"
        description="Quando ativado, o painel CRM IGNIS abre sozinho ao entrar em uma página de perfil do Instagram. Em DMs o painel é sempre aberto manualmente pelo botão fixo."
        checked={settings.autoOpenOnProfile}
        disabled={!loaded || saving}
        onChange={(v) => void toggle("autoOpenOnProfile", v)}
      />
    </div>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label
      className={
        "flex items-start gap-3 py-2 cursor-pointer select-none " +
        (disabled ? "opacity-60 pointer-events-none" : "")
      }
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        disabled={disabled}
        className={
          "shrink-0 mt-0.5 w-9 h-5 rounded-full relative transition-colors " +
          (checked
            ? "bg-[rgb(var(--accent))]"
            : "bg-white/10 border border-[rgb(var(--border))]")
        }
      >
        <span
          className={
            "absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform " +
            (checked ? "translate-x-[18px]" : "translate-x-0.5")
          }
        />
      </button>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-bold">{label}</div>
        {description ? (
          <div className="text-[11px] text-[rgb(var(--muted))] mt-0.5 leading-snug">
            {description}
          </div>
        ) : null}
      </div>
    </label>
  );
}
