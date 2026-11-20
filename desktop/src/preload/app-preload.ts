/**
 * Preload of the main window (sandboxed: only `electron`'s renderer modules
 * are available, so this file imports nothing else).
 *
 * On the friends' server it exposes exactly the bridge of CONTRACT-V2 §5:
 *
 *     window.trioDesktop = { isDesktop, setPttKey(code | null), onPtt(cb) → unsubscribe }
 *
 * plus CONTRACT-V6-VOICE §5 (`setHotkeys`, `onHotkey`, `setVoiceState`,
 * `getSystemIdleTime`) and CONTRACT-V5 §5 (game status): `gameStatus: {supported: true}` and
 * `onGameStatus(cb) → unsubscribe`; the first subscriber starts detection in
 * the main process, the last one leaving stops it.
 *
 * CONTRACT-V8-MUSIC §5: `musicCaptureSupport()`, `prepareMusicCapture()`,
 * `setNowPlayingWatch(on)` and `onNowPlaying(cb) → unsubscribe`.
 *
 * CONTRACT-V11-ACTIVITY §5: `listeningStatus: {supported}`,
 * `setListeningStatus({on, browsers})` and `onListening(cb) → unsubscribe`
 * (the current state at once, then each change).
 *
 * CONTRACT-V10-UPDATE: `getUpdateState()`, `onUpdateState(cb) → unsubscribe`,
 * `checkForUpdates()`, `downloadUpdate()`, `installUpdate()`,
 * `setAutoUpdate(on)`.
 *
 * CONTRACT-V12-MINI-DESKTOP: `mini: {supported, setOptions, show, hide, close,
 * onState}`, `setWatchHotkeys(keys)`, `onWatchHotkey(cb)`, `onWindowState(cb)`.
 *
 * On the app's own connect page it exposes `window.trioConnect` instead. The
 * main process checks the sender's origin on every message regardless.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  ListeningState,
  MusicSupport,
  NowPlaying,
  PrepareResult,
  MiniWindowState,
  TrioDesktopListeningBridge,
  TrioDesktopMiniBridge,
  TrioDesktopMusicBridge,
  TrioDesktopUpdateBridge,
} from "../shared/bridge";
import type { UpdateState } from "../shared/update";

const LOCAL_PROTOCOL = "trio-app:";

/**
 * CONTRACT-V6-VOICE: the app's version, put on argv by the main process
 * (`additionalArguments`). Same prefix and check as shared/appVersion.ts
 * (a sandboxed preload imports nothing but electron; a test compares them).
 */
const VERSION_ARG_PREFIX = "--trio-app-version=";
function appVersionFromArgv(): string | null {
  for (const arg of process.argv) {
    if (typeof arg !== "string" || !arg.startsWith(VERSION_ARG_PREFIX)) continue;
    const value = arg.slice(VERSION_ARG_PREFIX.length);
    return /^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}(?:[-+][0-9A-Za-z.-]{1,24})?$/.test(value) ? value : null;
  }
  return null;
}
const APP_VERSION = appVersionFromArgv();

