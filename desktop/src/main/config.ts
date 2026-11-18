/** The stored server origin: `<userData>/trio-config.json`. */
import * as fs from "node:fs";
import * as path from "node:path";
import { validateServerUrl } from "../shared/url";

interface StoredConfig {
  serverUrl?: string;
}

export class ConfigStore {
  private readonly file: string;

  constructor(directory: string) {
    this.file = path.join(directory, "trio-config.json");
  }

  /** The stored origin, or null when none (or the file is not usable). */
  getServerOrigin(): string | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as StoredConfig;
      if (typeof raw.serverUrl !== "string") return null;
      const check = validateServerUrl(raw.serverUrl);
      return check.ok ? check.origin : null;
    } catch {
      return null;
    }
  }

  setServerOrigin(origin: string): void {
    const data: StoredConfig = { serverUrl: origin };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, this.file);
  }
}
