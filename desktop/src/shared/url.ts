/**
 * Server URL validation and origin helpers. Pure: no Electron imports, so
 * the unit tests run under plain Node.
 */

export type UrlCheck =
  | { ok: true; origin: string }
  | { ok: false; reason: UrlRejection };

export type UrlRejection =
  | "empty"
  | "malformed"
  | "scheme"
  | "insecure"
  | "credentials";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The custom scheme the app's own local pages (connect, picker) are served on. */
export const LOCAL_SCHEME = "trio-app";
export const LOCAL_ORIGIN = `${LOCAL_SCHEME}://local`;

/**
 * Validate what the user typed as the server address and reduce it to an
 * origin. `https` is required; plain `http` only for localhost / 127.0.0.1 /
 * [::1]. A bare host ("trio.up.railway.app") is read as https. Any path,
 * query or fragment is dropped: the web client is served from the root.
 */
export function validateServerUrl(input: string): UrlCheck {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: false, reason: "empty" };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "scheme" };
  }
  if (url.hostname === "") return { ok: false, reason: "malformed" };
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "credentials" };
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    return { ok: false, reason: "insecure" };
  }
  return { ok: true, origin: url.origin };
}

/**
 * The origin of a frame/page URL, or null when it has none. Node's URL gives
 * "null" as the origin of non-special schemes, so the app's own scheme is
 * handled by hand.
 */
export function originOf(rawUrl: string | undefined | null): string | null {
  if (!rawUrl) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
  if (url.protocol === `${LOCAL_SCHEME}:`) {
    return `${LOCAL_SCHEME}://${url.host.toLowerCase()}`;
  }
  return null;
}

/** True when `rawUrl` is on exactly `expectedOrigin` (scheme, host and port). */
export function isSameOrigin(
  rawUrl: string | undefined | null,
  expectedOrigin: string | null,
): boolean {
  if (!expectedOrigin) return false;
  const origin = originOf(rawUrl);
  return origin !== null && origin === expectedOrigin;
}

/** Links the system browser may open: web pages and mail only. */
export function isExternalOpenable(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return ["https:", "http:", "mailto:"].includes(url.protocol);
  } catch {
    return false;
  }
}

/** Turkish message for a rejected address, shown on the connect page. */
export function rejectionMessage(reason: UrlRejection): string {
  switch (reason) {
    case "empty":
      return "Sunucu adresini yaz.";
    case "malformed":
      return "Bu geçerli bir adres değil.";
    case "scheme":
      return "Adres https:// ile başlamalı.";
    case "insecure":
      return "Güvenli olmayan http yalnızca localhost için kullanılabilir; https:// kullan.";
    case "credentials":
      return "Adreste kullanıcı adı veya parola olmamalı.";
  }
}