if (window.location.protocol === LOCAL_PROTOCOL) {
  contextBridge.exposeInMainWorld("trioConnect", {
    state: (): Promise<unknown> => ipcRenderer.invoke("trio:connect-state"),
    submit: (url: string): Promise<unknown> =>
      ipcRenderer.invoke("trio:connect-submit", String(url)),
    // CONTRACT-V11-ADDRESS §8: go to the remembered next address.
    useNext: (): Promise<unknown> => ipcRenderer.invoke("trio:connect-next"),
  });
} else {
  let gameListeners = 0;
  // CONTRACT-V8-MUSIC §5: sharing the computer's sound without Trio's own.
  const music: TrioDesktopMusicBridge = {
    musicCaptureSupport(): Promise<MusicSupport | null> {
      return ipcRenderer.invoke("trio:music-support") as Promise<MusicSupport | null>;
    },
    prepareMusicCapture(): Promise<PrepareResult | null> {
      return ipcRenderer.invoke("trio:music-prepare") as Promise<PrepareResult | null>;
    },
    setNowPlayingWatch(on: boolean): void {
      ipcRenderer.send("trio:now-playing-watch", on === true);
    },
    onNowPlaying(cb: (info: NowPlaying | null) => void): () => void {
      if (typeof cb !== "function") return () => undefined;
      const listener = (_event: IpcRendererEvent, info: unknown): void => {
        cb((info as NowPlaying | null) ?? null);
      };
      ipcRenderer.on("trio:now-playing", listener);
      return () => {
        ipcRenderer.removeListener("trio:now-playing", listener);
      };
    },
  };
  // CONTRACT-V11-ACTIVITY §5: "ne dinliyor" as a status (Windows only).
  const listening: TrioDesktopListeningBridge = {
    listeningStatus: { supported: process.platform === "win32" },
    setListeningStatus(opts: { on: boolean; browsers: boolean }): void {
      const record = typeof opts === "object" && opts !== null ? opts : { on: false, browsers: false };
      ipcRenderer.send("trio:listening-status", { on: record.on === true, browsers: record.browsers === true });
    },
    onListening(cb: (state: ListeningState) => void): () => void {
      if (typeof cb !== "function") return () => undefined;
      let active = true;
      const listener = (_event: IpcRendererEvent, state: unknown): void => {
        if (active && state && typeof state === "object") cb(state as ListeningState);
      };
      ipcRenderer.on("trio:listening", listener);
      void (ipcRenderer.invoke("trio:listening-state") as Promise<ListeningState | null>).then((state) => {
        if (active && state && typeof state === "object") cb(state);
      });
      return () => {
        active = false;
        ipcRenderer.removeListener("trio:listening", listener);
      };
    },
  };
  // CONTRACT-V10-UPDATE: the shell's own update cycle; the page only asks and shows.
  const update: TrioDesktopUpdateBridge = {
    getUpdateState(): Promise<UpdateState | null> {
      return ipcRenderer.invoke("trio:update-state") as Promise<UpdateState | null>;
    },
    onUpdateState(cb: (state: UpdateState) => void): () => void {
      if (typeof cb !== "function") return () => undefined;
      const listener = (_event: IpcRendererEvent, state: unknown): void => {
        if (state && typeof state === "object") cb(state as UpdateState);
      };
      ipcRenderer.on("trio:update-changed", listener);
      return () => {
        ipcRenderer.removeListener("trio:update-changed", listener);
      };
    },
    checkForUpdates(): Promise<UpdateState | null> {
      return ipcRenderer.invoke("trio:update-check") as Promise<UpdateState | null>;
    },
    downloadUpdate(): Promise<UpdateState | null> {
      return ipcRenderer.invoke("trio:update-download") as Promise<UpdateState | null>;
    },
    installUpdate(): Promise<{ ok: boolean; reason?: string }> {
      return ipcRenderer.invoke("trio:update-install") as Promise<{ ok: boolean; reason?: string }>;
    },
    setAutoUpdate(on: boolean): void {
      ipcRenderer.send("trio:update-auto", on === true);
    },
  };
  // CONTRACT-V12-MINI-DESKTOP: watching a share from inside a game.
  const WATCH = ["toggleMini", "nextShare", "clickThrough", "muteShare", "shareVolumeUp", "shareVolumeDown", "theatre"] as const;
  type WatchName = (typeof WATCH)[number];
  const isWatch = (value: unknown): value is WatchName => typeof value === "string" && (WATCH as readonly string[]).includes(value);
  const miniId = (id: unknown): string | null => (typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null);
  const watching: TrioDesktopMiniBridge = {
    mini: {
      supported: true,
      setOptions(id: string, options: Record<string, unknown>): void {
        const key = miniId(id);
        const record = typeof options === "object" && options !== null ? options : {};
        const out: Record<string, number | boolean> = {};
        if (typeof record.opacity === "number") out.opacity = record.opacity;
        if (typeof record.aspect === "number") out.aspect = record.aspect;
        for (const flag of ["clickThrough", "alwaysOnTop", "contentProtection"]) {
          if (typeof record[flag] === "boolean") out[flag] = record[flag] as boolean;
        }
        if (key) ipcRenderer.send("trio:mini-options", key, out);
      },
      show(id: string): void {
        const key = miniId(id);
        if (key) ipcRenderer.send("trio:mini-show", key);
      },
      hide(id: string): void {
        const key = miniId(id);
        if (key) ipcRenderer.send("trio:mini-hide", key);
      },
      close(id: string): void {
        const key = miniId(id);
        if (key) ipcRenderer.send("trio:mini-close", key);
      },
      onState(cb: (state: MiniWindowState) => void): () => void {
        if (typeof cb !== "function") return () => undefined;
        let active = true;
        const listener = (_event: IpcRendererEvent, state: unknown): void => {
          if (active && state && typeof state === "object") cb(state as MiniWindowState);
        };
        ipcRenderer.on("trio:mini-state", listener);
        void (ipcRenderer.invoke("trio:mini-states") as Promise<MiniWindowState[] | null>).then((states) => {
          if (active && Array.isArray(states)) for (const state of states) cb(state);
        });
        return () => {
          active = false;
          ipcRenderer.removeListener("trio:mini-state", listener);
        };
      },
    },
    setWatchHotkeys(keys: Partial<Record<WatchName, string | null>>): void {
      const record = (typeof keys === "object" && keys !== null ? keys : {}) as Record<string, unknown>;
      const out: Record<string, string | null> = {};
      for (const action of WATCH) {
        const value = record[action];
        out[action] = typeof value === "string" ? value : null;
      }
      ipcRenderer.send("trio:set-watch-hotkeys", out);
    },
    onWatchHotkey(cb: (action: WatchName) => void): () => void {
      if (typeof cb !== "function") return () => undefined;
      const listener = (_event: IpcRendererEvent, action: unknown): void => {
        if (isWatch(action)) cb(action);
      };
      ipcRenderer.on("trio:watch-hotkey", listener);
      return () => {
        ipcRenderer.removeListener("trio:watch-hotkey", listener);
      };
    },
    onWindowState(cb): () => void {
      if (typeof cb !== "function") return () => undefined;
      let active = true;
      const deliver = (state: unknown): void => {
        if (!active || !state || typeof state !== "object") return;
        const s = state as Record<string, unknown>;
        cb({ focused: s.focused === true, minimized: s.minimized === true, hiddenToTray: s.hiddenToTray === true });
      };
      const listener = (_event: IpcRendererEvent, state: unknown): void => deliver(state);
      ipcRenderer.on("trio:window-state", listener);
      void (ipcRenderer.invoke("trio:window-state-get") as Promise<unknown>).then(deliver);
      return () => {
        active = false;
        ipcRenderer.removeListener("trio:window-state", listener);
      };
    },
  };
  contextBridge.exposeInMainWorld("trioDesktop", {
    isDesktop: true,
    // CONTRACT-V6-VOICE "Desktop version": absent (undefined) only if argv lacked it.
    ...(APP_VERSION ? { appVersion: APP_VERSION } : {}),
    setPttKey(code: string | null): void {
      ipcRenderer.send("trio:set-ptt-key", typeof code === "string" ? code : null);
    },
    onPtt(cb: (down: boolean) => void): () => void {
      if (typeof cb !== "function") return () => undefined;
      const listener = (_event: IpcRendererEvent, down: unknown): void => {
        cb(down === true);
      };
      ipcRenderer.on("trio:ptt", listener);
      return () => {
        ipcRenderer.removeListener("trio:ptt", listener);
      };
    },
    // CONTRACT-V6-VOICE §5: global mute/deafen keys, the tray's mute mark, system idle time.
    setHotkeys(keys: { mute?: string | null; deafen?: string | null }): void {
      const pick = (value: unknown): string | null => (typeof value === "string" ? value : null);
      const record = typeof keys === "object" && keys !== null ? keys : {};
      ipcRenderer.send("trio:set-hotkeys", { mute: pick(record.mute), deafen: pick(record.deafen) });
    },
    onHotkey(cb: (action: "mute" | "deafen") => void): () => void {
      if (typeof cb !== "function") return () => undefined;
      const listener = (_event: IpcRendererEvent, action: unknown): void => {
        if (action === "mute" || action === "deafen") cb(action);
      };
      ipcRenderer.on("trio:hotkey", listener);
      return () => {
        ipcRenderer.removeListener("trio:hotkey", listener);
      };
    },
    setVoiceState(state: { inVoice?: boolean; muted?: boolean; deafened?: boolean }): void {
      const record = typeof state === "object" && state !== null ? state : {};
      ipcRenderer.send("trio:voice-state", {
        inVoice: record.inVoice === true,
        muted: record.muted === true,
        deafened: record.deafened === true,
      });
    },
    getSystemIdleTime(): Promise<number | null> {
      return ipcRenderer.invoke("trio:system-idle") as Promise<number | null>;
    },
    ...music,
    ...listening,
    ...update,
    ...watching,
    // CONTRACT-V11-ADDRESS §5, §8: the main process checks every address with the trusted server.
    moveServer(request: { origin: string; code: string }): Promise<unknown> {
      const record = typeof request === "object" && request !== null ? request : { origin: "", code: "" };
      return ipcRenderer.invoke("trio:move-server", { origin: String(record.origin), code: String(record.code) });
    },
    storeNextMove(request: { origin: string; code: string; expiresAt: string }): Promise<unknown> {
      const record = typeof request === "object" && request !== null ? request : { origin: "", code: "", expiresAt: "" };
      return ipcRenderer.invoke("trio:store-next-move", {
        origin: String(record.origin),
        code: String(record.code),
        expiresAt: String(record.expiresAt),
      });
    },
    gameStatus: { supported: true },
    onGameStatus(cb: (status: unknown) => void): () => void {
      if (typeof cb !== "function") return () => undefined;
      const listener = (_event: IpcRendererEvent, status: unknown): void => {
        cb(status ?? null);
      };
      ipcRenderer.on("trio:game-status", listener);
      gameListeners++;
      if (gameListeners === 1) ipcRenderer.send("trio:game-subscribe");
      else ipcRenderer.send("trio:game-resend");
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        ipcRenderer.removeListener("trio:game-status", listener);
        gameListeners--;
        if (gameListeners === 0) ipcRenderer.send("trio:game-unsubscribe");
      };
    },
  });
}
