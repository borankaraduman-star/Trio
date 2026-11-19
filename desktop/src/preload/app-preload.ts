/**
 * Preload of the main window (sandboxed: only `electron`'s renderer modules
 * are available, so this file imports nothing else).
 *
 * On the friends' server it exposes exactly the bridge of CONTRACT-V2 §5:
 *
 *     window.trioDesktop = { isDesktop, setPttKey(code | null), onPtt(cb) → unsubscribe }
 *
 * plus CONTRACT-V5 §5 (game status): `gameStatus: {supported: true}` and
 * `onGameStatus(cb) → unsubscribe`; the first subscriber starts detection in
 * the main process, the last one leaving stops it.
 *
 * On the app's own connect page it exposes `window.trioConnect` instead. The
 * main process checks the sender's origin on every message regardless.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

const LOCAL_PROTOCOL = "trio-app:";

if (window.location.protocol === LOCAL_PROTOCOL) {
  contextBridge.exposeInMainWorld("trioConnect", {
    state: (): Promise<unknown> => ipcRenderer.invoke("trio:connect-state"),
    submit: (url: string): Promise<unknown> =>
      ipcRenderer.invoke("trio:connect-submit", String(url)),
  });
} else {
  let gameListeners = 0;
  contextBridge.exposeInMainWorld("trioDesktop", {
    isDesktop: true,
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
