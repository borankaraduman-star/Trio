/**
 * The TrioDurum addon's status line (CONTRACT-V5 §3):
 *
 *     TRIO1;<seq>;<unix time>;<name>;<realm>;<level>;<classToken>;<zone>;<subzone>;<kind>
 *
 * Fields are percent-encoded (`%XX` for `% ; | \` and control bytes); every
 * other byte is UTF-8 as the game wrote it. A chat-log line carries the frame
 * after the game's own prefix ("11/19 21:03:04.123  To Kahve Kokusu: "), so the
 * frame is found by its marker, not at the start.
 */

export const TRIO_MARKER = "TRIO1;";
export const LINE_KINDS = ["login", "zone", "level", "beat", "logout", "test"] as const;
export type LineKind = (typeof LINE_KINDS)[number];

export interface TrioRecord {
  seq: number;
  /** Unix seconds, from the game client's clock (the same machine). */
  time: number;
  name: string;
  realm: string;
  level: number;
  class: string;
  zone: string;
  subzone: string;
  kind: LineKind;
}

/** Percent-decode one field to text (bytes, then UTF-8). Null when malformed. */
export function decodeField(field: string): string | null {
  const bytes: number[] = [];
  const raw = Buffer.from(field, "utf8");
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i] as number;
    if (b === 0x25) {
      const hex = raw.subarray(i + 1, i + 3).toString("latin1");
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return null;
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(b);
    }
  }
  const text = Buffer.from(bytes).toString("utf8");
  // Control characters have no place in a name or a zone.
  return text.replace(/[\u0000-\u001f\u007f]/g, "").trim();
}

function int(field: string, min: number, max: number): number | null {
  if (!/^-?\d{1,15}$/.test(field)) return null;
  const n = Number(field);
  return n >= min && n <= max ? n : null;
}

/**
 * The record in `text` (one line of the chat log, or the saved `line`), or
 * null when it has no well-formed TRIO1 frame.
 */
export function decodeTrioLine(text: string): TrioRecord | null {
  const at = text.indexOf(TRIO_MARKER);
  if (at < 0) return null;
  const payload = text.slice(at).replace(/[\s\r\n]+$/u, "");
  const fields = payload.split(";");
  if (fields.length !== 10 || fields[0] !== "TRIO1") return null;
  const [, seqF, timeF, nameF, realmF, levelF, classF, zoneF, subF, kindF] = fields as [
    string, string, string, string, string, string, string, string, string, string,
  ];
  const seq = int(seqF, 0, Number.MAX_SAFE_INTEGER);
  const time = int(timeF, 0, 99_999_999_999);
  const level = int(levelF, 0, 999);
  if (seq === null || time === null || level === null) return null;
  if (!(LINE_KINDS as readonly string[]).includes(kindF)) return null;
  if (!/^[A-Z_]{0,24}$/.test(classF)) return null;
  const name = decodeField(nameF);
  const realm = decodeField(realmF);
  const zone = decodeField(zoneF);
  const subzone = decodeField(subF);
  if (name === null || realm === null || zone === null || subzone === null || name === "") return null;
  return { seq, time, name, realm, level, class: classF, zone, subzone, kind: kindF as LineKind };
}

/** Newer by the addon's own order: time first, then sequence. */
export function isNewer(a: TrioRecord, than: TrioRecord | null): boolean {
  if (than === null) return true;
  if (a.time !== than.time) return a.time > than.time;
  return a.seq > than.seq;
}
