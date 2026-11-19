/**
 * The answer to one getDisplayMedia request, given the decision of
 * `MusicCaptureArm.decide` (shared/musicCapture.ts). No Electron import: the
 * capture source type is generic, main.ts passes desktopCapturer's.
 *
 * Screen sharing (decision "picker") is exactly what it was before V8: the
 * in-app picker, and `audio: "loopback"` only when the person ticked system
 * sound and the platform has loopback (Windows).
 *
 * A music share (decision "music") is any screen as the video (Chromium does
 * not grant audio-only display capture; the page stops that track at once)
 * and `audio: "loopback"` — plain loopback, NEVER "loopbackWithMute": only
 * plain loopback is turned into "loopbackWithoutChrome" by Electron when the
 * page asked for `restrictOwnAudio`, and the mute variant would silence the
 * sharer's own speakers.
 */
import type { DisplayMediaDecision } from "../shared/musicCapture";

export interface Pick<S> {
  source: S;
  audio: boolean;
}

export interface DisplayMediaDeps<S> {
  pickSource(audioRequested: boolean): Promise<Pick<S> | null>;
  primaryScreen(): Promise<S | null>;
  loopbackSupported: boolean;
}

export type DisplayMediaAnswer<S> = { video: S; audio?: "loopback" } | null;

export async function answerDisplayMedia<S>(
  decision: DisplayMediaDecision,
  audioRequested: boolean,
  deps: DisplayMediaDeps<S>,
): Promise<DisplayMediaAnswer<S>> {
  switch (decision.kind) {
    case "deny":
      return null;
    case "music": {
      let screen: S | null = null;
      try {
        screen = await deps.primaryScreen();
      } catch {
        screen = null;
      }
      return screen === null ? null : { video: screen, audio: "loopback" };
    }
    case "picker": {
      const result = await deps.pickSource(audioRequested);
      if (!result) return null;
      if (result.audio && deps.loopbackSupported) return { video: result.source, audio: "loopback" };
      return { video: result.source };
    }
  }
}
