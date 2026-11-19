/**
 * Types of the CONTRACT-V8-MUSIC §5 members of `window.trioDesktop` (all
 * optional on the page's side: an older desktop app has none of them).
 * Type-only: the sandboxed preload imports it with `import type`, which
 * compiles to nothing.
 */
import type { MusicSupport, PrepareResult } from "./musicCapture";
import type { NowPlaying } from "./nowPlaying";

export type { MusicSupport, PrepareResult, NowPlaying };

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
