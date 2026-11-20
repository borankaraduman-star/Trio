import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UpdateController, UpdateSettingsStore, type Timers, type UpdaterLike } from "../main/updater";
import {
  CHECK_INTERVAL_MS,
  CHECK_JITTER_MS,
  FIRST_CHECK_DELAY_MS,
  START_INSTALL_CHECK_DELAY_MS,
  START_INSTALL_WINDOW_MS,
  WAKE_MIN_GAP_MS,
  readyNotification,
  trayUpdateItem,
  trayUpdateTooltip,
  compareVersions,
  downloadPlatform,
  errorReason,
  isNewer,
  updateCapability,
  updateFilesAcceptable,
  type Capability,
  type UpdateState,
} from "../shared/update";

const SHA = "x".repeat(88);
const files = (version: string) => [{ url: `Trio-${version}-win-x64.exe`, sha512: SHA, size: 1 }];

// ------------------------------------------------------------- capability

test("capability matrix: Windows NSIS and AppImage update themselves; unsigned mac, dev, portable and plain Linux do not", () => {
  const base = { isPackaged: true, env: {}, hasUpdateConfig: true, macSigned: false };
  assert.deepEqual(updateCapability({ ...base, platform: "win32" }), { kind: "auto" });
  assert.deepEqual(updateCapability({ ...base, platform: "win32", env: { PORTABLE_EXECUTABLE_DIR: "C:\\x" } }), {
    kind: "manual",
    reason: "portable",
  });
  assert.deepEqual(updateCapability({ ...base, platform: "linux" }), { kind: "manual", reason: "not-appimage" });
  assert.deepEqual(updateCapability({ ...base, platform: "linux", env: { APPIMAGE: "/home/a/Trio.AppImage" } }), {
    kind: "auto",
  });
  assert.deepEqual(updateCapability({ ...base, platform: "darwin" }), { kind: "manual", reason: "unsigned-mac" });
  assert.deepEqual(updateCapability({ ...base, platform: "darwin", macSigned: true }), { kind: "auto" });
  assert.deepEqual(updateCapability({ ...base, platform: "win32", isPackaged: false }), { kind: "manual", reason: "dev" });
  assert.deepEqual(updateCapability({ ...base, platform: "win32", hasUpdateConfig: false }), {
    kind: "manual",
    reason: "no-config",
  });
  assert.deepEqual(updateCapability({ ...base, platform: "freebsd" }), { kind: "manual", reason: "unsupported" });
});

test("download platform words match /api/downloads", () => {
  assert.equal(downloadPlatform("win32", "x64"), "windows");
  assert.equal(downloadPlatform("darwin", "arm64"), "mac-arm64");
  assert.equal(downloadPlatform("darwin", "x64"), "mac-x64");
  assert.equal(downloadPlatform("linux", "x64"), "linux");
  assert.equal(downloadPlatform("aix", "ppc"), null);
});

// ------------------------------------------------------------- versions

test("versions: only strictly newer is an update", () => {
  assert.equal(isNewer("0.8.0", "0.7.1"), true);
  assert.equal(isNewer("0.7.1", "0.7.1"), false);
  assert.equal(isNewer("0.7.0", "0.7.1"), false);
  assert.equal(isNewer("0.8.0-rc.1", "0.8.0"), false);
  assert.equal(isNewer("0.8.0", "0.8.0-rc.2"), true);
  assert.equal(isNewer("garbage", "0.7.1"), false);
  assert.equal(compareVersions("0.8.0-rc.10", "0.8.0-rc.9")! > 0, true);
});

