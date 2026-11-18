/**
 * Preload of the main window (sandboxed: only `electron`'s renderer modules
 * are available, so this file imports nothing else).
 *
 * On the friends' server it exposes exactly the bridge of CONTRACT-V2 §5:
 *
 *     window.trioDesktop = { isDesktop, setPttKey(code | null), onPtt(cb) → unsubscribe }
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
  });
}
