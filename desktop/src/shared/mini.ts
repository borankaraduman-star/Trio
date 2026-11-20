/**
 * CONTRACT-V12-MINI-DESKTOP: the rules of the mini player windows, pure (no
 * Electron import) so they are unit-tested under plain Node.
 *
 * The web client opens a mini player itself:
 *
 *     window.open('<server origin>/mini.html?m=<id>', 'trio-mini-<id>', 'popup,…')
 *
 * and attaches the MediaStream to the child's `<video>` from the opener. The
 * shell allows exactly that window (same origin, that path, that name, at most
 * MAX_MINI_WINDOWS of them) and nothing else; it decides every option of the
 * window itself (see `miniWindowOptions`), whatever the features string says.
 */

export const MINI_PATH = "/mini.html";
export const MINI_NAME = /^trio-mini-([A-Za-z0-9_-]{1,64})$/;
export const MINI_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_MINI_WINDOWS = 4;

/** Sizes in DIP. The maximum is a share of the display's work area (anti-overlay). */
export const MINI_MIN = { width: 160, height: 90 } as const;
export const MINI_DEFAULT = { width: 400, height: 225 } as const;
export const MINI_MAX_SHARE = 0.6;
/** Gap from the work area's edge when the shell places a window itself. */
export const MINI_MARGIN = 16;
/** A drag that ends this close to an edge of the work area snaps flush to it. */
export const SNAP_DISTANCE = 24;

export const OPACITY_MIN = 0.4;
export const OPACITY_MAX = 1;
/** setAspectRatio: 0 unlocks; otherwise width / height within these bounds. */
export const ASPECT_MIN = 0.2;
export const ASPECT_MAX = 5;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisplayLike {
  id: number;
  workArea: Rect;
}

export type MiniOpenCheck =
  | { ok: true; id: string; size: { width: number; height: number } | null; focusable: boolean }
  | { ok: false; reason: "not-mini" | "origin" | "id" | "limit" | "open" };

/** A frame name `trio-mini-<id>` → the id, or null. */
export function miniIdFromName(frameName: unknown): string | null {
  if (typeof frameName !== "string") return null;
  const match = MINI_NAME.exec(frameName);
  return match ? (match[1] as string) : null;
}

export function isMiniId(id: unknown): id is string {
  return typeof id === "string" && MINI_ID.test(id);
}

/**
 * Whether a window.open from the server page is a mini player the shell may
 * create. `openIds` are the mini windows (and allowed-but-not-yet-created ones)
 * already counted for this page.
 */
export function checkMiniOpen(
  details: { url: string; frameName: string; features?: string },
  serverOrigin: string | null,
  openIds: ReadonlySet<string>,
): MiniOpenCheck {
  const nameId = miniIdFromName(details.frameName);
  let url: URL;
  try {
    url = new URL(details.url);
  } catch {
    return { ok: false, reason: "not-mini" };
  }
  if (url.pathname !== MINI_PATH && nameId === null) return { ok: false, reason: "not-mini" };
  if (url.pathname !== MINI_PATH || nameId === null) return { ok: false, reason: "id" };
  if (!serverOrigin || (url.protocol !== "https:" && url.protocol !== "http:") || url.origin !== serverOrigin) {
    return { ok: false, reason: "origin" };
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "") return { ok: false, reason: "id" };
  const params = [...url.searchParams.keys()];
  if (params.length !== 1 || params[0] !== "m" || url.searchParams.get("m") !== nameId) {
    return { ok: false, reason: "id" };
  }
  if (openIds.has(nameId)) return { ok: false, reason: "open" };
  if (openIds.size >= MAX_MINI_WINDOWS) return { ok: false, reason: "limit" };
  const features = parseFeatures(details.features ?? "");
  return { ok: true, id: nameId, size: features.size, focusable: features.focusable };
}

/**
 * The only features the shell reads: a wished-for first size, and
 * `focusable=no`. Everything else in the string is ignored (and overridden in
 * `miniWindowOptions`, because Electron parses most of it into options).
 */
