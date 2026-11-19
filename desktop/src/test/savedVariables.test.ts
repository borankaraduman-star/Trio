import { test } from "node:test";
import assert from "node:assert/strict";
import { LuaParseError, parseSavedVariables } from "../shared/luaTable";
import { savedRecord } from "../main/savedStatus";

// The shape the game writes (tabs, trailing commas, ["key"] keys).
const FILE = `
TrioDurumDB = {
\t["hide"] = true,
\t["mode"] = "whisper",
\t["seq"] = 12,
\t["last"] = {
\t\t["kind"] = "logout",
\t\t["line"] = "TRIO1;12;1800000000;Kahve Kokusu;;37;ROGUE;Orgrimmar;;beat",
\t\t["level"] = 37,
\t\t["name"] = "Kahve Kokusu",
\t\t["realm"] = "",
\t\t["sent"] = false,
\t\t["seq"] = 12,
\t\t["time"] = 1800000000,
\t\t["zone"] = "Orgrimmar",
\t\t["subzone"] = "",
\t\t["class"] = "ROGUE",
\t},
}
`;

test("the game's SavedVariables format parses", () => {
  const top = parseSavedVariables(FILE);
  const db = top.TrioDurumDB as Record<string, unknown>;
  assert.equal(db.mode, "whisper");
  assert.equal(db.seq, 12);
  assert.equal(db.hide, true);
});

test("strings: escapes, decimal escapes, UTF-8, quotes", () => {
  const top = parseSavedVariables(
    'X = { ["a"] = "say \\"hi\\"\\n", b = \'it\\\'s\', ["c"] = "\\196\\177", ["d"] = "Işıl Çağ", 5, -2.5e1, nil, }\n-- comment\nY = false',
  );
  const x = top.X as Record<string, unknown>;
  assert.equal(x.a, 'say "hi"\n');
  assert.equal(x.b, "it's");
  assert.equal(x.c, "ı");
  assert.equal(x.d, "Işıl Çağ");
  assert.equal(x["1"], 5);
  assert.equal(x["2"], -25);
  assert.equal(top.Y, false);
});

test("a BOM, CRLF and numeric keys", () => {
  const top = parseSavedVariables("\ufeffT = {\r\n [1] = \"a\",\r\n [2] = \"b\",\r\n}\r\n");
  assert.deepEqual(top.T, { "1": "a", "2": "b" });
});

test("anything that is not data is refused", () => {
  for (const bad of ["X = os.exit()", "X = {", 'X = "unterminated', "X = function() end", "= 1", "X = {[{}] = 1}"]) {
    assert.throws(() => parseSavedVariables(bad), LuaParseError, bad);
  }
});

test("nesting is bounded", () => {
  assert.throws(() => parseSavedVariables("X = " + "{".repeat(100) + "}".repeat(100)), LuaParseError);
});

test("the saved record: the line, with the saved kind (logout)", () => {
  const r = savedRecord(FILE);
  assert.equal(r?.name, "Kahve Kokusu");
  assert.equal(r?.level, 37);
  assert.equal(r?.kind, "logout");
  assert.equal(r?.realm, "");
});

test("the saved record falls back to the fields when the line is missing", () => {
  const r = savedRecord(FILE.replace(/\t\t\["line"\].*\n/, ""));
  assert.equal(r?.zone, "Orgrimmar");
  assert.equal(r?.seq, 12);
  assert.equal(r?.class, "ROGUE");
});

test("no TrioDurumDB, no last, garbage: null", () => {
  assert.equal(savedRecord("Other = {}"), null);
  assert.equal(savedRecord("TrioDurumDB = { mode = 'whisper' }"), null);
  assert.equal(savedRecord("not lua at all {"), null);
});
