/**
 * A tiny parser for the SavedVariables file the game writes for TrioDurum:
 *
 *     TrioDurumDB = {
 *         ["mode"] = "whisper",
 *         ["last"] = {
 *             ["name"] = "Kahve Kokusu",
 *             ["level"] = 37,
 *         },
 *     }
 *
 * Only what that format can contain: assignments of a name to a value; values
 * are tables (`["k"] = v`, `k = v`, positional), strings with Lua escapes,
 * numbers, true/false/nil; `--` comments. Anything else is an error, never
 * code: nothing here evaluates anything.
 */

export type LuaValue = string | number | boolean | null | LuaTable;
export interface LuaTable {
  [key: string]: LuaValue;
}

export class LuaParseError extends Error {}

const MAX_DEPTH = 32;

class Parser {
  private i = 0;
  constructor(private readonly src: Buffer) {}

  private peek(): number {
    return this.i < this.src.length ? (this.src[this.i] as number) : -1;
  }

  private skip(): void {
    for (;;) {
      const c = this.peek();
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x3b) {
        this.i++;
      } else if (c === 0x2d && this.src[this.i + 1] === 0x2d) {
        // A comment; long comments --[[ ]] too.
        if (this.src[this.i + 2] === 0x5b && this.src[this.i + 3] === 0x5b) {
          const end = this.src.indexOf("]]", this.i + 4);
          this.i = end < 0 ? this.src.length : end + 2;
        } else {
          while (this.peek() !== -1 && this.peek() !== 0x0a) this.i++;
        }
      } else if (c === 0xef && this.src[this.i + 1] === 0xbb && this.src[this.i + 2] === 0xbf) {
        this.i += 3; // BOM
      } else {
        return;
      }
    }
  }

  private fail(what: string): never {
    throw new LuaParseError(`${what} at byte ${this.i}`);
  }

  private name(): string | null {
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.subarray(this.i, this.i + 256).toString("latin1"));
    if (!m) return null;
    this.i += m[0].length;
    return m[0];
  }

  program(): LuaTable {
    const out: LuaTable = {};
    this.skip();
    while (this.peek() !== -1) {
      const name = this.name();
      if (name === null) this.fail("expected a name");
      this.skip();
      if (this.peek() !== 0x3d) this.fail("expected =");
      this.i++;
      this.skip();
      out[name] = this.value(0);
      this.skip();
    }
    return out;
  }

  private value(depth: number): LuaValue {
    if (depth > MAX_DEPTH) this.fail("nested too deep");
    const c = this.peek();
    if (c === 0x7b) return this.table(depth + 1);
    if (c === 0x22 || c === 0x27) return this.string();
    if (c === 0x2d || (c >= 0x30 && c <= 0x39) || c === 0x2e) return this.number();
    const word = this.name();
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "nil") return null;
    return this.fail("unexpected value");
  }

  private number(): number {
    const m = /^-?(0x[0-9a-fA-F]+|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)/.exec(
      this.src.subarray(this.i, this.i + 64).toString("latin1"),
    );
    if (!m) this.fail("bad number");
    this.i += m[0].length;
    const n = Number(m[0]);
    if (!Number.isFinite(n)) this.fail("bad number");
    return n;
  }

  private string(): string {
    const quote = this.peek();
    this.i++;
    const bytes: number[] = [];
    for (;;) {
      const c = this.peek();
      if (c === -1 || c === 0x0a) this.fail("unterminated string");
      this.i++;
      if (c === quote) break;
      if (c !== 0x5c) {
        bytes.push(c);
        continue;
      }
      const e = this.peek();
      this.i++;
      const simple: Record<number, number> = {
        0x6e: 0x0a, 0x74: 0x09, 0x72: 0x0d, 0x61: 0x07, 0x62: 0x08, 0x66: 0x0c, 0x76: 0x0b,
        0x5c: 0x5c, 0x22: 0x22, 0x27: 0x27, 0x0a: 0x0a,
      };
      if (simple[e] !== undefined) {
        bytes.push(simple[e] as number);
      } else if (e >= 0x30 && e <= 0x39) {
        let digits = String.fromCharCode(e);
        while (digits.length < 3 && this.peek() >= 0x30 && this.peek() <= 0x39) {
          digits += String.fromCharCode(this.peek());
          this.i++;
        }
        const n = Number(digits);
        if (n > 255) this.fail("bad escape");
        bytes.push(n);
      } else {
        this.fail("bad escape");
      }
    }
    return Buffer.from(bytes).toString("utf8");
  }

  private table(depth: number): LuaTable {
    this.i++; // {
    const out: LuaTable = {};
    let position = 1;
    for (;;) {
      this.skip();
      const c = this.peek();
      if (c === 0x7d) {
        this.i++;
        return out;
      }
      let key: string;
      if (c === 0x5b) {
        this.i++;
        this.skip();
        const k = this.value(depth);
        if (typeof k !== "string" && typeof k !== "number") this.fail("bad key");
        key = String(k);
        this.skip();
        if (this.peek() !== 0x5d) this.fail("expected ]");
        this.i++;
        this.skip();
        if (this.peek() !== 0x3d) this.fail("expected =");
        this.i++;
        this.skip();
        out[key] = this.value(depth);
      } else {
        const save = this.i;
        const word = this.name();
        this.skip();
        if (word !== null && word !== "true" && word !== "false" && word !== "nil" && this.peek() === 0x3d) {
          this.i++;
          this.skip();
          out[word] = this.value(depth);
        } else {
          this.i = save;
          out[String(position++)] = this.value(depth);
        }
      }
      this.skip();
      if (this.peek() === 0x2c) this.i++;
      else if (this.peek() !== 0x7d) this.fail("expected , or }");
    }
  }
}

/** Every top-level assignment in a SavedVariables file. Throws LuaParseError. */
export function parseSavedVariables(source: Buffer | string): LuaTable {
  const buf = typeof source === "string" ? Buffer.from(source, "utf8") : source;
  return new Parser(buf).program();
}