export function parseFeatures(features: string): { size: { width: number; height: number } | null; focusable: boolean } {
  const values = new Map<string, string>();
  for (const part of features.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    values.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim().toLowerCase());
  }
  const num = (key: string): number | null => {
    const raw = values.get(key);
    if (raw === undefined || !/^[0-9]{1,5}$/.test(raw)) return null;
    return Number(raw);
  };
  const width = num("width");
  const height = num("height");
  const focusRaw = values.get("focusable");
  return {
    size: width !== null && height !== null ? { width, height } : null,
    focusable: !(focusRaw === "no" || focusRaw === "0" || focusRaw === "false"),
  };
}

/** The largest a mini window may be on a display with this work area. */
export function maxMiniSize(workArea: Rect): { width: number; height: number } {
  return {
    width: Math.max(MINI_MIN.width, Math.floor(workArea.width * MINI_MAX_SHARE)),
    height: Math.max(MINI_MIN.height, Math.floor(workArea.height * MINI_MAX_SHARE)),
  };
}

/** Size within [MINI_MIN, maxMiniSize] and the whole rectangle inside the work area. */
export function clampToWorkArea(bounds: Rect, workArea: Rect): Rect {
  const max = maxMiniSize(workArea);
  const finite = (n: number, fallback: number) => (Number.isFinite(n) ? Math.round(n) : fallback);
  const width = Math.min(max.width, Math.max(MINI_MIN.width, finite(bounds.width, MINI_DEFAULT.width)));
  const height = Math.min(max.height, Math.max(MINI_MIN.height, finite(bounds.height, MINI_DEFAULT.height)));
  const maxX = workArea.x + workArea.width - width;
  const maxY = workArea.y + workArea.height - height;
  const x = Math.min(Math.max(finite(bounds.x, maxX), workArea.x), Math.max(workArea.x, maxX));
  const y = Math.min(Math.max(finite(bounds.y, maxY), workArea.y), Math.max(workArea.y, maxY));
  return { x, y, width, height };
}

/** A window dropped within SNAP_DISTANCE of an edge is moved flush to it (corners are two edges). */
export function snapToEdges(bounds: Rect, workArea: Rect, distance = SNAP_DISTANCE): Rect {
  let { x, y } = bounds;
  const right = workArea.x + workArea.width - bounds.width;
  const bottom = workArea.y + workArea.height - bounds.height;
  if (Math.abs(x - workArea.x) <= distance) x = workArea.x;
  else if (Math.abs(x - right) <= distance) x = right;
  if (Math.abs(y - workArea.y) <= distance) y = workArea.y;
  else if (Math.abs(y - bottom) <= distance) y = bottom;
  return { x, y, width: bounds.width, height: bounds.height };
}

