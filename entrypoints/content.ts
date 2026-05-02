import { defineContentScript } from "#imports";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { DmLeadPanel } from "../src/components/DmLeadPanel";
import { isDMRoute } from "../src/instagram/parseInstagram";
import {
  fetchAvatarAsDataUrl,
  extractAvatarUrlFallback,
} from "../src/instagram/avatarScraper";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  subscribeSettings,
  type ExtensionSettings,
} from "../src/settings/extensionSettings";

// Cache local dos settings — atualizado via subscribeSettings()
let _settings: ExtensionSettings = { ...DEFAULT_SETTINGS };

// ─── Estado de rota e painel ────────────────────────────────────────────────

type RouteContext =
  | { kind: "profile"; username: string }
  | { kind: "dm" }
  | { kind: "other" };

function detectRoute(): RouteContext {
  if (isDMRoute(location.href)) return { kind: "dm" };
  const u = getUsernameFromUrl();
  if (u) return { kind: "profile", username: u };
  return { kind: "other" };
}

let _panelRoot: Root | null = null;
let _panelHost: HTMLDivElement | null = null;
let _panelOpen = false;

let _buttonRoot: Root | null = null;
let _buttonHost: HTMLDivElement | null = null;

// Tracking para evitar reabrir automaticamente o painel se o usuário fechou
// manualmente — só reseta quando troca de rota.
let _currentRouteKey = "";
let _userClosedThisRoute = false;

// ─── Painel flutuante ───────────────────────────────────────────────────────

function ensurePanelHost() {
  // Se o host já existe e ainda está no DOM, ok.
  if (_panelHost && _panelHost.isConnected) return;

  // Se o IG removeu o nó, descarta a referência velha e remonta.
  if (_panelHost) {
    try {
      _panelRoot?.unmount();
    } catch {
      /* noop */
    }
    _panelHost = null;
    _panelRoot = null;
  }

  _panelHost = document.createElement("div");
  _panelHost.id = "crm-ignis-dm-host";
  _panelHost.style.cssText =
    "position:fixed;bottom:0;right:0;z-index:2147483647;pointer-events:none;";

  const shadow = _panelHost.attachShadow({ mode: "open" });
  const container = document.createElement("div");
  container.style.pointerEvents = "auto";
  shadow.appendChild(container);

  document.documentElement.appendChild(_panelHost);
  _panelRoot = createRoot(container);
}

function renderPanel(open: boolean, ctx: RouteContext) {
  ensurePanelHost();

  if (!open || ctx.kind === "other") {
    _panelRoot!.render(null);
    return;
  }

  const username = ctx.kind === "profile" ? ctx.username : null;
  // ⚠️ key força React a desmontar/remontar quando troca de contexto/perfil,
  // evitando que estado interno do painel vaze entre páginas.
  const k = ctx.kind === "profile" ? `profile:${ctx.username}` : "dm";

  _panelRoot!.render(
    React.createElement(DmLeadPanel, {
      key: k,
      username,
      onClose: handleUserClosePanel,
    }),
  );
}

function handleUserClosePanel() {
  _userClosedThisRoute = true;
  setPanelOpen(false);
}

function setPanelOpen(next: boolean) {
  _panelOpen = next;
  renderPanel(_panelOpen, detectRoute());
  renderButton(); // atualiza estado visual do botão (aberto/fechado)
}

function togglePanel() {
  // Se o usuário abre manualmente via botão, considera "intenção explícita"
  // e zera o flag de "fechado nessa rota" para o caso de auto-open
  if (!_panelOpen) _userClosedThisRoute = false;
  setPanelOpen(!_panelOpen);
}

// ─── Botão fixo ─────────────────────────────────────────────────────────────

function ensureButtonHost() {
  if (_buttonHost && _buttonHost.isConnected) return;

  if (_buttonHost) {
    try {
      _buttonRoot?.unmount();
    } catch {
      /* noop */
    }
    _buttonHost = null;
    _buttonRoot = null;
  }

  _buttonHost = document.createElement("div");
  _buttonHost.id = "crm-ignis-btn-host";
  _buttonHost.style.cssText =
    "position:fixed;top:80px;right:20px;z-index:2147483646;pointer-events:none;";

  const shadow = _buttonHost.attachShadow({ mode: "open" });
  const container = document.createElement("div");
  container.style.pointerEvents = "auto";
  shadow.appendChild(container);

  document.documentElement.appendChild(_buttonHost);
  _buttonRoot = createRoot(container);
}

