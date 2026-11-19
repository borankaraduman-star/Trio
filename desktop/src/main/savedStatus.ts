/** The addon's SavedVariables (`TrioDurumDB`) to a status record. */
import { decodeTrioLine, LINE_KINDS, type LineKind, type TrioRecord } from "../shared/trioLine";
import { parseSavedVariables, type LuaTable, type LuaValue } from "../shared/luaTable";

const str = (v: LuaValue | undefined): string => (typeof v === "string" ? v.trim() : "");

/**
 * The last status the addon saved, or null. The saved `line` is the same
 * frame the chat log carries; when it is missing or damaged the separate
 * fields are used.
 */
export function savedRecord(source: Buffer | string): TrioRecord | null {
  let top: LuaTable;
  try {
    top = parseSavedVariables(source);
  } catch {
    return null;
  }
  const db = top.TrioDurumDB;
  if (!db || typeof db !== "object") return null;
  const last = db.last;
  if (!last || typeof last !== "object") return null;
  if (typeof last.line === "string") {
    const fromLine = decodeTrioLine(last.line);
    if (fromLine) {
      // At logout the game writes the table after PLAYER_LOGOUT set kind.
      const kind = str(last.kind);
      if ((LINE_KINDS as readonly string[]).includes(kind)) fromLine.kind = kind as LineKind;
      return fromLine;
    }
  }
  const { seq, time, level } = last;
  const name = str(last.name);
  const kind = str(last.kind);
  if (typeof seq !== "number" || typeof time !== "number" || typeof level !== "number" || !name) return null;
  if (!(LINE_KINDS as readonly string[]).includes(kind)) return null;
  const klass = str(last.class);
  return {
    seq,
    time,
    name: name.slice(0, 64),
    realm: str(last.realm).slice(0, 64),
    level: Math.max(0, Math.min(999, Math.trunc(level))),
    class: /^[A-Z_]{0,24}$/.test(klass) ? klass : "",
    zone: str(last.zone).slice(0, 96),
    subzone: str(last.subzone).slice(0, 96),
    kind: kind as LineKind,
  };
}