test("metadata must name plain files of the release with a sha512", () => {
  assert.equal(updateFilesAcceptable(files("0.8.0")), true);
  assert.equal(updateFilesAcceptable([{ url: "Trio-0.8.0-linux-x86_64.AppImage", sha512: SHA }]), true);
  assert.equal(updateFilesAcceptable([{ url: "Trio-0.8.0-mac-arm64.zip", sha512: SHA }]), true);
  assert.equal(updateFilesAcceptable([{ url: "https://evil.example/Trio-0.8.0-win-x64.exe", sha512: SHA }]), false);
  assert.equal(updateFilesAcceptable([{ url: "../Trio-0.8.0-win-x64.exe", sha512: SHA }]), false);
  assert.equal(updateFilesAcceptable([{ url: "Trio-0.8.0-win-x64.exe" }]), false);
  assert.equal(updateFilesAcceptable([]), false);
  assert.equal(updateFilesAcceptable(undefined), false);
});

test("errors become a short Turkish reason, never the raw message", () => {
  assert.equal(errorReason(new Error("getaddrinfo ENOTFOUND github.com")), "internet bağlantısı yok");
  assert.equal(errorReason({ code: "ERR_CHECKSUM_MISMATCH", message: "x" }), "indirilen dosya doğrulanamadı");
  assert.equal(errorReason({ code: "ERR_UPDATER_INVALID_SIGNATURE" }), "yeni sürümün imzası doğrulanamadı");
  assert.equal(errorReason({ code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" }), "sürüm bilgisi bulunamadı");
  assert.equal(errorReason(new Error("C:\\Users\\a\\secret path")), "beklenmeyen bir hata oluştu");
});

// ------------------------------------------------------------- the controller

class FakeTimers implements Timers {
  t = 0;
  private queue: { at: number; cb: () => void; id: number }[] = [];
  private next = 1;
  setTimeout(cb: () => void, ms: number): unknown {
    const id = this.next++;
    this.queue.push({ at: this.t + ms, cb, id });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.queue = this.queue.filter((e) => e.id !== handle);
  }
  now(): number {
    return this.t;
  }
  get pending(): number[] {
    return this.queue.map((e) => e.at - this.t);
  }
  /** Runs every timer due within `ms`, letting promises settle in between. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      this.queue.sort((a, b) => a.at - b.at);
      const first = this.queue[0];
      if (!first || first.at > end) break;
      this.queue.shift();
      this.t = first.at;
      first.cb();
      await flush();
    }
    this.t = end;
    await flush();
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

class FakeUpdater implements UpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  allowDowngrade = true;
  checks = 0;
  downloads = 0;
  installs: [boolean | undefined, boolean | undefined][] = [];
  latest: { version: string; files: unknown } | null = { version: "0.8.0", files: files("0.8.0") };
  checkError: unknown = null;
  downloadError: unknown = null;
  private progress: ((info: { percent?: number }) => void) | null = null;
  /** When set, checkForUpdates waits for it (to join a call mid-check). */
  checkGate: Promise<void> | null = null;
  on(event: string, listener: (arg: never) => void): unknown {
    if (event === "download-progress") this.progress = listener as (info: { percent?: number }) => void;
    return this;
  }
  async checkForUpdates() {
    this.checks++;
    if (this.checkGate) await this.checkGate;
    if (this.checkError) throw this.checkError;
    return this.latest ? { updateInfo: this.latest } : null;
  }
  async downloadUpdate(): Promise<unknown> {
    this.downloads++;
    this.progress?.({ percent: 40.6 });
    await flush();
    if (this.downloadError) throw this.downloadError;
    return [];
  }
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installs.push([isSilent, isForceRunAfter]);
  }
}

function memorySettings(initial = true, ready: string | null = null, tried: string | null = null) {
  let value = initial;
  let readyVersion = ready;
  let startInstallTried = tried;
  return {
    getAutoDownload: () => value,
    setAutoDownload: (on: boolean) => void (value = on),
    getReadyVersion: () => readyVersion,
    setReadyVersion: (v: string | null) => void (readyVersion = v),
    getStartInstallTried: () => startInstallTried,
    setStartInstallTried: (v: string) => void (startInstallTried = v),
    get value() {
      return value;
    },
    get ready() {
      return readyVersion;
    },
    get tried() {
      return startInstallTried;
    },
  };
}

function setup(
  opts: { capability?: Capability; auto?: boolean; current?: string; ready?: string; tried?: string; random?: number } = {},
) {
  const timers = new FakeTimers();
  const updater = new FakeUpdater();
  const states: UpdateState[] = [];
  const settings = memorySettings(opts.auto ?? true, opts.ready ?? null, opts.tried ?? null);
  let created = 0;
  let quitting = false;
  const controller = new UpdateController({
    capability: opts.capability ?? { kind: "auto" },
    currentVersion: opts.current ?? "0.7.1",
    platform: "windows",
    settings,
    createUpdater: () => {
      created++;
      return updater;
    },
    onState: (s) => states.push(s),
    beforeInstall: () => {
      quitting = true;
    },
    timers,
    random: () => opts.random ?? 0,
    log: { info: () => undefined, warn: () => undefined },
  });
  return { timers, updater, states, controller, settings, created: () => created, quitting: () => quitting };
}

const statuses = (states: UpdateState[]) => states.map((s) => s.status).filter((s, i, a) => s !== a[i - 1]);

test("checking → available → downloading → ready → installing, after a delay at start", async () => {
  const { timers, updater, states, controller, quitting } = setup();
  controller.start();
  assert.equal(updater.autoDownload, false, "electron-updater never downloads on its own");
  assert.equal(updater.autoInstallOnAppQuit, true);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.checks, 0);
  await timers.advance(FIRST_CHECK_DELAY_MS - 1);
  assert.equal(updater.checks, 0, "not right at start");
  await timers.advance(1);
  assert.equal(updater.checks, 1);
  assert.deepEqual(statuses(states), ["checking", "available", "downloading", "ready"]);
  assert.ok(states.some((s) => s.status === "downloading" && s.percent === 40), "progress is shown");
  assert.equal(controller.snapshot.version, "0.8.0");
  assert.deepEqual(controller.install(), { ok: true });
  assert.equal(controller.snapshot.status, "installing");
  assert.deepEqual(updater.installs, [[true, true]]);
  assert.equal(quitting(), true);
});

test("checks again about hourly, with jitter; up to date says so", async () => {
  const { timers, updater, controller } = setup({ random: 0.5 });
  updater.latest = { version: "0.7.1", files: files("0.7.1") };
  controller.start();
  await timers.advance(FIRST_CHECK_DELAY_MS);
  assert.equal(controller.snapshot.status, "up-to-date");
  assert.equal(controller.snapshot.checkedAt, FIRST_CHECK_DELAY_MS);
  const next = CHECK_INTERVAL_MS + CHECK_JITTER_MS / 2;
  assert.deepEqual(timers.pending, [next]);
  assert.ok(next >= 30 * 60 * 1000 && CHECK_INTERVAL_MS + CHECK_JITTER_MS <= 60 * 60 * 1000, "between half an hour and an hour");
  await timers.advance(next - 1);
  assert.equal(updater.checks, 1);
  await timers.advance(1);
  assert.equal(updater.checks, 2);
  // A release published meanwhile is found by the next periodic check.
  updater.latest = { version: "0.8.0", files: files("0.8.0") };
  await timers.advance(next);
  assert.equal(controller.snapshot.status, "ready");
});

test("a downgrade or the same version is refused, and never downloaded", async () => {
  const { updater, controller } = setup({ current: "0.9.0" });
  controller.start();
  updater.latest = { version: "0.8.0", files: files("0.8.0") };
  await controller.checkNow();
  assert.equal(controller.snapshot.status, "up-to-date");
  assert.equal(updater.downloads, 0);
  assert.deepEqual(controller.install(), { ok: false, reason: "not-ready" });
});

test("metadata pointing outside the release is refused", async () => {
  const { updater, controller } = setup();
  controller.start();
  updater.latest = { version: "0.8.0", files: [{ url: "https://elsewhere.example/x.exe", sha512: SHA }] };
  await controller.checkNow();
  assert.equal(controller.snapshot.status, "error");
  assert.equal(controller.snapshot.error, "sürüm bilgisi kabul edilmedi");
  assert.equal(updater.downloads, 0);
});

test("a check that fails is an error with a reason; the next check can succeed", async () => {
  const { updater, controller } = setup();
  controller.start();
  updater.checkError = new Error("net::ERR_INTERNET_DISCONNECTED");
  await controller.checkNow();
  assert.equal(controller.snapshot.status, "error");
  assert.equal(controller.snapshot.error, "internet bağlantısı yok");
  updater.checkError = null;
  await controller.checkNow();
  assert.equal(controller.snapshot.status, "ready");
});

test("a download whose hash does not match never becomes ready; it can be retried", async () => {
  const { updater, controller } = setup();
  controller.start();
  updater.downloadError = Object.assign(new Error("sha512 checksum mismatch"), { code: "ERR_CHECKSUM_MISMATCH" });
  await controller.checkNow();
  assert.equal(controller.snapshot.status, "error");
  assert.equal(controller.snapshot.error, "indirilen dosya doğrulanamadı");
  assert.deepEqual(controller.install(), { ok: false, reason: "not-ready" });
  assert.equal(updater.installs.length, 0);
  updater.downloadError = null;
  await controller.downloadNow();
  assert.equal(controller.snapshot.status, "ready");
});

test("in a voice room: the automatic check and the download run, the restart never does", async () => {
  const { timers, updater, controller, quitting } = setup();
  controller.start();
  controller.setInVoice(true);
  await timers.advance(FIRST_CHECK_DELAY_MS);
  assert.equal(updater.checks, 1, "checked during the call");
  assert.equal(updater.downloads, 1, "downloaded during the call");
  assert.equal(controller.snapshot.status, "ready");
  assert.equal(controller.snapshot.inVoice, true);
  assert.deepEqual(controller.install(), { ok: false, reason: "in-voice" });
  assert.equal(updater.installs.length, 0, "never restarts during a call");
  assert.equal(quitting(), false);
  await timers.advance(CHECK_INTERVAL_MS * 3);
  assert.equal(updater.installs.length, 0, "nor later, by itself");
  controller.setInVoice(false);
  assert.equal(updater.installs.length, 0, "leaving the call does not restart either");
  assert.deepEqual(controller.install(), { ok: true });
});

test("the page's \"look now\" during a call checks and downloads (what 0.8.0/0.9.0 shells did with checkNow too)", async () => {
  const { updater, controller } = setup();
  controller.start();
  controller.setInVoice(true);
  await controller.checkNow();
  assert.equal(updater.checks, 1);
  assert.equal(controller.snapshot.status, "ready");
  // Asked again while ready: nothing new is fetched.
  await controller.checkNow();
  assert.equal(updater.checks, 1);
});

test("a call that starts while a check is on its way: the found update still downloads", async () => {
  const { timers, updater, controller } = setup();
  controller.start();
  let open!: () => void;
  updater.checkGate = new Promise((resolve) => (open = resolve));
  await timers.advance(FIRST_CHECK_DELAY_MS);
  controller.setInVoice(true);
  open();
  await flush();
  await flush();
  assert.equal(updater.downloads, 1);
  assert.equal(controller.snapshot.status, "ready");
});

test("waking from sleep or showing the window checks when the last check is old enough", async () => {
  const { timers, updater, controller } = setup();
  updater.latest = { version: "0.7.1", files: files("0.7.1") };
  controller.start();
  controller.wake(); // nothing checked yet: look now
  await timers.advance(0);
  assert.equal(updater.checks, 1);
  await timers.advance(WAKE_MIN_GAP_MS - 1);
  controller.wake();
  await timers.advance(0);
  assert.equal(updater.checks, 1, "not twice within the gap");
  await timers.advance(1);
  controller.wake();
  await timers.advance(0);
  assert.equal(updater.checks, 2);
  // The periodic schedule continues from the wake-up.
  assert.equal(timers.pending.length, 1);
});

test("an update downloaded in an earlier run is installed by the next start, once, and not in a call", async () => {
  // Downloaded, never quit (Windows shut down): the next start finds it waiting.
  {
    const { timers, updater, controller, settings } = setup({ ready: "0.8.0" });
    controller.start();
    await timers.advance(START_INSTALL_CHECK_DELAY_MS);
    assert.equal(controller.snapshot.status, "installing");
    assert.deepEqual(updater.installs, [[true, true]]);
    assert.equal(settings.tried, "0.8.0", "tried once: a failing installer cannot loop the app");
  }
  // The same version was already tried by a start: no second attempt.
  {
    const { timers, updater, controller } = setup({ ready: "0.8.0", tried: "0.8.0" });
    controller.start();
    await timers.advance(FIRST_CHECK_DELAY_MS);
    assert.equal(controller.snapshot.status, "ready");
    assert.equal(updater.installs.length, 0);
  }
  // Back in the call (it survives a restart, V4): it waits for the user.
  {
    const { timers, updater, controller } = setup({ ready: "0.8.0" });
    controller.start();
    controller.setInVoice(true);
    await timers.advance(START_INSTALL_CHECK_DELAY_MS);
    assert.equal(controller.snapshot.status, "ready");
    assert.equal(updater.installs.length, 0);
  }
  // Ready only after the window (offline at start): no surprise restart later.
  {
    const { timers, updater, controller } = setup({ ready: "0.8.0" });
    updater.checkError = new Error("getaddrinfo ENOTFOUND github.com");
    controller.start();
    await timers.advance(START_INSTALL_WINDOW_MS + 1);
    updater.checkError = null;
    await controller.checkNow();
    assert.equal(controller.snapshot.status, "ready");
    assert.equal(updater.installs.length, 0);
  }
  // Already installed (by quitting): the record is cleared, the normal schedule runs.
  {
    const { timers, updater, controller, settings } = setup({ ready: "0.8.0", current: "0.8.0" });
    controller.start();
    assert.equal(settings.ready, null);
    await timers.advance(START_INSTALL_CHECK_DELAY_MS);
    assert.equal(updater.checks, 0);
  }
});

test("a download that becomes ready is remembered for the next start", async () => {
  const { updater, controller, settings } = setup();
  controller.start();
  await controller.checkNow();
  assert.equal(controller.snapshot.status, "ready");
  assert.equal(settings.ready, "0.8.0");
  assert.equal(updater.installs.length, 0, "a normal run never installs by itself");
});

test("tray line, tooltip and the notification follow the state", () => {
  const base: UpdateState = {
    capability: "auto",
    reason: null,
    platform: "windows",
    currentVersion: "0.9.0",
    autoDownload: true,
    status: "up-to-date",
    version: null,
    percent: null,
    error: null,
    checkedAt: 1,
    inVoice: false,
  };
  assert.equal(trayUpdateItem(base), null);
  assert.equal(trayUpdateTooltip(base), null);
  assert.equal(readyNotification(base), null);
  assert.deepEqual(trayUpdateItem({ ...base, status: "downloading", version: "0.9.1", percent: 47 }), {
    label: "Güncelleme indiriliyor: 0.9.1 (%40)",
    enabled: false,
    install: false,
  });
  const ready = { ...base, status: "ready" as const, version: "0.9.1", percent: 100 };
  assert.deepEqual(trayUpdateItem(ready), { label: "Yeniden başlat ve güncelle (0.9.1)", enabled: true, install: true });
  assert.deepEqual(trayUpdateItem({ ...ready, inVoice: true }), {
    label: "Güncelleme hazır: 0.9.1 (sesli odadan çıkınca)",
    enabled: false,
    install: false,
  });
  assert.equal(trayUpdateTooltip(ready), "Güncelleme hazır: 0.9.1");
  assert.equal(readyNotification(ready)?.title, "Trio güncellemesi hazır");
  assert.match(readyNotification({ ...ready, inVoice: true })?.body ?? "", /Sesli odadan çıkınca/);
  assert.equal(trayUpdateItem({ ...ready, capability: "manual" }), null);
});

test("automatic download off: available, the user downloads; switching it on downloads", async () => {
  const { updater, controller, settings } = setup({ auto: false });
  controller.start();
  await controller.checkNow();
  assert.equal(controller.snapshot.status, "available");
  assert.equal(controller.snapshot.autoDownload, false);
  assert.equal(updater.downloads, 0);
  controller.setAutoDownload(true);
  assert.equal(settings.value, true, "the switch is saved");
  await flush();
  assert.equal(controller.snapshot.status, "ready");
  assert.equal(updater.downloads, 1);
});

test("where self-update is impossible nothing is loaded or scheduled", async () => {
  const { timers, controller, created, states } = setup({ capability: { kind: "manual", reason: "unsigned-mac" } });
  controller.start();
  await timers.advance(CHECK_INTERVAL_MS * 2);
  assert.equal(created(), 0);
  assert.equal(states.length, 0);
  assert.equal(controller.snapshot.status, "manual");
  assert.equal(controller.snapshot.reason, "unsigned-mac");
  assert.deepEqual(controller.install(), { ok: false, reason: "manual" });
  assert.equal((await controller.checkNow()).status, "manual");
});

test("an updater that cannot be created falls back to the manual path", () => {
  const timers = new FakeTimers();
  const controller = new UpdateController({
    capability: { kind: "auto" },
    currentVersion: "0.7.1",
    platform: "linux",
    settings: memorySettings(),
    createUpdater: () => {
      throw new Error("no app-update.yml");
    },
    onState: () => undefined,
    beforeInstall: () => undefined,
    timers,
    log: { info: () => undefined, warn: () => undefined },
  });
  controller.start();
  assert.equal(controller.snapshot.status, "manual");
  assert.equal(controller.snapshot.reason, "no-config");
  assert.deepEqual(timers.pending, []);
});

test("the settings file keeps the switch (default on) and the waiting version", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trio-update-"));
  const store = new UpdateSettingsStore(dir);
  assert.equal(store.getAutoDownload(), true);
  assert.equal(store.getReadyVersion(), null);
  store.setAutoDownload(false);
  store.setReadyVersion("0.9.1");
  store.setStartInstallTried("0.9.1");
  const again = new UpdateSettingsStore(dir);
  assert.equal(again.getAutoDownload(), false);
  assert.equal(again.getReadyVersion(), "0.9.1");
  assert.equal(again.getStartInstallTried(), "0.9.1");
  // An older file (only the switch) still reads.
  fs.writeFileSync(path.join(dir, "trio-update.json"), JSON.stringify({ autoDownload: false }));
  assert.equal(store.getAutoDownload(), false);
  assert.equal(store.getReadyVersion(), null);
  fs.writeFileSync(path.join(dir, "trio-update.json"), "not json");
  assert.equal(store.getAutoDownload(), true);
});

