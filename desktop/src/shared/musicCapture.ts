/**
 * CONTRACT-V8-MUSIC §3 / §5, desktop side: sharing the computer's sound
 * WITHOUT Trio's own output (the voices of the room).
 *
 * How it works (Electron 45.3.4 / Chromium 156, read in their sources):
 *
 *   - The page calls getDisplayMedia with the audio constraint
 *     `restrictOwnAudio: true` (blink RuntimeEnabledFeature "RestrictOwnAudio",
 *     status "stable" in Chromium 156).
 *   - Our display-media handler answers `audio: "loopback"`. Electron
 *     (shell/browser/electron_browser_context.cc, since v44) then replaces the
 *     device id with `media::AudioDeviceDescription::kLoopbackWithoutChromeId`
 *     ("loopbackWithoutChrome") when the request carries restrict_own_audio.
 *     NOT for "loopbackWithMute": only plain "loopback" is mapped.
 *   - Chromium's WASAPI input stream (media/audio/win/
 *     audio_low_latency_input_win.cc) opens that id as a PROCESS loopback,
 *     `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE` with the audio
 *     service's own process id: everything the system plays except what
 *     Trio's audio service (which plays every remote voice) renders.
 *   - Chromium declares this supported only on Windows 11
 *     (`media::IsWindowsProcessLoopbackCaptureSupported`:
 *     `base::win::GetVersion() >= WIN11`, i.e. build 22000), and the track's
 *     `getSettings().restrictOwnAudio` is true only where it is supported.
 *
 * So the rule is: Windows 11 or newer only, the page MUST pass
 * `restrictOwnAudio: true` and MUST check `getSettings().restrictOwnAudio`
 * afterwards. Everywhere else the app refuses (never shares the room back).
 *
 * No Electron import: main.ts wires it; tests drive it with a fake clock.
 */

/** Windows 11's first build; Chromium's `base::win::Version::WIN11`. */
export const WIN11_FIRST_BUILD = 22000;

/** How long a prepared music request waits for its getDisplayMedia call. */
export const ARM_TIMEOUT_MS = 15_000;

export type MusicRefusal = "windows-version" | "unsupported-platform" | "busy" | "not-allowed";

export type MusicSupport = { systemAudio: true } | { systemAudio: false; reason: MusicRefusal; message: string };

export type PrepareResult = { ok: true } | { ok: false; reason: MusicRefusal; message: string };

const CHROME_HINT =
  "Bunun yerine Trio'yu Chrome'da (ya da Edge'de) aç ve müziğin çaldığı sekmeyi paylaş.";

/** Turkish text the page may show as it is (CONTRACT-V8-MUSIC §5). */
export const REFUSAL_MESSAGES: Record<MusicRefusal, string> = {
  "windows-version":
    "Bilgisayar sesini paylaşmak masaüstü uygulamasında Windows 11 gerektiriyor. " +
    "Windows 10'da Trio odadaki konuşmaları paylaşılan sesten ayıramıyor; " +
    "herkes kendi sesini geri duyardı. " +
    CHROME_HINT,
  "unsupported-platform":
    "Bilgisayar sesini paylaşmak masaüstü uygulamasında yalnızca Windows 11'de var. " + CHROME_HINT,
  busy: "Başka bir paylaşım seçimi açık. Onu kapatıp tekrar dene.",
  "not-allowed": "İzin verilmedi.",
};

function refusal(reason: MusicRefusal): { systemAudio: false; reason: MusicRefusal; message: string } {
  return { systemAudio: false, reason, message: REFUSAL_MESSAGES[reason] };
}

/** The Windows build from `os.release()` ("10.0.22631" -> 22631); null if unreadable. */
export function windowsBuild(release: string): number | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(release.trim());
  if (!m) return null;
  // Windows 7/8/8.1 report 6.x: older than any build that matters here.
  if (Number(m[1]) < 10) return 0;
  return Number(m[3]);
}

/** Whether this machine can share system sound without Trio's own output. */
export function musicCaptureSupport(platform: string, release: string): MusicSupport {
  if (platform !== "win32") return refusal("unsupported-platform");
  const build = windowsBuild(release);
  if (build === null || build < WIN11_FIRST_BUILD) return refusal("windows-version");
  return { systemAudio: true };
}

/** What the display-media handler does with one request. */
export type DisplayMediaDecision =
  /** The existing in-app screen/window picker, unchanged (screen sharing). */
  | { kind: "picker" }
  /** A prepared music request: primary screen as the (discarded) video, `audio: "loopback"`. */
  | { kind: "music" }
  /** Deny (callback(null)). */
  | { kind: "deny" };

export interface DisplayRequestFacts {
  /** The request comes from the main window's page on the configured server. */
  fromServer: boolean;
  videoRequested: boolean;
  audioRequested: boolean;
  /** The screen-share picker window is already open. */
  pickerOpen: boolean;
}

/**
 * One-shot "the next getDisplayMedia is a music share" flag. Armed by
 * `prepareMusicCapture()`, consumed by the very next display-media request
 * (whatever it turns out to be), forgotten after ARM_TIMEOUT_MS.
 */
export class MusicCaptureArm {
  private armedAt: number | null = null;

  constructor(
    private readonly support: () => MusicSupport,
    private readonly now: () => number = Date.now,
  ) {}

  /** `prepareMusicCapture()` from the server page. */
  prepare(fromServer: boolean, pickerOpen: boolean): PrepareResult {
    if (!fromServer) return { ok: false, reason: "not-allowed", message: REFUSAL_MESSAGES["not-allowed"] };
    const support = this.support();
    if (!support.systemAudio) {
      this.armedAt = null;
      return { ok: false, reason: support.reason, message: support.message };
    }
    if (pickerOpen) return { ok: false, reason: "busy", message: REFUSAL_MESSAGES.busy };
    this.armedAt = this.now();
    return { ok: true };
  }

  get armed(): boolean {
    return this.armedAt !== null && this.now() - this.armedAt <= ARM_TIMEOUT_MS;
  }

  /** Decide one display-media request; consumes the arm in every case. */
  decide(facts: DisplayRequestFacts): DisplayMediaDecision {
    const armed = this.armed;
    this.armedAt = null;
    if (!facts.fromServer || !facts.videoRequested || facts.pickerOpen) return { kind: "deny" };
    if (!armed) return { kind: "picker" };
    // A music request without audio is a page bug; never fall through to
    // anything that could share something else.
    if (!facts.audioRequested) return { kind: "deny" };
    // Checked again: the OS cannot change, but this keeps the rule in one place.
    if (!this.support().systemAudio) return { kind: "deny" };
    return { kind: "music" };
  }
}