function centre(r: Rect): { x: number; y: number } {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

function contains(r: Rect, p: { x: number; y: number }): boolean {
  return p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Remembered bounds of one id class. `displayId` is where it was last. */
export interface SavedMini {
  bounds: Rect;
  displayId: number;
}

/**
 * Where a mini window opens: its class's remembered place when that display is
 * still there (or another display holds the remembered centre), clamped to
 * that display's work area; otherwise the bottom-right corner of `fallback`
 * (the display of the main window). `size` is the page's wished-for first size
 * (used only without a remembered place). Windows already open are not
 * covered: the new one stacks above them.
 */
export function placeMini(
  saved: SavedMini | null,
  displays: readonly DisplayLike[],
  fallback: DisplayLike,
  size: { width: number; height: number } | null,
  others: readonly Rect[] = [],
): { bounds: Rect; displayId: number } {
  let display: DisplayLike | undefined;
  let bounds: Rect;
  if (saved) {
    display =
      displays.find((d) => d.id === saved.displayId) ?? displays.find((d) => contains(d.workArea, centre(saved.bounds)));
  }
  if (display && saved) {
    bounds = clampToWorkArea(saved.bounds, display.workArea);
  } else {
    display = fallback;
    const wa = fallback.workArea;
    const want = clampToWorkArea({ x: 0, y: 0, width: size?.width ?? MINI_DEFAULT.width, height: size?.height ?? MINI_DEFAULT.height }, wa);
    bounds = clampToWorkArea(
      { x: wa.x + wa.width - want.width - MINI_MARGIN, y: wa.y + wa.height - want.height - MINI_MARGIN, width: want.width, height: want.height },
      wa,
    );
  }
  // Stack above (then left of) windows already open instead of on top of them.
  for (let step = 0; step < MAX_MINI_WINDOWS && others.some((o) => overlaps(o, bounds)); step++) {
    const blocker = others.find((o) => overlaps(o, bounds)) as Rect;
    const up = blocker.y - bounds.height - 8;
    const next = up >= display.workArea.y ? { ...bounds, y: up } : { ...bounds, x: blocker.x - bounds.width - 8, y: bounds.y };
    const clamped = clampToWorkArea(next, display.workArea);
    if (clamped.x === bounds.x && clamped.y === bounds.y) break;
    bounds = clamped;
  }
  return { bounds, displayId: display.id };
}

/** The id class whose bounds are remembered: the id up to its first `-` or `_`. */
export function idClass(id: string): string {
  const cut = id.search(/[-_]/);
  return (cut > 0 ? id.slice(0, cut) : id).slice(0, 32);
}

export interface MiniOptions {
  opacity?: number;
  clickThrough?: boolean;
  alwaysOnTop?: boolean;
  aspect?: number;
  /** Addition to the seam: keep the window out of the user's own screen captures. */
  contentProtection?: boolean;
}

/** What `setOptions` accepts from the page; anything else is dropped. */
export function normalizeMiniOptions(raw: unknown): MiniOptions {
  if (typeof raw !== "object" || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const out: MiniOptions = {};
  if (typeof r.opacity === "number" && Number.isFinite(r.opacity)) out.opacity = clampOpacity(r.opacity);
  if (typeof r.clickThrough === "boolean") out.clickThrough = r.clickThrough;
  if (typeof r.alwaysOnTop === "boolean") out.alwaysOnTop = r.alwaysOnTop;
  if (typeof r.aspect === "number" && Number.isFinite(r.aspect)) {
    if (r.aspect === 0) out.aspect = 0;
    else if (r.aspect >= ASPECT_MIN && r.aspect <= ASPECT_MAX) out.aspect = r.aspect;
  }
  if (typeof r.contentProtection === "boolean") out.contentProtection = r.contentProtection;
  return out;
}

export function clampOpacity(value: number): number {
  if (!Number.isFinite(value)) return OPACITY_MAX;
  return Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, value));
}

/**
 * Every option of a mini window, written out. Electron builds a child window
 * from the window.open features string FIRST and these on top, and its parser
 * passes through nearly any key (measured on Electron 45 with
 * `transparent=yes,modal=yes,opacity=0.1,enableLargerThanScreen=yes,
 * maxWidth=99999,titleBarStyle=hidden,…`): so each key a page could set is set
 * here, and the ones that matter are applied again after creation.
 */
export function miniWindowOptions(input: {
  bounds: Rect;
  max: { width: number; height: number };
  focusable: boolean;
  preload: string;
  macOS: boolean;
}): Record<string, unknown> {
  return {
    x: input.bounds.x,
    y: input.bounds.y,
    width: input.bounds.width,
    height: input.bounds.height,
    minWidth: MINI_MIN.width,
    minHeight: MINI_MIN.height,
    maxWidth: input.max.width,
    maxHeight: input.max.height,
    useContentSize: false,
    center: false,
    show: false,
    frame: false,
    transparent: false,
    hasShadow: true,
    thickFrame: true,
    titleBarStyle: "default",
    roundedCorners: true,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreen: false,
    fullscreenable: false,
    simpleFullscreen: false,
    kiosk: false,
    closable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: input.focusable,
    modal: false,
    enableLargerThanScreen: false,
    opacity: 1,
    backgroundColor: "#000000",
    title: "Trio — mini oynatıcı",
    autoHideMenuBar: true,
    // macOS: a panel does not activate the app when clicked, so the game keeps focus.
    ...(input.macOS ? { type: "panel" } : {}),
    webPreferences: {
      preload: input.preload,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      javascript: true,
      plugins: false,
      experimentalFeatures: false,
      spellcheck: false,
      zoomFactor: 1,
      // The video keeps playing while the window is covered or the main window is hidden.
      backgroundThrottling: false,
    },
  };
}

export interface MiniState {
  id: string;
  visible: boolean;
  clickThrough: boolean;
  bounds: Rect;
  /** Addition to the seam: present (true) once, when the window has closed. */
  closed?: true;
}
