/**
 * Trio desktop — the Electron main process.
 *
 * The window shows either the app's own "connect to server" page
 * (`trio-app://local/connect.html`) or the web client served by the friends'
 * server. Everything that crosses a trust boundary is checked here:
 * navigation (only the configured origin), new windows (system browser),
 * permissions (only the configured origin, only what voice/video needs), IPC
 * (sender frame's origin), and screen capture (an in-app picker).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  powerMonitor,
  protocol,
  session,
  shell,
  systemPreferences,
  Tray,
  type DesktopCapturerSource,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type Session,
} from "electron";
import { ConfigStore } from "./config";
import { checkHealth } from "./health";
import { PttController } from "./ptt";
import { badgeBitmap } from "./badge";
import { versionArgument, versionLabel } from "../shared/appVersion";
import { drawTrayMark, trayTooltip, trayVoiceState, type TrayVoiceState } from "./trayState";
import { GameConfigStore, GameService, diagnosticsText } from "./gameService";
import { listProcesses } from "./processList";
import { autodetect, flavoursIn, type Flavour } from "./wowFolder";
import { badgeText, parseUnread } from "../shared/title";
import {
  isExternalOpenable,
  isSameOrigin,
  LOCAL_ORIGIN,
  LOCAL_SCHEME,
  originOf,
  rejectionMessage,
  validateServerUrl,
} from "../shared/url";

// ---------------------------------------------------------------- constants

const STATIC_DIR = path.join(__dirname, "..", "static");
const CONNECT_URL = `${LOCAL_ORIGIN}/connect.html`;
const PICKER_URL = `${LOCAL_ORIGIN}/picker.html`;
const GAME_URL = `${LOCAL_ORIGIN}/game.html`;

/** Files the local scheme serves; anything else is a 404. */
const STATIC_FILES: Record<string, string> = {
  "connect.html": "text/html; charset=utf-8",
  "connect.js": "text/javascript; charset=utf-8",
  "picker.html": "text/html; charset=utf-8",
  "picker.js": "text/javascript; charset=utf-8",
  "game.html": "text/html; charset=utf-8",
  "game.js": "text/javascript; charset=utf-8",
  "local.css": "text/css; charset=utf-8",
  "icon.png": "image/png",
};

const LOCAL_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "connect-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'";

/**
 * Permissions granted to the configured origin. The contract lists the first
 * four; `fullscreen` (the stage's click-to-fullscreen), `speaker-selection`
 * (output device via setSinkId) and `clipboard-sanitized-write` (copy
 * buttons) are what the web client's own features need on top.
 */
const GRANTED_PERMISSIONS = new Set<string>([
  "media",
  "display-capture",
  "notifications",
  "fullscreen",
  "speaker-selection",
  "clipboard-sanitized-write",
]);

/** Windows can capture system audio; Electron supports loopback only there. */
const LOOPBACK_SUPPORTED = process.platform === "win32";

// ------------------------------------------------------------------- state

let mainWindow: BrowserWindow | null = null;
let pickerWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let config: ConfigStore;
/** The origin the window is allowed to be on; null while on the connect page. */
let serverOrigin: string | null = null;
/** Shown once on the connect page (e.g. after the stored server failed to load). */
let connectNotice: string | null = null;
let unread = 0;
// CONTRACT-V5: game status. Detection runs only while the page subscribes or
// the "Oyun durumu" window is open.
let gameService: GameService | null = null;
let gameWindow: BrowserWindow | null = null;
let pageWantsGame = false;
/** Folders the game window was shown and may pick from (nothing else is accepted). */
let offeredFolders = new Set<string>();

const ptt = new PttController(
  (down) => {
    const wc = mainWindow?.webContents;
    if (wc && !wc.isDestroyed() && isSameOrigin(wc.getURL(), serverOrigin)) {
      wc.send("trio:ptt", down);
    }
  },
  undefined,
  undefined,
  // CONTRACT-V6-VOICE §5: global mute/deafen keys, on the same hook.
  (action) => {
    const wc = mainWindow?.webContents;
    if (wc && !wc.isDestroyed() && isSameOrigin(wc.getURL(), serverOrigin)) {
      wc.send("trio:hotkey", action);
    }
  },
);
/** V6: the tray's own image, and the mute/deafen mark drawn on it. */
let trayBase: Electron.NativeImage | null = null;
let trayVoice: TrayVoiceState = "none";

