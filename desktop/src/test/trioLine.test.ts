import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeField, decodeTrioLine, isNewer } from "../shared/trioLine";

const LINE = "TRIO1;7;1800000000;Kahve Kokusu;;37;ROGUE;Orgrimmar;Valley of Strength;zone";

test("a chat-log line with the game's own prefix decodes", () => {
  const r = decodeTrioLine(`11/19 21:03:04.123  To Kahve Kokusu: ${LINE}\r`);
  assert.deepEqual(r, {
    seq: 7, time: 1800000000, name: "Kahve Kokusu", realm: "", level: 37, class: "ROGUE",
    zone: "Orgrimmar", subzone: "Valley of Strength", kind: "zone",
  });
});

test("percent-encoded fields and UTF-8 survive", () => {
  const r = decodeTrioLine("TRIO1;1;5;I%C5%9F%C4%B1l;Ar%3Bgent;1;MAGE;Kul Tiras%7C;Gölge'nin;login");
  assert.equal(r?.name, "Işıl");
  assert.equal(r?.realm, "Ar;gent");
  assert.equal(r?.zone, "Kul Tiras|");
  assert.equal(r?.subzone, "Gölge'nin");
});

test("malformed frames are refused", () => {
  for (const bad of [
    "TRIO1;1;5;Ali;;1;MAGE;z;s", // nine fields
    "TRIO1;1;5;Ali;;1;MAGE;z;s;login;extra",
    "TRIO1;x;5;Ali;;1;MAGE;z;s;login",
    "TRIO1;1;5;Ali;;1000;MAGE;z;s;login",
    "TRIO1;1;5;;;1;MAGE;z;s;login", // no name
    "TRIO1;1;5;Ali;;1;mage;z;s;login",
    "TRIO1;1;5;Ali;;1;MAGE;z;s;dance",
    "TRIO1;1;5;Al%ZZi;;1;MAGE;z;s;login",
    "TRIO2;1;5;Ali;;1;MAGE;z;s;login",
    "hello world",
  ]) {
    assert.equal(decodeTrioLine(bad), null, bad);
  }
});

test("control characters are dropped from fields", () => {
  assert.equal(decodeField("a%0Ab%00c"), "abc");
});

test("order: time, then sequence", () => {
  const a = decodeTrioLine(LINE)!;
  assert.equal(isNewer(a, null), true);
  assert.equal(isNewer({ ...a, seq: 8 }, a), true);
  assert.equal(isNewer({ ...a, seq: 6 }, a), false);
  assert.equal(isNewer({ ...a, seq: 1, time: a.time + 1 }, a), true);
  assert.equal(isNewer(a, a), false);
});
