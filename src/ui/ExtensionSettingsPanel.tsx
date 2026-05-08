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
  const [urlDraft, setUrlDraft] = React.useState("");
  const [urlSaved, setUrlSaved] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void loadSettings().then((s) => {
      if (cancelled) return;
      setSettings(s);
      setUrlDraft(s.syncCsvUrl ?? "");
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

  async function saveCsvUrl() {
    setSaving(true);
    try {
      const merged = await saveSettings({ syncCsvUrl: urlDraft.trim() });
      setSettings(merged);
      setUrlSaved(true);
      setTimeout(() => setUrlSaved(false), 2000);
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

      <div className="mt-3 pt-3 border-t border-[rgb(var(--border))]/50">
        <div className="text-xs font-extrabold mb-1">Sincronização com Google Sheets</div>
        <div className="text-[11px] text-[rgb(var(--muted))] mb-2">
          Cole a URL de publicação em CSV da planilha (Arquivo → Publicar na web → CSV).
        </div>
        <div className="flex gap-2">
          <input
            type="url"
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            placeholder="https://docs.google.com/spreadsheets/d/..."
            disabled={!loaded || saving}
            className="flex-1 min-w-0 text-xs px-3 py-2 rounded-[var(--radius)] bg-black/40 border border-[rgb(var(--border))] outline-none focus:border-[rgb(var(--accent))] focus:shadow-[0_0_0_2px_rgba(234,124,48,0.1)] transition-all placeholder:text-[rgb(var(--muted))]/40"
          />
          <button
            type="button"
            disabled={!loaded || saving}
            onClick={() => void saveCsvUrl()}
            className="text-xs px-3 py-2 rounded-[var(--radius)] border border-[rgb(var(--border))] hover:border-[rgba(234,124,48,0.4)] hover:bg-white/5 transition-all disabled:opacity-50 shrink-0"
          >
            {urlSaved ? "✓ Salvo" : "Salvar"}
          </button>
        </div>
      </div>
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
