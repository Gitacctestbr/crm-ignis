// Helpers para buscar avatares a partir de contextos que NÃO rodam dentro da
// aba do Instagram (popup, sidepanel, dashboard, background). Toda chamada
// roteia para uma aba do IG via `chrome.tabs.sendMessage`, porque o endpoint
// `web_profile_info` exige cookies de sessão e só responde do origin do IG.
//
// Estratégia:
//   - Primeiro tenta a aba ativa, caso ela seja Instagram.
//   - Caso contrário, varre todas as abas IG abertas até alguma responder.
//   - Se nenhuma aba IG estiver aberta, retorna null — caller deve abrir o IG
//     primeiro ou aceitar que o lead fique sem foto até o backfill manual.

type AvatarResp =
  | { ok: true; username: string; avatarUrl: string | null }
  | { ok: false; reason: string };

function sendToTab<T>(tabId: number, message: any): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (resp) => {
        // Lê lastError pra não vazar como warning no console quando a aba
        // não tem listener (ex.: aba ainda carregando, content script não montou).
        const _ = chrome.runtime.lastError;
        resolve((resp ?? null) as T | null);
      });
    } catch {
      resolve(null);
    }
  });
}

async function listInstagramTabs(): Promise<chrome.tabs.Tab[]> {
  try {
    const tabs = await chrome.tabs.query({
      url: ["*://instagram.com/*", "*://*.instagram.com/*"],
    });
    return tabs ?? [];
  } catch {
    return [];
  }
}

/**
 * Busca o avatar de um username arbitrário através de qualquer aba do IG
 * que estiver aberta. Retorna null se nenhuma aba responder com sucesso.
 */
export async function fetchAvatarForUsername(
  username: string,
): Promise<string | null> {
  const u = String(username || "").trim().replace(/^@+/, "");
  if (!u) return null;

  const tabs = await listInstagramTabs();
  console.log(`[CRM IGNIS][avatar][fetcher] @${u} — abas IG abertas:`, tabs.length);
  if (tabs.length === 0) {
    console.warn(
      `[CRM IGNIS][avatar][fetcher] @${u} — sem aba do IG aberta. ` +
        `Backfill precisa de pelo menos uma aba IG logada.`,
    );
    return null;
  }

  for (const t of tabs) {
    if (t.id == null) continue;
    console.log(`[CRM IGNIS][avatar][fetcher] @${u} — tentando tabId=${t.id} (${t.url?.slice(0, 60)})`);
    const r = await sendToTab<AvatarResp>(t.id, {
      type: "CRM_IGNIS_FETCH_AVATAR",
      payload: { username: u },
    });
    if (!r) {
      console.warn(`[CRM IGNIS][avatar][fetcher] @${u} — tab ${t.id} sem resposta (content script velho?)`);
      continue;
    }
    if (!(r as any).ok) {
      console.warn(`[CRM IGNIS][avatar][fetcher] @${u} — tab ${t.id} retornou ok:false:`, (r as any).reason);
      continue;
    }
    const url = (r as any).avatarUrl;
    if (typeof url !== "string") {
      console.warn(`[CRM IGNIS][avatar][fetcher] @${u} — tab ${t.id} retornou avatarUrl não-string`);
      continue;
    }
    if (url.startsWith("http") || url.startsWith("data:")) {
      console.log(
        `[CRM IGNIS][avatar][fetcher] @${u} — sucesso via tab ${t.id} (${url.startsWith("data:") ? "data URL" : "URL crua"})`,
      );
      return url;
    }
  }
  console.warn(`[CRM IGNIS][avatar][fetcher] @${u} — nenhuma aba retornou avatar válido`);
  return null;
}

/**
 * Tenta extrair o avatar do perfil que está carregado na aba ativa do IG.
 * Reaproveita a mensagem antiga `CRM_IGNIS_GET_PROFILE_META`.
 */
export async function fetchAvatarFromActiveTab(): Promise<{
  username: string;
  avatarUrl: string | null;
} | null> {
  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!active?.id) {
      console.warn("[CRM IGNIS][avatar][fetcher] sem aba ativa");
      return null;
    }

    type Resp =
      | { ok: true; username: string; avatarUrl: string | null }
      | { ok: false; reason: string };

    console.log("[CRM IGNIS][avatar][fetcher] GET_PROFILE_META → tab", active.id);
    const r = await sendToTab<Resp>(active.id, { type: "CRM_IGNIS_GET_PROFILE_META" });
    if (!r) {
      console.warn("[CRM IGNIS][avatar][fetcher] aba ativa não respondeu");
      return null;
    }
    if (!(r as any).ok) {
      console.warn("[CRM IGNIS][avatar][fetcher] aba ativa retornou ok:false:", (r as any).reason);
      return null;
    }

    const url = (r as any).avatarUrl;
    return {
      username: String((r as any).username || ""),
      avatarUrl:
        typeof url === "string" && (url.startsWith("http") || url.startsWith("data:"))
          ? url
          : null,
    };
  } catch (e) {
    console.error("[CRM IGNIS][avatar][fetcher] fetchAvatarFromActiveTab erro:", e);
    return null;
  }
}
