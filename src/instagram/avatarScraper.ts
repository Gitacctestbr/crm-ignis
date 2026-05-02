// Scraper de avatar do Instagram.
//
// Roda DENTRO de uma aba do Instagram (content script ou painel injetado no
// Shadow DOM). Usa as cookies de sessão do usuário via `credentials: include`,
// então só funciona quando o caller já está logado em instagram.com.
//
// Estratégia de captura (do mais robusto pro fallback):
//   1) `web_profile_info` retorna URL assinada do CDN (cdninstagram.com / fbcdn.net)
//   2) Tenta baixar os bytes da imagem dentro do próprio content script:
//      a) com host_permissions cobrindo o CDN, browser libera CORS
//      b) blob → FileReader → base64 data URL
//   3) Persiste o data URL como `avatarUrl`. Vantagens:
//      - Imune à expiração da assinatura na URL original
//      - Imune a Origin/CORS no momento de renderizar (`<img>` carrega data URI
//        diretamente, sem pegar rede)
//      - Sobrevive backup/restore via JSON
//   4) Se download falhar, devolve a URL crua como último recurso — `<img>` pode
//      tentar carregar ainda que com chance menor de sucesso.
//
// Todas as etapas logam com prefixo `[CRM IGNIS][avatar]` para facilitar trace
// via DevTools quando o usuário pedir relatório.

const LOG = "[CRM IGNIS][avatar]";

export async function fetchAvatarViaWebProfileInfo(
  username: string,
): Promise<string | null> {
  const u = String(username || "").trim().replace(/^@+/, "");
  if (!u) return null;

  const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(u)}`;
  const csrf = getCookie("csrftoken");
  console.log(`${LOG} web_profile_info request:`, u, "csrf?", !!csrf);

  try {
    const res = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers: {
        Accept: "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "X-IG-App-ID": "936619743392459",
        ...(csrf ? { "X-CSRFToken": csrf } : {}),
      },
    });

    console.log(`${LOG} web_profile_info status:`, res.status, "for", u);
    if (!res.ok) {
      console.warn(`${LOG} web_profile_info NOT OK — usuário pode estar deslogado ou rate-limited`);
      return null;
    }

    const json = await res.json();
    const pic =
      json?.data?.user?.profile_pic_url_hd ||
      json?.data?.user?.profile_pic_url ||
      null;

    const cleaned = cleanUrl(pic);
    console.log(`${LOG} CDN URL recebida:`, cleaned ? cleaned.slice(0, 90) + "…" : "<null>");
    return cleaned;
  } catch (e) {
    console.error(`${LOG} web_profile_info fetch falhou:`, e);
    return null;
  }
}

/**
 * Pega a foto e devolve como data URL base64. Falha silenciosa devolve a URL
 * crua como fallback. Devolve null só se nem URL conseguir.
 */
export async function fetchAvatarAsDataUrl(
  username: string,
): Promise<string | null> {
  const cdnUrl = await fetchAvatarViaWebProfileInfo(username);
  if (!cdnUrl) {
    console.warn(`${LOG} sem URL do CDN — abortando data URL para`, username);
    return null;
  }

  // Tenta como blob via fetch direto. host_permissions no manifest libera CORS
  // pro CDN do IG; sem essas permissões esse fetch falha por SOP.
  try {
    const res = await fetch(cdnUrl, { credentials: "omit" });
    console.log(`${LOG} CDN fetch status:`, res.status, "for", username);
    if (!res.ok) {
      console.warn(`${LOG} CDN respondeu ${res.status} — devolvendo URL crua como fallback`);
      return cdnUrl;
    }
    const blob = await res.blob();
    console.log(`${LOG} blob size:`, blob.size, "bytes — type:", blob.type);
    if (blob.size === 0) {
      console.warn(`${LOG} blob vazio (provavelmente opaque por CORS) — fallback URL`);
      return cdnUrl;
    }
    const dataUrl = await blobToDataUrl(blob);
    console.log(
      `${LOG} data URL pronto, length:`,
      dataUrl.length,
      "prefix:",
      dataUrl.slice(0, 30),
    );
    return dataUrl;
  } catch (e) {
    console.warn(`${LOG} CDN fetch lançou — fallback URL crua. Erro:`, e);
    return cdnUrl;
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/**
 * Fallback: extrai avatar do DOM/HTML da página de perfil que está aberta.
 * Devolve apenas URL — não converte pra data URL porque é caso de borda.
 */
export function extractAvatarUrlFallback(username: string): string | null {
  const meta =
    getMeta("meta[property='og:image']") ||
    getMeta("meta[name='twitter:image']") ||
    getMeta("meta[property='og:image:secure_url']");

  const metaClean = cleanUrl(meta);
  if (metaClean) return metaClean;

  const dom = getAvatarFromDom(username);
  const domClean = cleanUrl(dom);
  if (domClean) return domClean;

  const html = document.documentElement?.innerHTML || "";
  const fromJson =
    matchInHtml(html, /"profile_pic_url_hd":"([^"]+)"/) ||
    matchInHtml(html, /"profile_pic_url":"([^"]+)"/);

  return cleanUrl(fromJson);
}

function getMeta(selector: string): string | null {
  const el = document.querySelector(selector) as HTMLMetaElement | null;
  const v = el?.content?.trim();
  return v ? v : null;
}

function getAvatarFromDom(username: string): string | null {
  const root = document.querySelector("main") || document.body;
  if (!root) return null;

  const imgs = Array.from(root.querySelectorAll("img"))
    .map((img) => ({
      src: (img.getAttribute("src") || "").trim(),
      alt: (img.getAttribute("alt") || "").toLowerCase(),
      width: Number(img.getAttribute("width") || "0"),
      height: Number(img.getAttribute("height") || "0"),
    }))
    .filter((x) => x.src.startsWith("http"));

  if (imgs.length === 0) return null;

  const u = username.toLowerCase();

  const bestAlt = imgs.find(
    (x) =>
      (x.alt.includes("perfil") || x.alt.includes("profile")) &&
      (x.alt.includes(u) || x.alt.includes(`@${u}`)),
  );
  if (bestAlt?.src) return bestAlt.src;

  const profileAlt = imgs.find(
    (x) =>
      x.alt.includes("perfil") ||
      x.alt.includes("profile picture") ||
      x.alt.includes("foto do perfil") ||
      x.alt.includes("profile photo"),
  );
  if (profileAlt?.src) return profileAlt.src;

  const biggest = imgs
    .slice()
    .sort((a, b) => (b.width * b.height || 0) - (a.width * a.height || 0))[0];

  return biggest?.src || null;
}

function matchInHtml(html: string, re: RegExp): string | null {
  const m = html.match(re);
  if (!m?.[1]) return null;

  const raw = m[1];
  const decoded = raw
    .replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&");

  return decoded;
}

function cleanUrl(url: any): string | null {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed.startsWith("http")) return null;

  const txt = document.createElement("textarea");
  txt.innerHTML = trimmed;
  const decoded = txt.value.trim();

  return decoded.startsWith("http") ? decoded : null;
}

function getCookie(name: string): string | null {
  const m = document.cookie.match(
    new RegExp(`(?:^|; )${name.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&")}=([^;]*)`),
  );
  return m ? decodeURIComponent(m[1]) : null;
}
