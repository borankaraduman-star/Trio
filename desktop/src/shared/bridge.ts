/**
 * Types of the CONTRACT-V8-MUSIC §5 members of `window.trioDesktop` (all
 * optional on the page's side: an older desktop app has none of them).
 * Type-only: the sandboxed preload imports it with `import type`, which
 * compiles to nothing.
 */
import type { MusicSupport, PrepareResult } from "./musicCapture";
import type { NowPlaying } from "./nowPlaying";
import type { ListeningState } from "./listening";
import type { UpdateState } from "./update";

export type { MusicSupport, PrepareResult, NowPlaying, ListeningState };

/** CONTRACT-V11-ACTIVITY §5: absent in apps built before it (the page then falls back to V8 only). */
export interface TrioDesktopListeningBridge {
  /** False on macOS/Linux: nothing can be read there. */
  listeningStatus: { supported: boolean };
  /** Start/stop the status watcher; `browsers` lets browsers and other apps through. */
  setListeningStatus(opts: { on: boolean; browsers: boolean }): void;
  /** Called with the current state at once, then on every change. */
  onListening(cb: (state: ListeningState) => void): () => void;
}

export interface TrioDesktopMusicBridge {
  /** Whether system sound without Trio's own output is possible here; no side effect. */
  musicCaptureSupport(): Promise<MusicSupport | null>;
  /** Arms the next getDisplayMedia (within 15 s) as a music share; see the contract. */
  prepareMusicCapture(): Promise<PrepareResult | null>;
  /** Start/stop reading what is playing. Off: nothing is read or sent. */
  setNowPlayingWatch(on: boolean): void;
  /** Called on every change while the watch is on. */
  onNowPlaying(cb: (info: NowPlaying | null) => void): () => void;
}

/** CONTRACT-V10-UPDATE §3: absent in apps built before it (the page then shows the manual notice). */
export interface TrioDesktopUpdateBridge {
  getUpdateState(): Promise<UpdateState | null>;
  onUpdateState(cb: (state: UpdateState) => void): () => void;
  checkForUpdates(): Promise<UpdateState | null>;
  /** Only with status "available" (automatic download off) or after a failed download. */
  downloadUpdate(): Promise<UpdateState | null>;
  /** Restarts into the ready update; refused (`in-voice`) while the page is in a voice room. */
  installUpdate(): Promise<{ ok: boolean; reason?: string }>;
  setAutoUpdate(on: boolean): void;
}

/**
 * CONTRACT-V12-MINI-DESKTOP §2: the mini player windows, the watching keys and
 * the main window's state. Absent in apps built before it.
 */
export type WatchHotkeyAction =
  | "toggleMini"
  | "nextShare"
  | "clickThrough"
  | "muteShare"
  | "shareVolumeUp"
  | "shareVolumeDown"
  | "theatre";

export interface MiniWindowState {
  id: string;
  visible: boolean;
  clickThrough: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  /** Present (true) once, when the window has closed (addition to the seam). */
  closed?: true;
}

export interface TrioDesktopMiniBridge {
  mini: {
    supported: true;
    setOptions(
      id: string,
      options: { opacity?: number; clickThrough?: boolean; alwaysOnTop?: boolean; aspect?: number; contentProtection?: boolean },
    ): void;
    show(id: string): void;
    hide(id: string): void;
    close(id: string): void;
    /** Called with every open window's state at once, then on each change. */
    onState(cb: (state: MiniWindowState) => void): () => void;
  };
  setWatchHotkeys(keys: Partial<Record<WatchHotkeyAction, string | null>>): void;
  onWatchHotkey(cb: (action: WatchHotkeyAction) => void): () => void;
  onWindowState(cb: (state: { focused: boolean; minimized: boolean; hiddenToTray: boolean; fullscreenAppInFront?: boolean }) => void): () => void;
}
