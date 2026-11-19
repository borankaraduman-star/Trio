import { test } from "node:test";
import assert from "node:assert/strict";
import { ADDON_OFFLINE_AFTER_S, GameStatusModel, RECORD_MAX_AGE_S } from "../shared/gameStatus";
import { catalog, matchProcess, type GameEntry } from "../shared/gameCatalog";
import type { TrioRecord } from "../shared/trioLine";

const T0 = 1_800_000_000;
const table = catalog([{ executable: "WowForever.exe", name: "WoW Forever" }]);
const m = (exe: string): GameEntry => matchProcess(exe, table)!;

function setup() {
  const clock = { now: T0 };
  const model = new GameStatusModel(() => clock.now);
  return { clock, model };
}

function rec(over: Partial<TrioRecord> = {}): TrioRecord {
  return {
    seq: 1, time: T0, name: "Kahve Kokusu", realm: "", level: 37, class: "ROGUE",
    zone: "Orgrimmar", subzone: "", kind: "login", ...over,
  };
}

test("nothing running, nothing reported", () => {
  const { model } = setup();
  assert.equal(model.status(), null);
  model.setRunning([]);
  assert.equal(model.status(), null);
});

test("process layer alone: game and since (first seen), stable across polls", () => {
  const { clock, model } = setup();
  model.setRunning([m("cs2.exe")]);
  assert.deepEqual(model.status(), { game: "Counter-Strike 2", since: T0 });
  clock.now += 60;
  model.setRunning([m("cs2.exe"), m("cs2.exe")]);
  assert.deepEqual(model.status(), { game: "Counter-Strike 2", since: T0 });
  model.setRunning([]);
  assert.equal(model.status(), null);
  clock.now += 10;
  model.setRunning([m("cs2.exe")]);
  assert.deepEqual(model.status(), { game: "Counter-Strike 2", since: T0 + 70 }, "a new session, a new since");
});

test("a list that could not be read changes nothing", () => {
  const { model } = setup();
  model.setRunning([m("cs2.exe")]);
  model.setRunning(null);
  assert.equal(model.status()?.game, "Counter-Strike 2");
});

test("the addon enriches a running WoW with detail", () => {
  const { clock, model } = setup();
  model.setRunning([m("WowForever.exe")]);
  clock.now += 30;
  assert.equal(model.addRecord(rec({ time: T0 + 30 }), "log"), true);
  assert.deepEqual(model.status(), {
    game: "WoW Forever",
    since: T0,
    detail: { character: "Kahve Kokusu", realm: "", level: 37, class: "ROGUE", zone: "Orgrimmar", subzone: "", source: "log" },
  });
});

test("WoW is preferred over another game running at the same time", () => {
  const { clock, model } = setup();
  model.setRunning([m("cs2.exe")]);
  clock.now += 5;
  model.setRunning([m("cs2.exe"), m("Wow.exe")]);
  assert.equal(model.status()?.game, "World of Warcraft");
});

test("addon without a matched process (unknown executable): reported as World of Warcraft", () => {
  const { clock, model } = setup();
  clock.now += 5;
  model.addRecord(rec({ time: T0 }), "log");
  const s = model.status();
  assert.equal(s?.game, "World of Warcraft");
  assert.equal(s?.since, T0);
  assert.equal(s?.detail?.level, 37);
});

test("duplicates and older lines are ignored (the self-whisper is logged twice)", () => {
  const { model } = setup();
  assert.equal(model.addRecord(rec({ seq: 5 }), "log"), true);
  assert.equal(model.addRecord(rec({ seq: 5 }), "log"), false);
  assert.equal(model.addRecord(rec({ seq: 4, zone: "Old" }), "log"), false);
  assert.equal(model.status()?.detail?.zone, "Orgrimmar");
  assert.equal(model.addRecord(rec({ seq: 6, zone: "Durotar" }), "log"), true);
  assert.equal(model.status()?.detail?.zone, "Durotar");
});

test("lines older than the max age are history (start-up with an old log)", () => {
  const { clock, model } = setup();
  clock.now = T0 + RECORD_MAX_AGE_S + 1;
  assert.equal(model.addRecord(rec(), "log"), false);
  assert.equal(model.status(), null);
});

test("no heartbeat for 12 minutes: the detail goes, the process stays", () => {
  const { clock, model } = setup();
  model.setRunning([m("Wow.exe")]);
  model.addRecord(rec(), "log");
  clock.now = T0 + ADDON_OFFLINE_AFTER_S - 1;
  assert.ok(model.status()?.detail);
  clock.now = T0 + ADDON_OFFLINE_AFTER_S;
  assert.deepEqual(model.status(), { game: "World of Warcraft", since: T0 });
});

test("without a process, a quiet addon means nothing at all", () => {
  const { clock, model } = setup();
  model.addRecord(rec(), "log");
  clock.now = T0 + ADDON_OFFLINE_AFTER_S;
  assert.equal(model.status(), null);
});

test("an explicit logout line ends the detail at once", () => {
  const { clock, model } = setup();
  model.addRecord(rec({ seq: 1 }), "log");
  clock.now += 20;
  model.addRecord(rec({ seq: 2, time: T0 + 20, kind: "logout" }), "saved");
  assert.equal(model.status(), null);
});

test("the game process stopping ends the detail even before the timeout", () => {
  const { clock, model } = setup();
  model.setRunning([m("Wow.exe")]);
  model.addRecord(rec(), "log");
  clock.now += 15;
  model.setRunning([]);
  assert.equal(model.status(), null);
  // A newer line afterwards (an unknown client, e.g. a Forever executable not in the table) counts again.
  clock.now += 15;
  model.addRecord(rec({ seq: 2, time: clock.now }), "log");
  assert.equal(model.status()?.game, "World of Warcraft");
});

test("the saved source is reported as such", () => {
  const { model } = setup();
  model.addRecord(rec(), "saved");
  assert.equal(model.status()?.detail?.source, "saved");
});
