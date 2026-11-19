/**
 * Follows `Logs/WoWChatLog.txt` and hands on ONLY the TrioDurum frames in it.
 *
 * Privacy (CONTRACT-V5 §4): every other line of the player's chat is dropped
 * here, as raw bytes, before it is even decoded to text. Nothing in this file
 * logs, stores or returns a line that lacks the `TRIO1;` marker.
 *
 * Robustness:
 * - the file may not exist yet (chat logging off, game never started);
 * - it is appended to while the game runs (how promptly the game flushes is
 *   NOT known: see CONTRACT-V5 §7);
 * - it may be truncated or replaced when the game restarts: a smaller size or
 *   a different identity (inode / birth time) starts over from the top;
 * - a large existing file is not read: the first look starts near its end
 *   (`START_BACKLOG` bytes, enough for the last few minutes of lines);
 * - a partial last line waits for its newline;
 * - a UTF-8 BOM at the start is skipped;
 * - `fs.watch` is only a hint (it is unreliable on network/OneDrive folders):
 *   the owner of this object calls `poll()` on a timer as well.
 * - Node opens files on Windows with FILE_SHARE_READ|WRITE|DELETE, so reading
 *   does not lock the game out; if the game holds it exclusively, the open
 *   fails and is reported as an error state, retried next poll.
 */
import * as fs from "node:fs";
import { TRIO_MARKER } from "../shared/trioLine";

const MARKER = Buffer.from(TRIO_MARKER, "utf8");
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
export const START_BACKLOG = 64 * 1024;
/** At most this much is read per poll; a longer gap is caught up over polls. */
export const MAX_READ = 4 * 1024 * 1024;
/** A "line" longer than this without a newline is dropped (not a chat line). */
const MAX_LINE = 64 * 1024;

export type TailState = "missing" | "ok" | "error";

export interface TailInfo {
  state: TailState;
  size: number;
  mtimeMs: number;
  error: string | null;
}

export class ChatLogTailer {
  private offset = -1; // -1: not opened yet
  private identity = "";
  private partial: Buffer = Buffer.alloc(0);
  private dropPartial = false;
  info: TailInfo = { state: "missing", size: 0, mtimeMs: 0, error: null };
  private busy = false;

  constructor(
    readonly file: string,
    private readonly onFrame: (frame: string) => void,
    private readonly backlog = START_BACKLOG,
  ) {}

  /** Read whatever is new. Never throws. */
  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.step();
    } finally {
      this.busy = false;
    }
  }

  private async step(): Promise<void> {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(this.file);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      this.info = { state: code === "ENOENT" ? "missing" : "error", size: 0, mtimeMs: 0, error: code ?? "stat" };
      // A file that comes back is a new file: read it from the top.
      if (this.offset >= 0) this.reset(0);
      return;
    }
    const identity = `${stat.ino}:${stat.birthtimeMs}`;
    if (this.offset < 0) {
      // First look: near the end of whatever is there.
      this.identity = identity;
      this.reset(Math.max(0, stat.size - this.backlog));
      this.dropPartial = this.offset > 0; // we landed mid-line
    } else if (identity !== this.identity || stat.size < this.offset) {
      this.identity = identity;
      this.reset(0);
    }
    this.info = { state: "ok", size: stat.size, mtimeMs: stat.mtimeMs, error: null };
    if (stat.size <= this.offset) return;
    const length = Math.min(stat.size - this.offset, MAX_READ);
    let handle: fs.promises.FileHandle | null = null;
    try {
      handle = await fs.promises.open(this.file, "r");
      const buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, this.offset);
      this.consume(buf.subarray(0, bytesRead), this.offset === 0);
      this.offset += bytesRead;
    } catch (error) {
      this.info = { ...this.info, state: "error", error: (error as NodeJS.ErrnoException).code ?? "read" };
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private reset(offset: number): void {
    this.offset = offset;
    this.partial = Buffer.alloc(0);
    this.dropPartial = false;
  }

  private consume(chunk: Buffer, atStart: boolean): void {
    let data = chunk;
    if (atStart && data.subarray(0, 3).equals(BOM)) data = data.subarray(3);
    let buf = this.partial.length ? Buffer.concat([this.partial, data]) : data;
    let start = 0;
    for (;;) {
      const nl = buf.indexOf(0x0a, start);
      if (nl < 0) break;
      const line = buf.subarray(start, nl);
      start = nl + 1;
      if (this.dropPartial) {
        this.dropPartial = false;
        continue;
      }
      this.line(line);
    }
    buf = buf.subarray(start);
    if (buf.length > MAX_LINE) {
      this.partial = Buffer.alloc(0);
      this.dropPartial = true;
    } else {
      this.partial = Buffer.from(buf);
    }
  }

  private line(bytes: Buffer): void {
    const at = bytes.indexOf(MARKER);
    if (at < 0) return; // somebody's chat: never decoded, never kept
    this.onFrame(bytes.subarray(at).toString("utf8").replace(/\r$/, ""));
  }
}
