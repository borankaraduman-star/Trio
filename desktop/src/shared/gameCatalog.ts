/**
 * Which running programs are games, by executable name (CONTRACT-V5 §2).
 *
 * The process list itself never leaves the main process; only a match against
 * this table (built-in entries plus the ones the user added) becomes a status.
 */

export interface GameEntry {
  /** Normalised executable names (see `normaliseExecutable`). */
  executables: string[];
  /** What the others see: "World of Warcraft", "Counter-Strike 2". */
  name: string;
  /** A WoW client: the addon's level and zone may be added to it. */
  wow: boolean;
  /** Added by the user from the running processes. */
  custom?: boolean;
}

export interface CustomGame {
  executable: string;
  name: string;
}

export const BUILT_IN_GAMES: readonly GameEntry[] = [
  {
    name: "World of Warcraft",
    wow: true,
    executables: [
      "wow", "wow-64", "wowb", "wowt", "wowclassic", "wowclassicb", "wowclassict",
      "world of warcraft", "world of warcraft classic", "world of warcraft beta",
      "world of warcraft public test",
    ],
  },
  { name: "Counter-Strike 2", wow: false, executables: ["cs2"] },
  { name: "VALORANT", wow: false, executables: ["valorant-win64-shipping"] },
  // The game itself, not LeagueClient (the launcher stays open between games).
  { name: "League of Legends", wow: false, executables: ["league of legends"] },
  { name: "Rocket League", wow: false, executables: ["rocketleague"] },
  { name: "Dota 2", wow: false, executables: ["dota2"] },
  { name: "Grand Theft Auto V", wow: false, executables: ["gta5", "gta5_enhanced"] },
  { name: "Fortnite", wow: false, executables: ["fortniteclient-win64-shipping"] },
  { name: "Overwatch 2", wow: false, executables: ["overwatch"] },
  { name: "Diablo IV", wow: false, executables: ["diablo iv"] },
  { name: "Hearthstone", wow: false, executables: ["hearthstone"] },
  { name: "ELDEN RING", wow: false, executables: ["eldenring"] },
];

const MAX_NAME = 64;

/**
 * One process name as the OS reports it — `Wow.exe`, `C:\Games\Wow.exe`,
 * `/Applications/World of Warcraft/_retail_/World of Warcraft.app/Contents/MacOS/World of Warcraft`,
 * `wine` paths — to the key the table uses: the bundle name for a macOS app,
 * else the file name; lower case; without `.exe`/`.app`.
 */
export function normaliseExecutable(raw: string): string {
  let s = raw.trim();
  const bundle = /([^/\\]+)\.app(?:[/\\]|$)/i.exec(s);
  if (bundle) s = bundle[1] as string;
  else s = s.split(/[/\\]/).pop() ?? s;
  s = s.replace(/\.(exe|app)$/i, "");
  return s.trim().toLowerCase();
}

/** The table: built-ins, then the user's own (a user entry wins on a clash). */
export function catalog(custom: readonly CustomGame[]): GameEntry[] {
  const own: GameEntry[] = custom
    .map((c) => ({
      executables: [normaliseExecutable(c.executable)],
      name: cleanGameName(c.name) ?? "",
      wow: /wow|warcraft/i.test(c.name) || /^wow/i.test(normaliseExecutable(c.executable)),
      custom: true,
    }))
    .filter((e) => e.name !== "" && e.executables[0] !== "");
  return [...own, ...BUILT_IN_GAMES];
}

export function matchProcess(raw: string, table: readonly GameEntry[]): GameEntry | null {
  const key = normaliseExecutable(raw);
  if (key === "") return null;
  return table.find((entry) => entry.executables.includes(key)) ?? null;
}

/** A display name the user typed: one line, 1–64 characters. */
export function cleanGameName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim();
  if (name.length < 1 || name.length > MAX_NAME) return null;
  return name;
}

/**
 * The distinct process names to offer under "Şu an çalışanlardan ekle":
 * sorted, without the obvious system ones, never with a path.
 */
export function offerable(processes: readonly string[]): string[] {
  const seen = new Map<string, string>();
  for (const raw of processes) {
    const key = normaliseExecutable(raw);
    if (!key || key.length > 80 || SYSTEM.has(key)) continue;
    if (!seen.has(key)) {
      const base = /([^/\\]+\.app)(?:[/\\]|$)/i.exec(raw)?.[1] ?? raw.split(/[/\\]/).pop() ?? raw;
      seen.set(key, base.trim());
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

const SYSTEM = new Set([
  "system", "system idle process", "registry", "smss", "csrss", "wininit", "services", "lsass",
  "svchost", "winlogon", "dwm", "explorer", "conhost", "runtimebroker", "taskhostw", "sihost",
  "ctfmon", "searchhost", "startmenuexperiencehost", "fontdrvhost", "spoolsv", "dllhost",
  "audiodg", "tasklist", "ps", "launchd", "kernel_task", "windowserver", "loginwindow",
  "systemd", "kthreadd", "bash", "zsh", "sh", "sshd", "trio", "electron",
]);