function FixedButton(props: { open: boolean; onClick: () => void }) {
  const styles: React.CSSProperties = {
    width: 44,
    height: 44,
    borderRadius: "999px",
    background: props.open ? "#ea7c30" : "#121216",
    color: props.open ? "#000" : "#ea7c30",
    border: `2px solid #ea7c30`,
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    fontWeight: 800,
    fontSize: 11,
    letterSpacing: "0.04em",
    cursor: "pointer",
    boxShadow: "0 6px 18px rgba(0,0,0,0.35)",
    display: "grid",
    placeItems: "center",
    transition: "transform 0.15s ease, background 0.15s ease",
    userSelect: "none",
  };
  return React.createElement(
    "button",
    {
      type: "button",
      onClick: props.onClick,
      title: props.open ? "Fechar painel CRM IGNIS" : "Abrir painel CRM IGNIS",
      "aria-label": "Toggle CRM IGNIS panel",
      style: styles,
      onMouseEnter: (e: React.MouseEvent<HTMLButtonElement>) => {
        (e.currentTarget as HTMLButtonElement).style.transform = "scale(1.06)";
      },
      onMouseLeave: (e: React.MouseEvent<HTMLButtonElement>) => {
        (e.currentTarget as HTMLButtonElement).style.transform = "scale(1)";
      },
    },
    "CRM",
  );
}

function renderButton() {
  const ctx = detectRoute();
  const visible = ctx.kind === "profile" || ctx.kind === "dm";

  if (!visible) {
    if (_buttonRoot) _buttonRoot.render(null);
    return;
  }

  ensureButtonHost();
  _buttonRoot!.render(
    React.createElement(FixedButton, {
      open: _panelOpen,
      onClick: togglePanel,
    }),
  );
}

// ─── Roteamento ─────────────────────────────────────────────────────────────

function checkRoute() {
  const newKey = location.pathname;
  const routeChanged = newKey !== _currentRouteKey;
  _currentRouteKey = newKey;

  if (routeChanged) _userClosedThisRoute = false;

  const ctx = detectRoute();

  // Se saiu de instagram-relevante, fecha tudo
  if (ctx.kind === "other") {
    _panelOpen = false;
    renderPanel(false, ctx);
    renderButton();
    return;
  }

  // Auto-open no perfil (só ao entrar na rota, só se setting ligado, só se usuário não fechou manualmente)
  if (
    routeChanged &&
    ctx.kind === "profile" &&
    _settings.autoOpenOnProfile &&
    !_userClosedThisRoute
  ) {
    _panelOpen = true;
  }

  renderPanel(_panelOpen, ctx);
  renderButton();
}

function patchHistory() {
  const orig_push = history.pushState.bind(history);
  const orig_replace = history.replaceState.bind(history);

  history.pushState = function (...args: Parameters<typeof history.pushState>) {
    orig_push(...args);
    setTimeout(checkRoute, 50);
  };

  history.replaceState = function (...args: Parameters<typeof history.replaceState>) {
    orig_replace(...args);
    setTimeout(checkRoute, 50);
  };

  window.addEventListener("popstate", () => setTimeout(checkRoute, 50));
}

/**
 * Content script v2:
 * - Detecta APENAS rotas de perfil (instagram.com/{username}/) via URL.
 * - Em qualquer rota /direct/* ou perfil, mostra um botão fixo (top-right)
 *   que abre/fecha o painel flutuante CRM IGNIS.
 * - Em perfil, opcionalmente abre o painel automaticamente (setting).
 * - NÃO faz scraping de DOM da DM — toda identificação de lead na DM é manual.
 * - Continua respondendo CRM_IGNIS_GET_PROFILE_META (avatar) usado pelo SidePanel.
 */
