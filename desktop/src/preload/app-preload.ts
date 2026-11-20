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
 * CONTRACT-V10-UPDATE: `getUpdateState()`, `onUpdateState(cb) → unsubscribe`,
 * `checkForUpdates()`, `downloadUpdate()`, `installUpdate()`,
 * `setAutoUpdate(on)`.
 *
 * On the app's own connect page it exposes `window.trioConnect` instead. The
 * main process checks the sender's origin on every message regardless.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { MusicSupport, NowPlaying, PrepareResult, TrioDesktopMusicBridge, TrioDesktopUpdateBridge } from "../shared/bridge";
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
    ...update,
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
