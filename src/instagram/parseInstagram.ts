export function isDMRoute(href: string): boolean {
  try {
    const path = new URL(href).pathname;
    // Qualquer rota dentro do Direct: inbox, thread (/direct/t/{id}/), new, etc.
    return path === "/direct" || path.startsWith("/direct/");
  } catch {
    return false;
  }
}

export type ParseResult =
  | { ok: true; username: string }
  | { ok: false; reason: string };

export function parseInstagramUsername(url: string): ParseResult {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host !== "instagram.com") return { ok: false, reason: "Abra um perfil do Instagram." };

    const path = u.pathname.replace(/\/+$/, "");
    const parts = path.split("/").filter(Boolean);
    if (parts.length === 0) return { ok: false, reason: "Abra um perfil do Instagram." };

    const first = parts[0];

    const blocked = new Set([
      "p",
      "reel",
      "reels",
      "stories",
      "explore",
      "accounts",
      "direct",
      "about",
      "developer",
    ]);

    if (blocked.has(first)) return { ok: false, reason: "Essa página não é um perfil." };

    const username = first.trim();
    if (!/^[a-zA-Z0-9._]+$/.test(username)) return { ok: false, reason: "Username inválido." };

    return { ok: true, username };
  } catch {
    return { ok: false, reason: "URL inválida." };
  }
}
