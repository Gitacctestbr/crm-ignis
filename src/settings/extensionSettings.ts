// Configurações persistentes da extensão.
//
// Vive em chrome.storage.local para que content scripts (Instagram),
// sidepanel e dashboard compartilhem o mesmo estado, e para que mudanças
// num lugar reflitam em todos via storage.onChanged.

export const SETTINGS_KEY = "crm-ignis-settings";

export type ExtensionSettings = {
  /** Abre o painel CRM IGNIS automaticamente ao entrar num perfil do Instagram. */
  autoOpenOnProfile: boolean;
  /** URL pública do CSV da planilha Google Sheets (Arquivo → Publicar na web → CSV). */
  syncCsvUrl: string;
};

export const DEFAULT_SETTINGS: ExtensionSettings = {
  autoOpenOnProfile: false,
  syncCsvUrl: "",
};

function merge(raw: unknown): ExtensionSettings {
  if (raw && typeof raw === "object") {
    return { ...DEFAULT_SETTINGS, ...(raw as Partial<ExtensionSettings>) };
  }
  return { ...DEFAULT_SETTINGS };
}

export async function loadSettings(): Promise<ExtensionSettings> {
  try {
    const got = await chrome.storage.local.get(SETTINGS_KEY);
    return merge(got?.[SETTINGS_KEY]);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(next: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  const current = await loadSettings();
  const merged = { ...current, ...next };
  await chrome.storage.local.set({ [SETTINGS_KEY]: merged });
  return merged;
}

/**
 * Subscreve a mudanças no storage. Retorna função de unsubscribe.
 * O handler recebe o objeto novo já mesclado com os defaults.
 *
 * Defensivo: se chrome.storage não estiver disponível (ex.: permissão ausente),
 * registra warning e retorna no-op — o caller continua funcionando com defaults
 * em vez de quebrar a inicialização inteira.
 */
export function subscribeSettings(handler: (s: ExtensionSettings) => void): () => void {
  try {
    const listener = (
      changes: { [k: string]: chrome.storage.StorageChange },
      area: chrome.storage.AreaName,
    ) => {
      if (area !== "local") return;
      if (!changes[SETTINGS_KEY]) return;
      handler(merge(changes[SETTINGS_KEY].newValue));
    };
    chrome.storage.onChanged.addListener(listener);
    return () => {
      try {
        chrome.storage.onChanged.removeListener(listener);
      } catch {
        /* noop */
      }
    };
  } catch (e) {
    console.warn("[CRM IGNIS] subscribeSettings indisponível:", e);
    return () => {};
  }
}
