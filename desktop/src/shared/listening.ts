/**
 * CONTRACT-V11-ACTIVITY §3–5: "ne dinliyor" as a status, apart from sharing
 * music. Pure (no Electron, no timers of its own): main/listening.ts drives it.
 *
 * The Windows reader (main/nowPlaying.ts) reports every media session —
 * `{source: "sessions", winrt, sessions: [{app, status, title, artist}],
 * spotify: <Spotify window title> | null, error?}`. From ONE such reading two
 * answers are made:
 *
 * - the V8 share title (`fromSourceRecord` in nowPlaying.ts): the first
 *   Playing session of any app, exactly as V8 did;
 * - the status (`ListeningTracker` here): the first Playing session of an
 *   ALLOWED app — a known music app, or anything when the user turned the
 *   browsers option on.
 */
import { APP_MAX, appLabel, cleanText, parseSpotifyTitle, sanitiseNowPlaying, type NowPlaying } from "./nowPlaying";

/**
 * Known music apps, matched case-insensitively by substring of the session's
 * AppUserModelId. NONE was read on a real Windows machine (see the contract's
 * table for where each token comes from).
 */
export const MUSIC_APPS: readonly { name: string; tokens: readonly string[] }[] = [
  { name: "Spotify", tokens: ["spotify"] },
  { name: "Apple Music", tokens: ["applemusic"] },
  { name: "iTunes", tokens: ["itunes"] },
  { name: "TIDAL", tokens: ["tidal"] },
  { name: "Deezer", tokens: ["deezer"] },
  { name: "Amazon Music", tokens: ["amazonmusic", "amazon.music"] },
  { name: "YouTube Music", tokens: ["youtube-music", "youtubemusic"] },
  { name: "SoundCloud", tokens: ["soundcloud"] },
  { name: "foobar2000", tokens: ["foobar2000"] },
  { name: "AIMP", tokens: ["aimp"] },
  { name: "MusicBee", tokens: ["musicbee"] },
  { name: "Winamp", tokens: ["winamp"] },
];

/** Browsers: shown only with the option on (a tab can be anything). */
export const BROWSER_TOKENS: readonly string[] = [
  "chrome",
  "msedge",
  "microsoftedge",
  "firefox",
  "308046b0af4a39cb", // Firefox's AUMID
  "opera",
  "brave",
  "vivaldi",
  "yandex",
];

export type AppKind = "music" | "browser" | "other";

/** What kind of app a session belongs to; a browser wins over a music token ("Chrome._crx_…youtube…"). */
export function classifyApp(id: unknown): AppKind {
  if (typeof id !== "string" || id.length === 0) return "other";
  const lower = id.toLowerCase();
  if (BROWSER_TOKENS.some((token) => lower.includes(token))) return "browser";
  if (MUSIC_APPS.some((app) => app.tokens.some((token) => lower.includes(token)))) return "music";
  return "other";
}

/** The friendly name of a known music app, else V8's label. */
export function musicAppName(id: unknown): string | null {
  if (typeof id === "string") {
    const lower = id.toLowerCase();
    if (!BROWSER_TOKENS.some((token) => lower.includes(token))) {
      const hit = MUSIC_APPS.find((app) => app.tokens.some((token) => lower.includes(token)));
      if (hit) return hit.name;
    }
  }
  return appLabel(id);
}

export function allowed(kind: AppKind, browsers: boolean): boolean {
  return kind === "music" || browsers;
}

export interface MediaSession {
  /** The raw AppUserModelId (cleaned, capped); local only, never sent. */
  app: string;
  playing: boolean;
  title: string | null;
  artist: string | null;
}

export interface SessionsReading {
  /** False: the media session API was not available; only Spotify's window is read. */
  winrt: boolean;
  sessions: MediaSession[];
  /** Spotify's main window title, null when no Spotify window. */
  spotify: string | null;
  error: string | null;
}

const MAX_SESSIONS = 16;

/** The reader's `sessions` record, checked; null for anything else. */
export function readSessions(raw: unknown): SessionsReading | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (record.source !== "sessions") return null;
  // PowerShell 5.1 may serialise a one-element array as the element itself.
  const list = Array.isArray(record.sessions) ? record.sessions : record.sessions ? [record.sessions] : [];
  const sessions: MediaSession[] = [];
  const seen = new Set<string>();
  for (const item of list.slice(0, MAX_SESSIONS)) {
    if (typeof item !== "object" || item === null) continue;
    const s = item as Record<string, unknown>;
    const app = cleanText(s.app, 120) ?? "";
    const session: MediaSession = {
      app,
      playing: s.status === "Playing" || s.status === 4,
      title: cleanText(s.title, 120),
      artist: cleanText(s.artist, 120),
    };
    // The current session is listed twice (first, and among all sessions).
    const key = JSON.stringify(session);
    if (seen.has(key)) continue;
    seen.add(key);
    sessions.push(session);
  }
  return {
    winrt: record.winrt !== false,
    sessions,
    spotify: typeof record.spotify === "string" ? record.spotify : null,
    error: cleanText(record.error, 200),
  };
}