// ------------------------------------------------------- before app ready

protocol.registerSchemesAsPrivileged([
  { scheme: LOCAL_SCHEME, privileges: { standard: true, secure: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showMainWindow());
  void app.whenReady().then(onReady);
}

// ------------------------------------------------------------------ setup

function onReady(): void {
  config = new ConfigStore(app.getPath("userData"));
  const ses = session.defaultSession;
  registerLocalProtocol(ses);
  installPermissionHandlers(ses);
  installDisplayMediaHandler(ses);
  installIpc();
  installGameStatus();
  buildAppMenu();
  createTray();
  createMainWindow();

  app.on("activate", () => showMainWindow());
}

app.on("before-quit", () => {
  quitting = true;
});

app.on("will-quit", () => {
  ptt.dispose();
  gameService?.stop();
});

app.on("window-all-closed", () => {
  // The window only closes for real when quitting; keep running in the tray.
  if (quitting) app.quit();
});

/** Every webContents (window, picker, devtools-opened pages) gets the guards. */
app.on("web-contents-created", (_event, contents) => {
  contents.on("will-attach-webview", (event) => event.preventDefault());

  contents.setWindowOpenHandler(({ url }) => {
    if (isExternalOpenable(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  contents.on("will-navigate", (event) => {
    if (contents === mainWindow?.webContents && isSameOrigin(event.url, serverOrigin)) return;
    event.preventDefault();
    if (isExternalOpenable(event.url) && originOf(event.url) !== serverOrigin) {
      void shell.openExternal(event.url);
    }
  });

  contents.on("will-redirect", (event) => {
    if (!event.isMainFrame) return;
    if (contents === mainWindow?.webContents && isSameOrigin(event.url, serverOrigin)) return;
    event.preventDefault();
  });
});

function registerLocalProtocol(ses: Session): void {
  ses.protocol.handle(LOCAL_SCHEME, async (request) => {
    const url = new URL(request.url);
    const name = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const type = STATIC_FILES[name];
    if (url.host !== "local" || type === undefined) {
      return new Response("Not found", { status: 404 });
    }
    try {
      const body = await fs.promises.readFile(path.join(STATIC_DIR, name));
      return new Response(body, {
        headers: {
          "content-type": type,
          "content-security-policy": LOCAL_CSP,
          "x-content-type-options": "nosniff",
          "cache-control": "no-store",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

function installPermissionHandlers(ses: Session): void {
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const allowed =
      GRANTED_PERMISSIONS.has(permission) &&
      wc === mainWindow?.webContents &&
      isSameOrigin(details.requestingUrl, serverOrigin);
    if (!allowed) {
      callback(false);
      return;
    }
    if (permission === "media" && process.platform === "darwin") {
      // Ask macOS (TCC) up front so the system prompt names Trio.
      const types = "mediaTypes" in details ? (details.mediaTypes ?? []) : [];
      void (async () => {
        let ok = true;
        if (types.includes("audio")) ok = (await systemPreferences.askForMediaAccess("microphone")) && ok;
        if (types.includes("video")) ok = (await systemPreferences.askForMediaAccess("camera")) && ok;
        callback(ok);
      })();
      return;
    }
    callback(true);
  });

  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
    if (!GRANTED_PERMISSIONS.has(permission)) return false;
    if (wc !== null && wc !== mainWindow?.webContents) return false;
    // Electron passes the origin with a trailing slash ("https://host/").
    return isSameOrigin(requestingOrigin, serverOrigin);
  });

  // No USB/HID/serial device access for anybody.
  ses.setDevicePermissionHandler(() => false);
}

// ------------------------------------------------------------ main window

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 420,
    minHeight: 420,
    show: false,
    title: "Trio",
    backgroundColor: "#111318",
    autoHideMenuBar: true,
    icon: process.platform === "linux" ? path.join(STATIC_DIR, "icon.png") : undefined,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "app-preload.js"),
      // CONTRACT-V6-VOICE: the sandboxed preload reads the app's version from argv.
      additionalArguments: versionArgument(app.getVersion()),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: true,
      // Voice keeps running while the window is hidden in the tray.
      backgroundThrottling: false,
    },
  });

  const wc = mainWindow.webContents;

  mainWindow.once("ready-to-show", () => mainWindow?.show());

  mainWindow.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.on("focus", () => mainWindow?.flashFrame(false));

  wc.on("did-start-navigation", (details) => {
    // A new document: the old page's PTT key is gone with it. The web client
    // sets it again when it loads.
    if (details.isMainFrame && !details.isSameDocument) {
      ptt.setKey(null);
      ptt.setHotkeys({});
      setTrayVoice("none");
      // The page subscribes again when it loads (CONTRACT-V5 §5).
      pageWantsGame = false;
      updateGameRunning();
    }
  });

  wc.on("page-title-updated", (_event, title) => updateUnread(parseUnread(title)));

  wc.on("did-fail-load", (_event, errorCode, _description, validatedURL, isMainFrame) => {
    // -3 is ERR_ABORTED (our own navigation guard, or a reload interrupting).
    if (!isMainFrame || errorCode === -3) return;
    if (!isSameOrigin(validatedURL, serverOrigin)) return;
    connectNotice = "Sunucuya bağlanılamadı. Adresi kontrol edip tekrar dene.";
    showConnectPage();
  });

  wc.on("render-process-gone", (_event, details) => {
    console.warn(`[trio] renderer gone: ${details.reason}`);
    if (details.reason !== "clean-exit") wc.reload();
  });

  const fromEnv = process.env.TRIO_SERVER_URL;
  const envCheck = fromEnv ? validateServerUrl(fromEnv) : null;
  if (envCheck && !envCheck.ok) {
    console.warn(`[trio] TRIO_SERVER_URL ignored: ${envCheck.reason}`);
  }
  const start = envCheck?.ok ? envCheck.origin : config.getServerOrigin();
  if (start) loadServer(start);
  else showConnectPage();
}

function loadServer(origin: string): void {
  if (!mainWindow) return;
  serverOrigin = origin;
  void mainWindow.loadURL(`${origin}/`).catch(() => {
    /* reported through did-fail-load */
  });
}

function showConnectPage(): void {
  if (!mainWindow) return;
  serverOrigin = null;
  updateUnread(0);
  void mainWindow.loadURL(CONNECT_URL);
  showMainWindow();
}

function showMainWindow(): void {
  if (!mainWindow) {
    createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// -------------------------------------------------------- unread / badge

function updateUnread(count: number): void {
  const previous = unread;
  unread = count;
  if (process.platform === "win32") {
    const text = badgeText(count);
    mainWindow?.setOverlayIcon(
      text ? nativeImage.createFromBitmap(badgeBitmap(text), { width: 16, height: 16 }) : null,
      text ? `${text} okunmamış mesaj` : "",
    );
  } else {
    // macOS dock; Linux launchers that support it (Unity/KDE).
    app.setBadgeCount(count);
  }
  tray?.setToolTip(trayTooltip(trayVoice, count > 0 ? `Trio — ${count} okunmamış` : "Trio"));
  if (count > previous && mainWindow && !mainWindow.isFocused()) {
    mainWindow.flashFrame(true);
  }
}

// ------------------------------------------------------------- tray/menu

function createTray(): void {
  // macOS: a black-and-alpha template image the menu bar recolours for light
  // and dark; elsewhere the light dots. nativeImage picks the @2x file beside
  // each on a HiDPI screen by itself.
  const mac = process.platform === "darwin";
  const image = nativeImage.createFromPath(path.join(STATIC_DIR, mac ? "trayTemplate.png" : "tray.png"));
  if (mac) image.setTemplateImage(true);
  trayBase = image;
  tray = new Tray(image);
  tray.setToolTip("Trio");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: versionLabel(app.getVersion()), enabled: false },
      { type: "separator" },
      { label: "Trio'yu göster", click: () => showMainWindow() },
      { label: "Oyun durumu…", click: () => showGameWindow() },
      { type: "separator" },
      { label: "Çıkış", click: () => quit() },
    ]),
  );
  tray.on("click", () => {
    if (mainWindow?.isVisible() && mainWindow.isFocused()) mainWindow.hide();
    else showMainWindow();
  });
}

/** V6: draw (or clear) the mute/deafen mark on the tray icon. */
function setTrayVoice(state: TrayVoiceState): void {
  if (state === trayVoice || !tray || !trayBase) return;
  trayVoice = state;
  tray.setToolTip(trayTooltip(state, unread > 0 ? `Trio — ${unread} okunmamış` : "Trio"));
  if (state === "none") {
    tray.setImage(trayBase);
    return;
  }
  let marked: Electron.NativeImage | null = null;
  for (const scaleFactor of trayBase.getScaleFactors()) {
    const bitmap = trayBase.toBitmap({ scaleFactor });
    const dip = trayBase.getSize(scaleFactor);
    let width = Math.round(dip.width * scaleFactor);
    let height = Math.round(dip.height * scaleFactor);
    if (width * height * 4 !== bitmap.length) {
      width = dip.width;
      height = dip.height;
    }
    if (width * height * 4 !== bitmap.length) continue;
    const drawn = drawTrayMark(bitmap, width, height, state);
    if (!marked) marked = nativeImage.createFromBitmap(drawn, { width, height, scaleFactor });
    else marked.addRepresentation({ scaleFactor, width, height, buffer: nativeImage.createFromBitmap(drawn, { width, height }).toPNG() });
  }
  // A coloured mark: not a template image (macOS would paint it one colour).
  if (marked) tray.setImage(marked);
}

function quit(): void {
  quitting = true;
  app.quit();
}

function buildAppMenu(): void {
  const isMac = process.platform === "darwin";
  const trioMenu: MenuItemConstructorOptions[] = [
    { label: versionLabel(app.getVersion()), enabled: false },
    { type: "separator" },
    { label: "Sunucuyu değiştir…", click: () => showConnectPage() },
    { label: "Oyun durumu…", click: () => showGameWindow() },
    { type: "separator" },
    {
      label: "Yeniden yükle",
      accelerator: "CmdOrCtrl+R",
      click: () => mainWindow?.webContents.reload(),
    },
    {
      label: "Geliştirici araçları",
      accelerator: isMac ? "Alt+Cmd+I" : "Ctrl+Shift+I",
      click: () => mainWindow?.webContents.toggleDevTools(),
    },
    { type: "separator" },
    ...(isMac
      ? ([{ role: "hide", label: "Trio'yu gizle" }, { type: "separator" }] as MenuItemConstructorOptions[])
      : []),
    { label: "Çıkış", accelerator: "CmdOrCtrl+Q", click: () => quit() },
  ];
  const template: MenuItemConstructorOptions[] = [
    { label: "Trio", submenu: trioMenu },
    {
      label: "Düzen",
      submenu: [
        { role: "undo", label: "Geri al" },
        { role: "redo", label: "Yinele" },
        { type: "separator" },
        { role: "cut", label: "Kes" },
        { role: "copy", label: "Kopyala" },
        { role: "paste", label: "Yapıştır" },
        { role: "selectAll", label: "Tümünü seç" },
      ],
    },
    {
      label: "Görünüm",
      submenu: [
        { role: "resetZoom", label: "Gerçek boyut" },
        { role: "zoomIn", label: "Yakınlaştır" },
        { role: "zoomOut", label: "Uzaklaştır" },
        { type: "separator" },
        { role: "togglefullscreen", label: "Tam ekran" },
      ],
    },
    {
      label: "Pencere",
      submenu: [
        { role: "minimize", label: "Küçült" },
        { label: "Kapat (tepsiye gizle)", accelerator: "CmdOrCtrl+W", click: () => mainWindow?.hide() },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// -------------------------------------------------------------------- IPC

/** The main window's top frame, currently on the configured server. */
function fromServerPage(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  return (
    mainWindow !== null &&
    event.sender === mainWindow.webContents &&
    frame !== null &&
    frame.parent === null &&
    isSameOrigin(frame.url, serverOrigin)
  );
}

/** The main window's top frame, on the local connect page. */
function fromConnectPage(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  return (
    mainWindow !== null &&
    event.sender === mainWindow.webContents &&
    frame !== null &&
    frame.parent === null &&
    isSameOrigin(frame.url, LOCAL_ORIGIN)
  );
}

/** The picker window's top frame. */
function fromPicker(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  const frame = event.senderFrame;
  return (
    pickerWindow !== null &&
    !pickerWindow.isDestroyed() &&
    event.sender === pickerWindow.webContents &&
    frame !== null &&
    frame.parent === null &&
    isSameOrigin(frame.url, LOCAL_ORIGIN)
  );
}

function installIpc(): void {
  ipcMain.on("trio:set-ptt-key", (event, code: unknown) => {
    if (!fromServerPage(event)) return;
    if (code === null) ptt.setKey(null);
    else if (typeof code === "string" && code.length > 0 && code.length <= 64) ptt.setKey(code);
  });

  // CONTRACT-V6-VOICE §5
  ipcMain.on("trio:set-hotkeys", (event, keys: unknown) => {
    if (!fromServerPage(event) || typeof keys !== "object" || keys === null) return;
    const pick = (value: unknown): string | null =>
      typeof value === "string" && value.length > 0 && value.length <= 64 ? value : null;
    const record = keys as Record<string, unknown>;
    ptt.setHotkeys({ mute: pick(record.mute), deafen: pick(record.deafen) });
  });
  ipcMain.on("trio:voice-state", (event, state: unknown) => {
    if (!fromServerPage(event) || typeof state !== "object" || state === null) return;
    const record = state as Record<string, unknown>;
    setTrayVoice(
      trayVoiceState({ inVoice: record.inVoice === true, muted: record.muted === true, deafened: record.deafened === true }),
    );
  });
  ipcMain.handle("trio:system-idle", (event) => (fromServerPage(event) ? powerMonitor.getSystemIdleTime() : null));

  ipcMain.handle("trio:connect-state", (event) => {
    if (!fromConnectPage(event)) return null;
    const notice = connectNotice;
    connectNotice = null;
    return { current: config.getServerOrigin(), notice, version: app.getVersion() };
  });

  ipcMain.handle("trio:connect-submit", async (event, input: unknown) => {
    if (!fromConnectPage(event)) return { ok: false, message: "İzin verilmedi." };
    if (typeof input !== "string" || input.length > 2048) {
      return { ok: false, message: rejectionMessage("malformed") };
    }
    const check = validateServerUrl(input);
    if (!check.ok) return { ok: false, message: rejectionMessage(check.reason) };
    const health = await checkHealth(check.origin, (url, init) =>
      net.fetch(url, { signal: init.signal, cache: "no-store", redirect: "error" }),
    );
    if (!health.ok) return health;
    config.setServerOrigin(check.origin);
    loadServer(check.origin);
    return { ok: true };
  });

  ipcMain.handle("trio:picker-sources", async (event) => {
    if (!fromPicker(event) || !pendingPick) return null;
    return await listSources();
  });

  ipcMain.on("trio:picker-choose", (event, id: unknown, withAudio: unknown) => {
    if (!fromPicker(event) || !pendingPick || typeof id !== "string") return;
    const source = pendingPick.sources.get(id);
    if (!source) return;
    finishPick({ source, audio: withAudio === true });
  });

  ipcMain.on("trio:picker-cancel", (event) => {
    if (!fromPicker(event)) return;
    finishPick(null);
  });
}

// ------------------------------------------------------ screen capture

interface PickResult {
  source: DesktopCapturerSource;
  audio: boolean;
}

interface PendingPick {
  audioRequested: boolean;
  sources: Map<string, DesktopCapturerSource>;
  resolve: (result: PickResult | null) => void;
}

let pendingPick: PendingPick | null = null;

function installDisplayMediaHandler(ses: Session): void {
  ses.setDisplayMediaRequestHandler((request, callback) => {
    const frameUrl = request.frame?.url ?? null;
    const allowed =
      mainWindow !== null &&
      serverOrigin !== null &&
      isSameOrigin(request.securityOrigin, serverOrigin) &&
      (frameUrl === null || isSameOrigin(frameUrl, serverOrigin)) &&
      request.videoRequested;
    if (!allowed || pendingPick) {
      callback(null);
      return;
    }
    void pickSource(request.audioRequested).then((result) => {
      if (!result) {
        callback(null);
        return;
      }
      if (result.audio && LOOPBACK_SUPPORTED) {
        callback({ video: result.source, audio: "loopback" });
      } else {
        callback({ video: result.source });
      }
    });
  });
}

function pickSource(audioRequested: boolean): Promise<PickResult | null> {
  return new Promise((resolve) => {
    pendingPick = { audioRequested, sources: new Map(), resolve };
    pickerWindow = new BrowserWindow({
      parent: mainWindow ?? undefined,
      modal: process.platform !== "linux",
      width: 820,
      height: 600,
      minWidth: 520,
      minHeight: 400,
      title: "Ekran paylaş",
      backgroundColor: "#111318",
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "..", "preload", "picker-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
      },
    });
    pickerWindow.setMenu(null);
    pickerWindow.once("ready-to-show", () => pickerWindow?.show());
    pickerWindow.on("closed", () => {
      pickerWindow = null;
      finishPick(null);
    });
    void pickerWindow.loadURL(PICKER_URL);
  });
}

function finishPick(result: PickResult | null): void {
  const pending = pendingPick;
  if (!pending) return;
  pendingPick = null;
  pending.resolve(result);
  if (pickerWindow && !pickerWindow.isDestroyed()) pickerWindow.close();
}

async function listSources(): Promise<unknown> {
  const pending = pendingPick;
  if (!pending) return null;
  let sources: DesktopCapturerSource[] = [];
  try {
    sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true,
    });
  } catch (error) {
    console.warn("[trio] desktopCapturer.getSources failed", error);
  }
  const ownIds = new Set(
    [mainWindow, pickerWindow]
      .filter((w): w is BrowserWindow => w !== null && !w.isDestroyed())
      .map((w) => w.getMediaSourceId()),
  );
  pending.sources = new Map();
  const list = sources
    .filter((s) => !ownIds.has(s.id))
    .map((s) => {
      pending.sources.set(s.id, s);
      return {
        id: s.id,
        name: s.name,
        kind: s.id.startsWith("screen:") ? "screen" : "window",
        thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
        icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
      };
    });
  return {
    sources: list,
    audio: pending.audioRequested && LOOPBACK_SUPPORTED,
    platform: process.platform,
  };
}

// ------------------------------------------------------------ game status

function sendGameStatus(): void {
  const wc = mainWindow?.webContents;
  if (!pageWantsGame || !gameService || !wc || wc.isDestroyed()) return;
  if (!isSameOrigin(wc.getURL(), serverOrigin)) return;
  wc.send("trio:game-status", gameService.status);
}

function updateGameRunning(): void {
  if (!gameService) return;
  const wanted = pageWantsGame || (gameWindow !== null && !gameWindow.isDestroyed());
  if (wanted) gameService.start();
  else gameService.stop();
}

/** The game window's top frame, on the local page. */
function fromGameWindow(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  return (
    gameWindow !== null &&
    !gameWindow.isDestroyed() &&
    event.sender === gameWindow.webContents &&
    frame !== null &&
    frame.parent === null &&
    isSameOrigin(frame.url, LOCAL_ORIGIN)
  );
}

function offer(flavours: Flavour[]): Flavour[] {
  for (const f of flavours) offeredFolders.add(f.path);
  return flavours;
}

function gameState(): unknown {
  if (!gameService) return null;
  return {
    folder: gameService.folder,
    flavours: gameService.folder ? offer(flavoursIn(gameService.folder)) : [],
    customGames: gameService.customGames,
    diagnostics: gameService.diagnostics(),
    now: Date.now(),
    platform: process.platform,
    pageListening: pageWantsGame,
  };
}

function installGameStatus(): void {
  gameService = new GameService({
    config: new GameConfigStore(app.getPath("userData")),
    listProcesses,
    onStatus: () => sendGameStatus(),
  });

  ipcMain.on("trio:game-subscribe", (event) => {
    if (!fromServerPage(event)) return;
    pageWantsGame = true;
    updateGameRunning();
    sendGameStatus();
  });
  ipcMain.on("trio:game-resend", (event) => {
    if (fromServerPage(event)) sendGameStatus();
  });
  ipcMain.on("trio:game-unsubscribe", (event) => {
    if (!fromServerPage(event)) return;
    pageWantsGame = false;
    updateGameRunning();
  });

  ipcMain.handle("trio:game-state", (event) => (fromGameWindow(event) ? gameState() : null));

  ipcMain.handle("trio:game-autodetect", (event) => {
    if (!fromGameWindow(event)) return null;
    return offer(autodetect());
  });

  ipcMain.handle("trio:game-choose-folder", async (event) => {
    if (!fromGameWindow(event) || !gameWindow) return null;
    const result = await dialog.showOpenDialog(gameWindow, {
      title: "World of Warcraft klasörünü seç",
      properties: ["openDirectory"],
    });
    const chosen = result.canceled ? undefined : result.filePaths[0];
    if (!chosen) return { flavours: [] };
    const flavours = offer(flavoursIn(chosen));
    if (flavours.length === 1) gameService?.setFolder((flavours[0] as Flavour).path);
    return { flavours };
  });

  ipcMain.handle("trio:game-use-folder", (event, folder: unknown) => {
    if (!fromGameWindow(event) || typeof folder !== "string" || !offeredFolders.has(folder)) return false;
    gameService?.setFolder(folder);
    return true;
  });

  ipcMain.handle("trio:game-running", async (event) => {
    if (!fromGameWindow(event) || !gameService) return [];
    return await gameService.runningNames();
  });

  ipcMain.handle("trio:game-add", (event, executable: unknown, name: unknown) => {
    if (!fromGameWindow(event) || typeof executable !== "string" || typeof name !== "string") return false;
    return gameService?.addGame(executable, name) ?? false;
  });

  ipcMain.handle("trio:game-remove", (event, executable: unknown) => {
    if (!fromGameWindow(event) || typeof executable !== "string") return false;
    gameService?.removeGame(executable);
    return true;
  });

  ipcMain.handle("trio:game-copy", (event) => {
    if (!fromGameWindow(event) || !gameService) return false;
    clipboard.writeText(diagnosticsText(gameService.diagnostics(), Date.now(), app.getVersion(), process.platform));
    return true;
  });
}

function showGameWindow(): void {
  if (gameWindow && !gameWindow.isDestroyed()) {
    gameWindow.show();
    gameWindow.focus();
    return;
  }
  offeredFolders = new Set();
  gameWindow = new BrowserWindow({
    width: 720,
    height: 760,
    minWidth: 480,
    minHeight: 480,
    title: "Oyun durumu",
    backgroundColor: "#111318",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "game-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  });
  gameWindow.setMenu(null);
  gameWindow.once("ready-to-show", () => gameWindow?.show());
  gameWindow.on("closed", () => {
    gameWindow = null;
    updateGameRunning();
  });
  updateGameRunning();
  void gameWindow.loadURL(GAME_URL);
}
