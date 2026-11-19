/**
 * CONTRACT-V8-MUSIC §5: "Şu an çalıyor" — what the desktop app reports about
 * the media playing on the computer. Everything that reaches the page passes
 * `sanitiseNowPlaying`: plain strings only, control/bidi characters removed,
 * whitespace collapsed, lengths capped.
 */

export interface NowPlaying {
  title: string;
  artist?: string;
  app?: string;
}

export const TITLE_MAX = 120;
export const ARTIST_MAX = 120;
export const APP_MAX = 40;

// C0/C1 controls, bidi embeddings/overrides/isolates, zero-width and BOM.
const STRIP = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

export function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.slice(0, 4 * max).replace(STRIP, " ").replace(/\s+/g, " ").trim();
  if (text.length === 0) return null;
  // Cut on code points so a surrogate pair is never split.
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join("").trimEnd() : text;
}

/**
 * The app a media session belongs to, from its AppUserModelId
 * ("Spotify.exe", "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify", "Chrome",
 * "MSEdge", "308046B0AF4A39CB" for Firefox …). Known ones get a friendly name;
 * anything else a cleaned short form, never a path.
 */
export function appLabel(id: unknown): string | null {
  if (typeof id !== "string") return null;
  const lower = id.toLowerCase();
  if (lower.includes("spotify")) return "Spotify";
  if (lower.includes("msedge") || lower === "microsoftedge") return "Edge";
  if (lower.includes("chrome")) return "Chrome";
  if (lower.includes("firefox") || lower === "308046b0af4a39cb") return "Firefox";
  if (lower.includes("opera")) return "Opera";
  if (lower.includes("brave")) return "Brave";
  if (lower.includes("zunemusic") || lower.includes("media player")) return "Medya Oynatıcı";
  if (lower.includes("vlc")) return "VLC";
  if (lower.includes("deezer")) return "Deezer";
  if (lower.includes("applemusic") || lower.includes("itunes")) return "Apple Music";
  if (lower.includes("youtube")) return "YouTube Music";
  // "Vendor.App_hash!Entry" -> "App"; "C:\\x\\foo.exe" -> "foo".
  let short = id.split("!")[0] ?? id;
  short = short.split(/[\\/]/).pop() ?? short;
  short = short.replace(/_[a-z0-9]{13}$/i, "").replace(/\.exe$/i, "");
  short = short.split(".").pop() ?? short;
  return cleanText(short, APP_MAX);
}

/** Spotify's idle window titles; anything else is "Artist - Song". */
const SPOTIFY_IDLE = /^spotify( (premium|free))?$/i;

/** Spotify's main window title "Artist - Song" → NowPlaying; null when idle. */
export function parseSpotifyTitle(title: unknown): NowPlaying | null {
  const text = cleanText(title, TITLE_MAX + ARTIST_MAX + 3);
  if (!text || SPOTIFY_IDLE.test(text)) return null;
  const cut = text.indexOf(" - ");
  if (cut <= 0) return sanitiseNowPlaying({ title: text, app: "Spotify" });
  return sanitiseNowPlaying({ artist: text.slice(0, cut), title: text.slice(cut + 3), app: "Spotify" });
}

/** Whatever a source produced → a clean NowPlaying, or null. */
export function sanitiseNowPlaying(raw: unknown): NowPlaying | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const title = cleanText(record.title, TITLE_MAX);
  if (!title) return null;
  const out: NowPlaying = { title };
  const artist = cleanText(record.artist, ARTIST_MAX);
  if (artist) out.artist = artist;
  const app = cleanText(record.app, APP_MAX);
  if (app) out.app = app;
  return out;
}

export function sameNowPlaying(a: NowPlaying | null, b: NowPlaying | null): boolean {
  if (a === null || b === null) return a === b;
  return a.title === b.title && a.artist === b.artist && a.app === b.app;
}

/**
 * One record from the Windows helper (main/nowPlaying.ts) → NowPlaying:
 * `{source: "session", title, artist, app: <AppUserModelId>}` from the system
 * media session, or `{source: "spotify-window", title: <window title>}`.
 * `null` (nothing playing) and anything malformed → null.
 */
export function fromSourceRecord(raw: unknown): NowPlaying | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (record.source === "spotify-window") return parseSpotifyTitle(record.title);
  if (record.source === "session") {
    return sanitiseNowPlaying({ title: record.title, artist: record.artist, app: appLabel(record.app) ?? undefined });
  }
  return null;
}
