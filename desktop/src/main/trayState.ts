/**
 * CONTRACT-V6-VOICE §5: the tray icon shows muted / deafened. No new image
 * asset: the existing tray bitmap gets a small mark drawn into its
 * bottom-right corner at runtime (like the taskbar badge, badge.ts):
 * a danger-red disc (#E4777F, design/palette.md) with a white bar for muted,
 * and with a white ring for deafened. Pure, so it is unit-tested.
 */

export type TrayVoiceState = "none" | "muted" | "deafened";

export function trayVoiceState(state: { inVoice: boolean; muted: boolean; deafened: boolean }): TrayVoiceState {
  if (!state.inVoice) return "none";
  if (state.deafened) return "deafened";
  return state.muted ? "muted" : "none";
}

export function trayTooltip(state: TrayVoiceState, base: string): string {
  if (state === "deafened") return `${base} — kulaklık kapalı`;
  if (state === "muted") return `${base} — sessizde`;
  return base;
}

/**
 * A copy of `bitmap` (BGRA, `width`×`height`, as `nativeImage.toBitmap()`
 * returns) with the mark for `state` drawn in. "none" returns an unchanged copy.
 */
export function drawTrayMark(bitmap: Buffer, width: number, height: number, state: TrayVoiceState): Buffer {
  const out = Buffer.from(bitmap);
  if (state === "none" || width <= 0 || height <= 0) return out;
  const size = Math.min(width, height);
  const r = size * 0.3;
  const cx = width - r - 0.5;
  const cy = height - r - 0.5;
  const put = (x: number, y: number, rgb: [number, number, number]): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    out[i] = rgb[2];
    out[i + 1] = rgb[1];
    out[i + 2] = rgb[0];
    out[i + 3] = 0xff;
  };
  const red: [number, number, number] = [0xe4, 0x77, 0x7f];
  const white: [number, number, number] = [0xff, 0xff, 0xff];
  const dark: [number, number, number] = [0x11, 0x13, 0x18];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= r + 1 && d > r) put(x, y, dark); // an outline so it reads on any tray colour
      else if (d <= r) {
        const bar = Math.abs(y - cy) <= Math.max(0.6, r * 0.18) && Math.abs(x - cx) <= r * 0.55;
        const ring = d >= r * 0.45 && d <= r * 0.7;
        put(x, y, (state === "muted" ? bar : ring) ? white : red);
      }
    }
  }
  return out;
}