export default defineContentScript({
  matches: ["*://instagram.com/*", "*://*.instagram.com/*"],
  async main() {
    console.log("[CRM IGNIS] content script v2 ativo ✅", location.href);

    try {
      _settings = await loadSettings();
    } catch (e) {
      console.warn("[CRM IGNIS] loadSettings falhou, usando defaults:", e);
      _settings = { ...DEFAULT_SETTINGS };
    }

    // Reage a mudanças de settings em outras telas (sidepanel/dashboard)
    subscribeSettings((next) => {
      _settings = next;
    });

    try {
      patchHistory();
    } catch (e) {
      console.warn("[CRM IGNIS] patchHistory falhou:", e);
    }

    try {
      checkRoute();
    } catch (e) {
      console.error("[CRM IGNIS] checkRoute inicial falhou:", e);
    }

    // Failsafe: o IG pode rerenderizar tudo após nosso primeiro append.
    // Re-aplica botão/painel periodicamente até confirmar presença no DOM.
    let attempts = 0;
    const ensureMounted = window.setInterval(() => {
      attempts++;
      const btnPresent = !!document.getElementById("crm-ignis-btn-host");
      if (!btnPresent) {
        try {
          checkRoute();
        } catch (e) {
          console.warn("[CRM IGNIS] retry render falhou:", e);
        }
      }
      if (attempts > 20) window.clearInterval(ensureMounted);
    }, 500);

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || typeof msg !== "object") return;

      const type = (msg as any).type;

      // SidePanel pede o "lead atual" — válido só em perfil.
      // DM não é mais suportado aqui (sem scraping); o usuário usa o painel flutuante.
      if (type === "CRM_IGNIS_GET_ACTIVE_USERNAME") {
        try {
          const ctx = detectRoute();
          if (ctx.kind === "profile") {
            sendResponse({ ok: true, username: ctx.username });
          } else if (ctx.kind === "dm") {
            sendResponse({
              ok: false,
              reason: "Na DM o lead é identificado manualmente pelo painel flutuante.",
            });
          } else {
            sendResponse({ ok: false, reason: "Abra um perfil do Instagram." });
          }
        } catch (e: any) {
          sendResponse({ ok: false, reason: e?.message || String(e) });
        }
        return true;
      }

      // Permite popup/sidepanel abrirem o painel programaticamente
      if (type === "CRM_IGNIS_TOGGLE_PANEL") {
        togglePanel();
        sendResponse({ ok: true, open: _panelOpen });
        return true;
      }

      if (type === "CRM_IGNIS_OPEN_PANEL") {
        _userClosedThisRoute = false;
        setPanelOpen(true);
        sendResponse({ ok: true, open: true });
        return true;
      }

      if (type === "CRM_IGNIS_GET_PROFILE_META") {
        (async () => {
          try {
            const username = getUsernameFromUrl();
            if (!username) {
              console.log("[CRM IGNIS][avatar] GET_PROFILE_META — não é perfil");
              sendResponse({ ok: false, reason: "Não é página de perfil." });
              return;
            }

            console.log("[CRM IGNIS][avatar] GET_PROFILE_META start:", username);
            const dataUrl = await fetchAvatarAsDataUrl(username);
            const finalAvatar = dataUrl || extractAvatarUrlFallback(username);

            console.log(
              "[CRM IGNIS][avatar] GET_PROFILE_META done:",
              username,
              "→",
              finalAvatar
                ? finalAvatar.startsWith("data:")
                  ? `data URL (${Math.round(finalAvatar.length / 1024)}KB)`
                  : `URL crua (${finalAvatar.slice(0, 40)}…)`
                : "<null>",
            );

            sendResponse({ ok: true, username, avatarUrl: finalAvatar });
          } catch (e: any) {
            console.error("[CRM IGNIS][avatar] GET_PROFILE_META erro:", e);
            sendResponse({ ok: false, reason: e?.message || String(e) });
          }
        })();

        return true; // resposta async
      }

      // Avatar para um username arbitrário — chamado pelo sidepanel/dashboard/popup
      // através de qualquer aba do IG aberta. Diferente do META acima, não exige
      // que a aba esteja no perfil daquele username — usa só o endpoint web_profile_info.
      if (type === "CRM_IGNIS_FETCH_AVATAR") {
        (async () => {
          try {
            const raw = String((msg as any)?.payload?.username || "")
              .trim()
              .replace(/^@+/, "");
            if (!raw || !/^[a-zA-Z0-9._]+$/.test(raw)) {
              console.warn("[CRM IGNIS][avatar] FETCH_AVATAR username inválido:", raw);
              sendResponse({ ok: false, reason: "username inválido" });
              return;
            }

            console.log("[CRM IGNIS][avatar] FETCH_AVATAR start:", raw);
            const dataUrl = await fetchAvatarAsDataUrl(raw);
            console.log(
              "[CRM IGNIS][avatar] FETCH_AVATAR done:",
              raw,
              "→",
              dataUrl
                ? dataUrl.startsWith("data:")
                  ? `data URL (${Math.round(dataUrl.length / 1024)}KB)`
                  : `URL crua (${dataUrl.slice(0, 40)}…)`
                : "<null>",
            );
            sendResponse({ ok: true, username: raw, avatarUrl: dataUrl });
          } catch (e: any) {
            console.error("[CRM IGNIS][avatar] FETCH_AVATAR erro:", e);
            sendResponse({ ok: false, reason: e?.message || String(e) });
          }
        })();

        return true;
      }
    });
  },
});

// ─── Helpers de URL ─────────────────────────────────────────────────────────

const RESERVED = new Set([
  "explore",
  "reels",
  "reel",
  "direct",
  "accounts",
  "p",
  "stories",
  "tv",
  "about",
  "developer",
  "shop",
  "channel",
  "ar",
]);

function getUsernameFromUrl(): string | null {
  const path = location.pathname.replace(/\/+$/, "");
  const parts = path.split("/").filter(Boolean);
  if (parts.length !== 1) return null;

  const username = parts[0]?.trim().replace(/^@/, "");
  if (!username) return null;
  if (!/^[a-zA-Z0-9._]+$/.test(username)) return null;
  if (RESERVED.has(username.toLowerCase())) return null;

  return username;
}
