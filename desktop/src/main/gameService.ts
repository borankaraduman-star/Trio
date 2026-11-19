/**
 * "Oyun durumu" in the main process: process detection, the chat-log tailer,
 * the SavedVariables fallback, the merged status, diagnostics and settings.
 *
 * No Electron import: main.ts wires it to IPC, tests drive it directly with
 * temp folders, a fake process lister and a fake clock.
 *
 * What leaves this object: the merged GameStatus (to the page, through the
 * bridge), the diagnostics (to the local settings window) and, for the
 * "add from running" list, process NAMES (to the local settings window only).
 * Chat lines other than TrioDurum's never reach it at all (the tailer drops
 * them), and the process list is never sent to the page.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { ChatLogTailer, type TailInfo } from "./chatLogTailer";
import { chatLogPath, findSavedVariables } from "./wowFolder";
import { savedRecord } from "./savedStatus";
import type { ProcessLister } from "./processList";
import { catalog, cleanGameName, matchProcess, normaliseExecutable, offerable, type CustomGame } from "../shared/gameCatalog";
import { decodeTrioLine, type TrioRecord } from "../shared/trioLine";
import { GameStatusModel, sameStatus, type GameStatus } from "../shared/gameStatus";

export interface GameConfig {
  wowFolder: string | null;
  customGames: CustomGame[];
}

export class GameConfigStore {
  private readonly file: string;
  constructor(directory: string) {
    this.file = path.join(directory, "trio-game.json");
  }
  load(): GameConfig {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<GameConfig>;
      const customGames = Array.isArray(raw.customGames)
        ? raw.customGames
            .filter((g): g is CustomGame => !!g && typeof g.executable === "string" && typeof g.name === "string")
            .slice(0, 50)
        : [];
      return { wowFolder: typeof raw.wowFolder === "string" ? raw.wowFolder : null, customGames };
    } catch {
      return { wowFolder: null, customGames: [] };
    }
  }
  save(config: GameConfig): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), "utf8");
    fs.renameSync(tmp, this.file);
  }
}

export const PROCESS_POLL_MS = 15_000;
export const LOG_POLL_MS = 2_000;
export const SAVED_POLL_MS = 5_000;

export interface Diagnostics {
  folder: string | null;
  log: TailInfo & { path: string | null };
  lastFrame: { line: string; seenAt: number; source: "log" | "saved" } | null;
  saved: { found: boolean; mtimeMs: number; path: string | null };
  processes: { readable: boolean | null; matched: string[] };
  status: GameStatus | null;
}

export interface GameServiceOptions {
  config: GameConfigStore;
  listProcesses: ProcessLister;
  /** Milliseconds since the epoch. */
  now?: () => number;
  onStatus: (status: GameStatus | null) => void;
}

export class GameService {
  private config: GameConfig;
  private readonly now: () => number;
  private model: GameStatusModel;
  private tailer: ChatLogTailer | null = null;
  private savedMtime = 0;
  private lastFrame: Diagnostics["lastFrame"] = null;
  private lastProcesses: string[] | null = null;
  private processesReadable: boolean | null = null;
  private current: GameStatus | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private watcher: fs.FSWatcher | null = null;
  private running = false;

  constructor(private readonly options: GameServiceOptions) {
    this.now = options.now ?? Date.now;
    this.config = options.config.load();
    this.model = new GameStatusModel(() => Math.floor(this.now() / 1000));
    this.openFolder();
  }

  get status(): GameStatus | null {
    return this.current;
  }

  get folder(): string | null {
    return this.config.wowFolder;
  }

  get customGames(): CustomGame[] {
    return [...this.config.customGames];
  }

  // -- life cycle ----------------------------------------------------------------

