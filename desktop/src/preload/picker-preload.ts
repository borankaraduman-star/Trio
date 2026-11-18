/** Preload of the screen-source picker window (sandboxed). */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("trioPicker", {
  sources: (): Promise<unknown> => ipcRenderer.invoke("trio:picker-sources"),
  choose(id: string, withAudio: boolean): void {
    ipcRenderer.send("trio:picker-choose", String(id), withAudio === true);
  },
  cancel(): void {
    ipcRenderer.send("trio:picker-cancel");
  },
});