/** V8's answer from a sessions reading: the first Playing session of any app, else Spotify's window. */
export function shareValue(reading: SessionsReading): NowPlaying | null {
  for (const s of reading.sessions) {
    if (!s.playing || !s.title) continue;
    return sanitiseNowPlaying({ title: s.title, artist: s.artist ?? undefined, app: appLabel(s.app) ?? undefined });
  }
  return parseSpotifyTitle(reading.spotify);
}

export type ListeningHealth = "off" | "starting" | "ok" | "limited" | "failed" | "unsupported";

export interface ListeningState {
  playing: NowPlaying | null;
  health: ListeningHealth;
  message?: string;
  /** The app Windows reported as playing, last seen; local diagnostics. */
  lastApp?: { name: string; shown: boolean };
}

export function sameState(a: ListeningState, b: ListeningState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Keep the last song this long while its app is still there but paused. */
export const PAUSE_HOLD_MS = 30_000;

/**
 * Turns readings into the status' `playing`, holding through a pause for
 * PAUSE_HOLD_MS and dropping at once when the app's session is gone.
 */
export class ListeningTracker {
  private value: NowPlaying | null = null;
  /** The session's app id (or "spotify-window") the value came from. */
  private from: string | null = null;
  private lastPlayingAt = 0;
  lastApp: { name: string; shown: boolean } | undefined;

  constructor(private readonly now: () => number) {}

  reset(): void {
    this.value = null;
    this.from = null;
    this.lastApp = undefined;
  }

  /** When the hold ends (ms clock), or null when nothing is held. */
  holdEndsAt(): number | null {
    return this.value && this.heldOnly ? this.lastPlayingAt + PAUSE_HOLD_MS : null;
  }

  private heldOnly = false;

  update(reading: SessionsReading | null, browsers: boolean): NowPlaying | null {
    const now = this.now();
    if (!reading) {
      this.value = null;
      this.from = null;
      this.heldOnly = false;
      return null;
    }
    const firstPlaying = reading.sessions.find((s) => s.playing && s.title);
    if (firstPlaying) {
      const kind = classifyApp(firstPlaying.app);
      this.lastApp = { name: cleanText(firstPlaying.app, 80) ?? "?", shown: allowed(kind, browsers) };
    }
    for (const s of reading.sessions) {
      if (!s.playing || !s.title || !allowed(classifyApp(s.app), browsers)) continue;
      this.value = sanitiseNowPlaying({
        title: s.title,
        artist: s.artist ?? undefined,
        app: cleanText(musicAppName(s.app), APP_MAX) ?? undefined,
      });
      this.from = s.app;
      this.lastPlayingAt = now;
      this.heldOnly = false;
      return this.value;
    }
    // No allowed session plays. Spotify's window ("Artist - Song") when its
    // session is not listed (the media session API failed or Spotify does not publish).
    const spotifySession = reading.sessions.some((s) => classifyApp(s.app) === "music" && /spotify/i.test(s.app));
    const fromWindow = spotifySession ? null : parseSpotifyTitle(reading.spotify);
    if (fromWindow) {
      if (!firstPlaying) this.lastApp = { name: "Spotify (pencere)", shown: true };
      this.value = fromWindow;
      this.from = "spotify-window";
      this.lastPlayingAt = now;
      this.heldOnly = false;
      return this.value;
    }
    // Paused: the same app is still there (its session, or Spotify's window).
    const stillAllowed = this.from === "spotify-window" || allowed(classifyApp(this.from), browsers);
    const stillThere =
      this.from !== null &&
      stillAllowed &&
      (this.from === "spotify-window" ? reading.spotify !== null : reading.sessions.some((s) => s.app === this.from));
    if (this.value && stillThere && now - this.lastPlayingAt < PAUSE_HOLD_MS) {
      this.heldOnly = true;
      return this.value;
    }
    this.value = null;
    this.from = null;
    this.heldOnly = false;
    return null;
  }
}

export const FAILED_PREFIX = "Müzik durumu okunamadı";