test("bridge wiring: every update channel of the preload is origin-checked in main; the preload still imports only electron", () => {
  const preload = fs.readFileSync(path.join(__dirname, "..", "preload", "app-preload.js"), "utf8");
  const main = fs.readFileSync(path.join(__dirname, "..", "main", "main.js"), "utf8");
  const requires = [...preload.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(requires)], ["electron"]);
  for (const member of ["getUpdateState", "onUpdateState", "checkForUpdates", "downloadUpdate", "installUpdate", "setAutoUpdate"]) {
    assert.ok(preload.includes(`${member}(`), `${member} exposed`);
  }
  for (const channel of ["trio:update-state", "trio:update-check", "trio:update-download", "trio:update-install", "trio:update-auto"]) {
    assert.ok(preload.includes(JSON.stringify(channel)), `${channel} used by the preload`);
    const at = main.indexOf(JSON.stringify(channel));
    assert.ok(at > 0, `${channel} handled in main`);
    const handler = main.slice(at, at + 200);
    assert.ok(handler.includes("fromServerPage(event)"), `${channel} checks the sender's origin`);
  }
  // The feed is pinned in code to the public repository, without a token.
  assert.ok(/setFeedURL\(\{ provider: "github", owner: [^,]+, repo: [^,]+, private: false \}\)/.test(main));
});
