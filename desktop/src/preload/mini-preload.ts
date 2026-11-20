/**
 * Preload of a mini player window (CONTRACT-V12-MINI-DESKTOP). Sandboxed, and
 * on purpose almost empty: the mini page is driven by its opener (the main
 * window's page, same origin), so it needs no IPC at all. It only learns that
 * it runs in the desktop shell (to draw its drag strip). Without this preload
 * Electron would hand the child its opener's preload, i.e. the whole
 * `window.trioDesktop` bridge.
 */
import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("trioMiniWindow", Object.freeze({ isDesktop: true }));
