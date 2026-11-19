/** Preload of the "Oyun durumu" window (sandboxed, local page only). */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("trioGame", {
  state: (): Promise<unknown> => ipcRenderer.invoke("trio:game-state"),
  chooseFolder: (): Promise<unknown> => ipcRenderer.invoke("trio:game-choose-folder"),
  useFolder: (folder: string): Promise<unknown> => ipcRenderer.invoke("trio:game-use-folder", String(folder)),
  autodetect: (): Promise<unknown> => ipcRenderer.invoke("trio:game-autodetect"),
  running: (): Promise<unknown> => ipcRenderer.invoke("trio:game-running"),
  addGame: (executable: string, name: string): Promise<unknown> =>
    ipcRenderer.invoke("trio:game-add", String(executable), String(name)),
  removeGame: (executable: string): Promise<unknown> => ipcRenderer.invoke("trio:game-remove", String(executable)),
  copy: (): Promise<unknown> => ipcRenderer.invoke("trio:game-copy"),
});
