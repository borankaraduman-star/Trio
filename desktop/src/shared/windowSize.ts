/**
 * CONTRACT-V10-GROUPS §4a: the main window's first size. Electron sizes a
 * window in device-independent pixels, which are the page's CSS pixels (at
 * zoom 100 %): Windows display scaling shrinks the WORK AREA in DIP (a
 * 1366×768 screen at 150 % is ~911×488), not the window. A 1280×820 window
 * larger than the work area is cut off by the screen edge, so the page's real
 * width is unknown; sized to the work area instead it is exactly what shows.
 * The member list column needs more than 880 CSS px (web/src/lib/phone.ts).
 */
export const DEFAULT_WINDOW = { width: 1280, height: 820 } as const
/** The narrowest page that still shows the member list column (881 CSS px) plus the window frame. */
export const MEMBER_COLUMN_WINDOW_WIDTH = 881 + 16

export function initialWindowSize(workArea: { width: number; height: number }): { width: number; height: number } {
  const fit = (want: number, room: number) => (Number.isFinite(room) && room > 0 ? Math.min(want, Math.floor(room)) : want);
  return { width: fit(DEFAULT_WINDOW.width, workArea.width), height: fit(DEFAULT_WINDOW.height, workArea.height) };
}

/** Whether a window of this width shows the member list column (else "Üyeler" opens it over the chat). */
export function showsMemberColumn(windowWidth: number): boolean {
  return windowWidth >= MEMBER_COLUMN_WINDOW_WIDTH;
}
