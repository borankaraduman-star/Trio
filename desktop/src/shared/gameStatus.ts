/**
 * The game status the desktop app reports (CONTRACT-V5 §2): two layers merged.
 *
 * - Process layer: which game from the table is running, and since when
 *   (first seen by this app). Needs no addon.
 * - Addon layer: the TrioDurum addon's latest record (chat log, or the
 *   SavedVariables fallback) adds `detail` — level, zone — to a WoW status.
 *
 * Pure: the clock is passed in, so every rule is tested with a fake one.
 */
import { isNewer, type TrioRecord } from "./trioLine";
import type { GameEntry } from "./gameCatalog";

export type DetailSource = "log" | "saved";

export interface GameDetail {
  character: string;
  realm: string;
  level: number;
  class: string;
  zone: string;
  subzone: string;
  source: DetailSource;
}

export interface GameStatus {
  game: string;
  /** Unix seconds. */
  since: number;
  detail?: GameDetail;
}

/** A record older than this is history: ignored at start-up and later. */
export const RECORD_MAX_AGE_S = 10 * 60;
/** No line for this long (the addon beats every 4 min): the addon layer is gone. */
export const ADDON_OFFLINE_AFTER_S = 12 * 60;
/** The display name when the addon reports but no WoW process was matched. */
export const DEFAULT_WOW_NAME = "World of Warcraft";

interface Running {
  entry: GameEntry;
  since: number;
}

export class GameStatusModel {
  private running = new Map<string, Running>();
  /** When a matched WoW process was last seen to stop. */
  private wowStoppedAt: number | null = null;
  private record: TrioRecord | null = null;
  private recordSource: DetailSource = "log";
  /** When the addon layer started reporting this session (for `since`). */
  private addonSince: number | null = null;
  lastAccepted: { record: TrioRecord; source: DetailSource; at: number } | null = null;

  constructor(private readonly nowS: () => number) {}

  /** One poll of the process layer: the entries that matched (may repeat). */
  setRunning(matches: readonly GameEntry[] | null): void {
    if (matches === null) return; // the list could not be read: keep what we had
    const now = this.nowS();
    const next = new Map<string, Running>();
    for (const entry of matches) {
      const key = entry.name;
      if (next.has(key)) continue;
      next.set(key, this.running.get(key) ?? { entry, since: now });
    }
    const wowBefore = [...this.running.values()].some((r) => r.entry.wow);
    const wowNow = [...next.values()].some((r) => r.entry.wow);
    if (wowBefore && !wowNow) this.wowStoppedAt = now;
    this.running = next;
  }

  /** A record from the log or the SavedVariables. True when it was taken. */
  addRecord(record: TrioRecord, source: DetailSource): boolean {
    const now = this.nowS();
    if (now - record.time > RECORD_MAX_AGE_S) return false;
    if (!isNewer(record, this.record)) return false;
    this.record = record;
    this.recordSource = source;
    this.lastAccepted = { record, source, at: now };
    if (record.kind === "logout") this.addonSince = null;
    else if (this.addonSince === null) this.addonSince = Math.min(record.time, now);
    return true;
  }

  private detail(wowRunning: boolean): GameDetail | null {
    const r = this.record;
    if (!r || r.kind === "logout") return null;
    if (this.nowS() - r.time >= ADDON_OFFLINE_AFTER_S) return null;
    // The game was seen running and then stopped: what the addon said before
    // that is stale (a newer line means a client this table does not know).
    if (!wowRunning && this.wowStoppedAt !== null && r.time <= this.wowStoppedAt) return null;
    return {
      character: r.name,
      realm: r.realm,
      level: r.level,
      class: r.class,
      zone: r.zone,
      subzone: r.subzone,
      source: this.recordSource,
    };
  }

  status(): GameStatus | null {
    const running = [...this.running.values()];
    const wow = running.filter((r) => r.entry.wow).sort((a, b) => a.since - b.since)[0];
    const detail = this.detail(wow !== undefined);
    if (wow) {
      return detail ? { game: wow.entry.name, since: wow.since, detail } : { game: wow.entry.name, since: wow.since };
    }
    if (detail) {
      return { game: DEFAULT_WOW_NAME, since: this.addonSince ?? this.nowS(), detail };
    }
    const other = running.sort((a, b) => a.since - b.since)[0];
    return other ? { game: other.entry.name, since: other.since } : null;
  }
}

export function sameStatus(a: GameStatus | null, b: GameStatus | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
