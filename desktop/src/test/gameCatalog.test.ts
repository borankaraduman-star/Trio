import { test } from "node:test";
import assert from "node:assert/strict";
import { catalog, cleanGameName, matchProcess, normaliseExecutable, offerable } from "../shared/gameCatalog";

test("normalising: case, extension, Windows and POSIX paths, macOS bundles", () => {
  assert.equal(normaliseExecutable("Wow.exe"), "wow");
  assert.equal(normaliseExecutable("WOW.EXE"), "wow");
  assert.equal(normaliseExecutable("C:\\Program Files (x86)\\World of Warcraft\\_retail_\\Wow.exe"), "wow");
  assert.equal(
    normaliseExecutable("/Applications/World of Warcraft/_retail_/World of Warcraft.app/Contents/MacOS/World of Warcraft"),
    "world of warcraft",
  );
  assert.equal(normaliseExecutable("World of Warcraft Classic.app"), "world of warcraft classic");
  assert.equal(normaliseExecutable("/usr/bin/cs2"), "cs2");
  assert.equal(normaliseExecutable("  "), "");
});

test("the built-in table matches the known executables, nothing else", () => {
  const table = catalog([]);
  for (const exe of ["Wow.exe", "WowClassic.exe", "WowT.exe", "WowB.exe", "wow-64.exe"]) {
    const m = matchProcess(exe, table);
    assert.equal(m?.name, "World of Warcraft", exe);
    assert.equal(m?.wow, true);
  }
  assert.equal(matchProcess("/Applications/World of Warcraft/_classic_/World of Warcraft Classic.app/Contents/MacOS/World of Warcraft Classic", table)?.name, "World of Warcraft");
  assert.equal(matchProcess("cs2.exe", table)?.name, "Counter-Strike 2");
  assert.equal(matchProcess("VALORANT-Win64-Shipping.exe", table)?.name, "VALORANT");
  assert.equal(matchProcess("League of Legends.exe", table)?.name, "League of Legends");
  assert.equal(matchProcess("LeagueClient.exe", table), null, "the launcher is not the game");
  assert.equal(matchProcess("RocketLeague.exe", table)?.name, "Rocket League");
  assert.equal(matchProcess("dota2.exe", table)?.name, "Dota 2");
  assert.equal(matchProcess("GTA5.exe", table)?.name, "Grand Theft Auto V");
  assert.equal(matchProcess("chrome.exe", table), null);
  assert.equal(matchProcess("wowhead-helper.exe", table), null);
  assert.equal(matchProcess("Battle.net.exe", table), null);
});

test("a user-added game matches and wins over a built-in; WoW-ness is guessed from the names", () => {
  const table = catalog([
    { executable: "WowForever.exe", name: "WoW Forever" },
    { executable: "Wow.exe", name: "WoW (benim)" },
    { executable: "Factorio.exe", name: "Factorio" },
    { executable: "x.exe", name: "   " },
  ]);
  assert.deepEqual(
    { name: matchProcess("C:\\Games\\WowForever.exe", table)?.name, wow: matchProcess("wowforever.EXE", table)?.wow },
    { name: "WoW Forever", wow: true },
  );
  assert.equal(matchProcess("Wow.exe", table)?.name, "WoW (benim)");
  assert.equal(matchProcess("factorio", table)?.wow, false);
  assert.equal(matchProcess("x.exe", table), null, "an empty name is ignored");
});

test("display names: one line, 1–64", () => {
  assert.equal(cleanGameName(" WoW Forever "), "WoW Forever");
  assert.equal(cleanGameName("a\u202eb\n"), "ab");
  assert.equal(cleanGameName(""), null);
  assert.equal(cleanGameName("x".repeat(65)), null);
  assert.equal(cleanGameName(5), null);
});

test("offerable: names only, no paths, no duplicates, no system processes", () => {
  const out = offerable([
    "C:\\Games\\WowForever.exe", "WowForever.exe", "svchost.exe", "explorer.exe",
    "/Applications/Foo.app/Contents/MacOS/Foo", "Discord.exe",
  ]);
  assert.deepEqual(out, ["Discord.exe", "Foo.app", "WowForever.exe"]);
  assert.ok(out.every((n) => !n.includes("\\") && !n.includes("/")));
});
