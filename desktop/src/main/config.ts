/** The stored server origin (and §8's remembered next address): `<userData>/trio-config.json`. */
import * as fs from "node:fs";
import * as path from "node:path";
import { validateServerUrl } from "../shared/url";
import type { NextMove } from "./serverMove";

interface StoredConfig {
  serverUrl?: string;
  /** CONTRACT-V11-ADDRESS §8: where the server said it is going, and a move code for it. */
  next?: { origin?: unknown; code?: unknown; expiresAt?: unknown };
}

export class ConfigStore {
  private readonly file: string;

  constructor(directory: string) {
    this.file = path.join(directory, "trio-config.json");
  }

  private read(): StoredConfig {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as unknown;
      return typeof raw === "object" && raw !== null ? (raw as StoredConfig) : {};
    } catch {
      return {};
    }
  }

  private write(data: StoredConfig): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** The stored origin, or null when none (or the file is not usable). */
  getServerOrigin(): string | null {
    const raw = this.read();
    if (typeof raw.serverUrl !== "string") return null;
    const check = validateServerUrl(raw.serverUrl);
    return check.ok ? check.origin : null;
  }

  setServerOrigin(origin: string): void {
    const data = this.read();
    data.serverUrl = origin;
    // A next address belongs to the server that announced it: a change of server (or the
    // move to it) forgets it.
    delete data.next;
    this.write(data);
  }

  getNextMove(): NextMove | null {
    const next = this.read().next;
    if (!next || typeof next.origin !== "string" || typeof next.code !== "string") return null;
    if (typeof next.expiresAt !== "number") return null;
    return { origin: next.origin, code: next.code, expiresAt: next.expiresAt };
  }

  setNextMove(next: NextMove | null): void {
    const data = this.read();
    if (next) data.next = next;
    else delete data.next;
    this.write(data);
  }
}
