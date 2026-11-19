import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GameConfigStore, GameService, diagnosticsText } from "../main/gameService";
import { autodetect, candidateRoots, flavoursIn } from "../main/wowFolder";
import type { GameStatus } from "../shared/gameStatus";

const T0 = 1_800_000_000;
const SECRET = "GİZLİ-SOHBET-9876";

function setup(processes: string[] | null = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trio-wow-"));
  const flavour = path.join(root, "World of Warcraft", "_forever_");
  fs.mkdirSync(path.join(flavour, "Logs"), { recursive: true });
  fs.mkdirSync(path.join(flavour, "WTF", "Account", "12345#1", "SavedVariables"), { recursive: true });
  fs.mkdirSync(path.join(flavour, "Interface", "AddOns"), { recursive: true });
  const userData = path.join(root, "userData");
  const clock = { ms: T0 * 1000 };
  const statuses: (GameStatus | null)[] = [];
  const list = { value: processes };
  const service = new GameService({
    config: new GameConfigStore(userData),
    listProcesses: async () => list.value,
    now: () => clock.ms,
    onStatus: (s) => statuses.push(s),
  });
  const log = path.join(flavour, "Logs", "WoWChatLog.txt");
  const sv = path.join(flavour, "WTF", "Account", "12345#1", "SavedVariables", "TrioDurum.lua");
  return { root, flavour, userData, clock, statuses, list, service, log, sv };
}

const line = (seq: number, time: number, zone = "Orgrimmar", kind = "beat") =>
  `TRIO1;${seq};${time};Kahve Kokusu;;37;ROGUE;${zone};;${kind}`;

test("flavour folders are found, Forever first", () => {
  const { root, flavour } = setup();
  fs.mkdirSync(path.join(root, "World of Warcraft", "_retail_", "WTF"), { recursive: true });
  fs.mkdirSync(path.join(root, "World of Warcraft", "_empty_"), { recursive: true });
  const found = flavoursIn(path.join(root, "World of Warcraft"));
  assert.deepEqual(found.map((f) => f.name), ["_forever_", "_retail_"]);
  assert.equal(found[0]?.hasAddOns, true);
  assert.deepEqual(flavoursIn(flavour).map((f) => f.name), ["_forever_"], "a flavour folder itself");
  assert.deepEqual(autodetect([path.join(root, "nope"), path.join(root, "World of Warcraft")]).length, 2);
  assert.ok(candidateRoots("win32", { "ProgramFiles(x86)": "C:\\Program Files (x86)" }, "C:\\Users\\a")[0]?.endsWith("World of Warcraft"));
  assert.ok(candidateRoots("darwin", {}, "/Users/a").includes("/Applications/World of Warcraft"));
});

test("the folder is remembered", () => {
  const { flavour, userData } = setup();
  const store = new GameConfigStore(userData);
  store.save({ wowFolder: flavour, customGames: [{ executable: "WowForever.exe", name: "WoW Forever" }] });
  assert.equal(new GameConfigStore(userData).load().wowFolder, flavour);
});

test("log + process: the merged status reaches the listener; other chat never does", async () => {
  const { service, log, flavour, statuses, clock, list } = setup(["explorer.exe", "WowForever.exe"]);
  const logged: unknown[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  console.log = console.warn = console.error = console.info = (...a: unknown[]) => void logged.push(a);
  try {
    service.addGame("WowForever.exe", "WoW Forever");
    service.setFolder(flavour);
    fs.writeFileSync(log, `11/19 21:00:00.000  [1. General] Ali: ${SECRET}\n`);
    await service.pollAll();
    assert.deepEqual(service.status, { game: "WoW Forever", since: T0 });
    clock.ms += 5000;
    fs.appendFileSync(log, `11/19 21:00:05.000  To Kahve Kokusu: ${line(1, T0 + 5)}\n`);
    fs.appendFileSync(log, `11/19 21:00:05.000  Kahve Kokusu whispers: ${line(1, T0 + 5)}\n`);
    fs.appendFileSync(log, `11/19 21:00:06.000  [Guild] Veli: ${SECRET} TRIO\n`);
    await service.pollLog();
    assert.equal(service.status?.detail?.zone, "Orgrimmar");
    assert.equal(service.status?.game, "WoW Forever");
    const diag = service.diagnostics();
    const text = diagnosticsText(diag, clock.ms, "0.0.0", "linux");
    for (const out of [JSON.stringify(statuses), JSON.stringify(diag), text, JSON.stringify(logged)]) {
      assert.ok(!out.includes(SECRET), "other chat leaked");
      assert.ok(!out.includes("General") && !out.includes("Veli"), "other chat leaked");
      assert.ok(!out.includes("12345#1"), "account folder name leaked");
      assert.ok(!out.includes("explorer"), "process list leaked");
    }
    assert.match(text, /Son TRIO1 satırı: TRIO1;1;/);
    // The game closes: the status goes away.
    list.value = ["explorer.exe"];
    clock.ms += 15000;
    await service.pollProcesses();
    assert.equal(service.status, null);
    assert.equal(statuses[statuses.length - 1], null);
  } finally {
    Object.assign(console, original);
  }
});

test("SavedVariables fallback: read when it changes, logout ends it", async () => {
  const { service, sv, flavour, clock } = setup(null);
  service.setFolder(flavour);
  const write = (kind: string, seq: number, time: number) =>
    fs.writeFileSync(
      sv,
      `TrioDurumDB = {\n\t["last"] = {\n\t\t["line"] = "${line(seq, time, "Durotar", kind)}",\n\t\t["kind"] = "${kind}",\n\t},\n}\n`,
    );
  write("beat", 3, T0);
  service.pollSaved();
  assert.equal(service.status?.detail?.source, "saved");
  assert.equal(service.status?.detail?.zone, "Durotar");
  clock.ms += 60_000;
  write("logout", 4, T0 + 60);
  const later = new Date(clock.ms + 5000);
  fs.utimesSync(sv, later, later);
  service.pollSaved();
  assert.equal(service.status, null);
  assert.equal(service.diagnostics().saved.found, true);
  assert.equal(service.diagnostics().saved.path, path.join("WTF", "Account", "<hesap>", "SavedVariables", "TrioDurum.lua"));
});

test("an unreadable process list is reported, not fatal", async () => {
  const { service } = setup(null);
  await service.pollProcesses();
  assert.equal(service.diagnostics().processes.readable, false);
  assert.equal(service.status, null);
});

test("running names for 'add': names only, system ones out", async () => {
  const { service } = setup(["C:\\Games\\WowForever.exe", "svchost.exe", "Discord.exe"]);
  assert.deepEqual(await service.runningNames(), ["Discord.exe", "WowForever.exe"]);
  assert.equal(service.addGame("WowForever.exe", ""), false);
  assert.equal(service.addGame("WowForever.exe", "WoW Forever"), true);
  service.removeGame("wowforever");
  assert.deepEqual(service.customGames, []);
});