  /** Start the timers (idempotent). Detection runs only while somebody listens. */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.pollAll();
    this.timers.push(setInterval(() => void this.pollProcesses(), PROCESS_POLL_MS));
    this.timers.push(setInterval(() => void this.pollLog(), LOG_POLL_MS));
    this.timers.push(setInterval(() => this.pollSaved(), SAVED_POLL_MS));
    this.watch();
  }

  stop(): void {
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.watcher?.close();
    this.watcher = null;
  }

  async pollAll(): Promise<void> {
    await this.pollProcesses();
    await this.pollLog();
    this.pollSaved();
  }

  // -- settings -------------------------------------------------------------------

  setFolder(folder: string | null): void {
    this.config = { ...this.config, wowFolder: folder };
    this.options.config.save(this.config);
    this.openFolder();
    if (this.running) {
      this.watch();
      void this.pollAll();
    }
  }

  addGame(executable: string, name: string): boolean {
    const clean = cleanGameName(name);
    const exe = normaliseExecutable(executable);
    if (!clean || !exe || exe.length > 80) return false;
    const rest = this.config.customGames.filter((g) => normaliseExecutable(g.executable) !== exe);
    this.config = { ...this.config, customGames: [...rest, { executable: executable.trim(), name: clean }].slice(-50) };
    this.options.config.save(this.config);
    void this.pollProcesses();
    return true;
  }

  removeGame(executable: string): void {
    const exe = normaliseExecutable(executable);
    this.config = {
      ...this.config,
      customGames: this.config.customGames.filter((g) => normaliseExecutable(g.executable) !== exe),
    };
    this.options.config.save(this.config);
    void this.pollProcesses();
  }

  /** Running process names to offer for "add" (local settings window only). */
  async runningNames(): Promise<string[]> {
    const names = await this.options.listProcesses();
    return names ? offerable(names) : [];
  }

  // -- polling --------------------------------------------------------------------

  private openFolder(): void {
    const folder = this.config.wowFolder;
    this.tailer = folder ? new ChatLogTailer(chatLogPath(folder), (frame) => this.onFrame(frame, "log")) : null;
    this.savedMtime = 0;
  }

  private watch(): void {
    this.watcher?.close();
    this.watcher = null;
    const folder = this.config.wowFolder;
    if (!folder) return;
    try {
      // A hint only; the timer polls anyway (network and OneDrive folders).
      this.watcher = fs.watch(path.join(folder, "Logs"), { persistent: false }, () => void this.pollLog());
      this.watcher.on("error", () => {
        this.watcher?.close();
        this.watcher = null;
      });
    } catch {
      this.watcher = null;
    }
  }

  async pollProcesses(): Promise<void> {
    const names = await this.options.listProcesses();
    this.processesReadable = names !== null;
    if (names === null) {
      this.emit();
      return;
    }
    const table = catalog(this.config.customGames);
    const matches = names.map((n) => matchProcess(n, table)).filter((m) => m !== null);
    this.lastProcesses = [...new Set(matches.map((m) => m.name))];
    this.model.setRunning(matches);
    this.emit();
  }

  async pollLog(): Promise<void> {
    await this.tailer?.poll();
    this.emit();
  }

  pollSaved(): void {
    const folder = this.config.wowFolder;
    if (!folder) return;
    const found = findSavedVariables(folder);
    if (!found || found.mtimeMs === this.savedMtime) {
      this.emit();
      return;
    }
    this.savedMtime = found.mtimeMs;
    try {
      const record = savedRecord(fs.readFileSync(found.file));
      if (record) this.accept(record, "saved", lineOf(record));
    } catch {
      // unreadable this time; the mtime check retries when it changes
    }
    this.emit();
  }

  private onFrame(frame: string, source: "log" | "saved"): void {
    const record = decodeTrioLine(frame);
    if (record) this.accept(record, source, frame);
  }

  private accept(record: TrioRecord, source: "log" | "saved", line: string): void {
    if (this.model.addRecord(record, source)) {
      this.lastFrame = { line: line.slice(0, 300), seenAt: this.now(), source };
    }
  }

  /** Recompute; tell the listener only when the status changed. */
  private emit(): void {
    const next = this.model.status();
    if (sameStatus(next, this.current)) return;
    this.current = next;
    this.options.onStatus(next);
  }

  /** Re-evaluate time-based rules (the addon going quiet) without new input. */
  refresh(): void {
    this.emit();
  }

  // -- diagnostics ----------------------------------------------------------------

  diagnostics(): Diagnostics {
    const folder = this.config.wowFolder;
    const saved = folder ? findSavedVariables(folder) : null;
    return {
      folder,
      log: {
        ...(this.tailer?.info ?? { state: "missing", size: 0, mtimeMs: 0, error: null }),
        path: folder ? path.join("Logs", "WoWChatLog.txt") : null,
      },
      lastFrame: this.lastFrame,
      saved: {
        found: saved !== null,
        mtimeMs: saved?.mtimeMs ?? 0,
        path: saved ? path.join("WTF", "Account", "<hesap>", "SavedVariables", "TrioDurum.lua") : null,
      },
      processes: { readable: this.processesReadable, matched: this.lastProcesses ?? [] },
      status: this.current,
    };
  }
}

function lineOf(r: TrioRecord): string {
  return `TRIO1;${r.seq};${r.time};${r.name};${r.realm};${r.level};${r.class};${r.zone};${r.subzone};${r.kind}`;
}

const ago = (ms: number, now: number): string => {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 90) return `${s} sn önce`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} dk önce`;
  return `${Math.round(m / 60)} sa önce`;
};

/** The "Kopyala" text: no chat content, no path outside the chosen folder. */
export function diagnosticsText(d: Diagnostics, now: number, version: string, platform: string): string {
  const lines = [
    `Trio oyun durumu tanılama — Trio masaüstü ${version}, ${platform}`,
    `Klasör: ${d.folder ?? "(seçilmedi)"}`,
    `Sohbet kaydı (${d.log.path ?? "Logs/WoWChatLog.txt"}): ${
      d.log.state === "ok"
        ? `var, ${d.log.size} bayt, son değişiklik ${d.log.mtimeMs ? ago(d.log.mtimeMs, now) : "?"}`
        : d.log.state === "missing"
          ? "yok"
          : `okunamıyor (${d.log.error ?? "?"})`
    }`,
    `Son TRIO1 satırı: ${d.lastFrame ? `${d.lastFrame.line} (${d.lastFrame.source === "log" ? "kayıttan" : "SavedVariables'tan"}, ${ago(d.lastFrame.seenAt, now)})` : "görülmedi"}`,
    `SavedVariables (${d.saved.path ?? "WTF/Account/<hesap>/SavedVariables/TrioDurum.lua"}): ${
      d.saved.found ? `var, son yazılma ${ago(d.saved.mtimeMs, now)}` : "bulunamadı"
    }`,
    `İşlem listesi: ${d.processes.readable === null ? "henüz okunmadı" : d.processes.readable ? "okunuyor" : "okunamıyor"}; tanınan oyun: ${
      d.processes.matched.length ? d.processes.matched.join(", ") : "yok"
    }`,
    `Gönderilen durum: ${d.status ? JSON.stringify(d.status) : "yok (oyunda değil)"}`,
  ];
  return lines.join("\n");
}
