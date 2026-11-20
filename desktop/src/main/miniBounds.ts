/**
 * CONTRACT-V12-MINI-DESKTOP §3: where each class of mini window was last,
 * `<userData>/trio-mini.json`. At most MAX_CLASSES classes are kept (the
 * oldest go); anything unreadable is treated as nothing remembered.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Rect, SavedMini } from "../shared/mini";

const MAX_CLASSES = 16;

interface Stored {
  [cls: string]: SavedMini & { at: number };
}

function isRect(value: unknown): value is Rect {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return ["x", "y", "width", "height"].every((k) => typeof r[k] === "number" && Number.isFinite(r[k] as number));
}

export class MiniBoundsStore {
  private readonly file: string;
  private cache: Stored | null = null;

  constructor(directory: string, private readonly now: () => number = Date.now) {
    this.file = path.join(directory, "trio-mini.json");
  }

  get(cls: string): SavedMini | null {
    const entry = this.read()[cls];
    return entry ? { bounds: entry.bounds, displayId: entry.displayId } : null;
  }

  set(cls: string, saved: SavedMini): void {
    const data = { ...this.read() };
    const before = data[cls];
    if (
      before &&
      before.displayId === saved.displayId &&
      before.bounds.x === saved.bounds.x &&
      before.bounds.y === saved.bounds.y &&
      before.bounds.width === saved.bounds.width &&
      before.bounds.height === saved.bounds.height
    ) {
      return;
    }
    data[cls] = { bounds: { ...saved.bounds }, displayId: saved.displayId, at: this.now() };
    const keys = Object.keys(data).sort((a, b) => (data[b]?.at ?? 0) - (data[a]?.at ?? 0));
    for (const key of keys.slice(MAX_CLASSES)) delete data[key];
    this.cache = data;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data), "utf8");
      fs.renameSync(tmp, this.file);
    } catch (error) {
      console.warn("[trio] mini window bounds not saved", error);
    }
  }

  private read(): Stored {
    if (this.cache) return this.cache;
    const out: Stored = {};
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as unknown;
      if (typeof raw === "object" && raw !== null) {
        for (const [cls, value] of Object.entries(raw as Record<string, unknown>)) {
          if (!/^[A-Za-z0-9]{1,32}$/.test(cls) || typeof value !== "object" || value === null) continue;
          const v = value as Record<string, unknown>;
          if (!isRect(v.bounds) || typeof v.displayId !== "number") continue;
          out[cls] = { bounds: v.bounds, displayId: v.displayId, at: typeof v.at === "number" ? v.at : 0 };
        }
      }
    } catch {
      /* nothing remembered */
    }
    this.cache = out;
    return out;
  }
}
