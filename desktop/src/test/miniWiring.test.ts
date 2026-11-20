import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MiniBoundsStore } from "../main/miniBounds";

const dist = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(dist, p), "utf8");

test("every V12 channel of the preload is origin-checked in main; the preload imports only electron", () => {
  const preload = read("preload/app-preload.js");
  const main = read("main/main.js");
  assert.deepEqual([...new Set([...preload.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]))], ["electron"]);
  for (const channel of [
    "trio:mini-options",
    "trio:mini-show",
    "trio:mini-hide",
    "trio:mini-close",
    "trio:mini-states",
    "trio:set-watch-hotkeys",
    "trio:window-state-get",
  ]) {
    assert.ok(preload.includes(JSON.stringify(channel)), `${channel} used by the preload`);
    const at = main.indexOf(JSON.stringify(channel));
    assert.ok(at > 0, `${channel} handled in main`);
    assert.ok(main.slice(at, at + 160).includes("fromServerPage(event)"), `${channel} checks the sender's origin`);
  }
  for (const pushed of ["trio:mini-state", "trio:watch-hotkey", "trio:window-state"]) {
    assert.ok(preload.includes(JSON.stringify(pushed)));
    assert.ok(main.includes(`sendToServerPage("${pushed}"`), `${pushed} goes only to the server page`);
  }
});

test("the mini page's preload is sandbox-safe and has no IPC at all", () => {
  const mini = read("preload/mini-preload.js");
  assert.deepEqual([...new Set([...mini.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]))], ["electron"]);
  assert.ok(!mini.includes("ipcRenderer"));
  assert.ok(mini.includes("trioMiniWindow"));
});

test("main: mini windows go with the page (navigation, close, crash) and the child opens nothing", () => {
  const main = read("main/main.js");
  const nav = main.slice(main.indexOf('wc.on("did-start-navigation"'), main.indexOf('wc.on("page-title-updated"'));
  assert.ok(nav.includes("closeAll()"));
  assert.ok(nav.includes("setWatchHotkeys({})"));
  const closed = main.slice(main.indexOf('mainWindow.on("closed"'), main.indexOf('mainWindow.on("closed"') + 200);
  assert.ok(closed.includes("closeAll()"));
  const gone = main.slice(main.indexOf('wc.on("render-process-gone"'), main.indexOf('wc.on("render-process-gone"') + 300);
  assert.ok(gone.includes("closeAll()"));
  assert.ok(main.includes('child.webContents.setWindowOpenHandler(() => ({ action: "deny" }))'));
  // The permission handler still grants only the main window.
  assert.ok(/wc === mainWindow\?\.webContents &&\s*\(0, url_1\.isSameOrigin\)\(details\.requestingUrl, serverOrigin\)/.test(main));
});

test("bounds store: remembers per class, ignores junk, keeps at most 16 classes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trio-mini-"));
  let t = 0;
  const store = new MiniBoundsStore(dir, () => ++t);
  assert.equal(store.get("screen"), null);
  store.set("screen", { bounds: { x: 1, y: 2, width: 400, height: 225 }, displayId: 7 });
  assert.deepEqual(new MiniBoundsStore(dir).get("screen"), { bounds: { x: 1, y: 2, width: 400, height: 225 }, displayId: 7 });
  for (let i = 0; i < 20; i++) store.set(`c${i}`, { bounds: { x: i, y: 0, width: 400, height: 225 }, displayId: 1 });
  const kept = JSON.parse(fs.readFileSync(path.join(dir, "trio-mini.json"), "utf8")) as Record<string, unknown>;
  assert.equal(Object.keys(kept).length, 16);
  assert.ok(!("screen" in kept), "the oldest went");
  fs.writeFileSync(path.join(dir, "trio-mini.json"), JSON.stringify({ x: { bounds: { x: "1" }, displayId: 1 }, "../y": { bounds: { x: 1, y: 1, width: 1, height: 1 }, displayId: 1 } }));
  const fresh = new MiniBoundsStore(dir);
  assert.equal(fresh.get("x"), null);
  assert.equal(fresh.get("../y"), null);
  fs.writeFileSync(path.join(dir, "trio-mini.json"), "not json");
  assert.equal(new MiniBoundsStore(dir).get("c1"), null);
});
