/**
 * CONTRACT-V10-UPDATE: what the shell can do about updates on this machine,
 * the state the web client is shown, and the small checks that keep the
 * updater honest. Pure: no electron import, so the tests run under node and
 * the preload can `import type` from here.
 */

/** The one repository the built app ever updates from (public; no token). */
export const UPDATE_OWNER = "borankaraduman-star";
export const UPDATE_REPO = "Trio";

/**
 * The schedule (CONTRACT-V10-UPDATE §4). A check is three requests to
 * github.com's web front (`releases.atom`, `releases/latest`, `latest*.yml`;
 * electron-updater 6.8.11 `GitHubProvider` uses no REST API for github.com),
 * from the user's own address. Once an hour (with jitter) is far below any
 * limit and keeps the shell's own latency at about an hour; the page's
 * "look now" (§4a) is what makes it minutes.
 */
export const FIRST_CHECK_DELAY_MS = 30_000;
export const CHECK_INTERVAL_MS = 45 * 60 * 1000;
/** Added to every periodic check, at random, so a group's apps do not ask in step. */
export const CHECK_JITTER_MS = 15 * 60 * 1000;
/** Waking from sleep or showing the window again checks only when the last check is older than this. */
export const WAKE_MIN_GAP_MS = 15 * 60 * 1000;
/** An update downloaded in an earlier run: the first check of the next start comes this soon. */
export const START_INSTALL_CHECK_DELAY_MS = 5_000;
/** ... and installs it only when it is ready within this long after start (and not in a call). */
export const START_INSTALL_WINDOW_MS = 2 * 60 * 1000;

/** Why self-update is not available here (the web client shows the manual notice instead). */
export type ManualReason =
  | "dev" // not a packaged build (npm start / npm run dev)
  | "portable" // a Windows portable exe: nothing to install over
  | "not-appimage" // Linux, but not running as an AppImage (APPIMAGE unset)
  | "unsigned-mac" // macOS without Developer ID: Squirrel.Mac refuses unsigned apps
  | "no-config" // the build carries no app-update.yml (built without the publish config)
  | "unsupported"; // any other platform

export type Capability = { kind: "auto" } | { kind: "manual"; reason: ManualReason };

/** `/api/downloads` platform word of THIS machine's installer (CONTRACT-V6-DOWNLOAD). */
export type DownloadPlatform = "windows" | "mac-arm64" | "mac-x64" | "linux";

export interface CapabilityInput {
  platform: NodeJS.Platform | string;
  isPackaged: boolean;
  env: Record<string, string | undefined>;
  /** `<resources>/app-update.yml` exists (electron-builder wrote the publish config). */
  hasUpdateConfig: boolean;
  /** The build was Developer ID signed and notarized (release.yml writes `trioBuild.macSigned`). */
  macSigned: boolean;
}

export function updateCapability(input: CapabilityInput): Capability {
  if (!input.isPackaged) return { kind: "manual", reason: "dev" };
  if (input.platform === "win32") {
    if (input.env.PORTABLE_EXECUTABLE_DIR) return { kind: "manual", reason: "portable" };
  } else if (input.platform === "linux") {
    if (!input.env.APPIMAGE) return { kind: "manual", reason: "not-appimage" };
  } else if (input.platform === "darwin") {
    if (!input.macSigned) return { kind: "manual", reason: "unsigned-mac" };
  } else {
    return { kind: "manual", reason: "unsupported" };
  }
  if (!input.hasUpdateConfig) return { kind: "manual", reason: "no-config" };
  return { kind: "auto" };
}

export function downloadPlatform(platform: string, arch: string): DownloadPlatform | null {
  if (platform === "win32") return "windows";
  if (platform === "linux") return "linux";
  if (platform === "darwin") return arch === "arm64" ? "mac-arm64" : "mac-x64";
  return null;
}

export type UpdateStatus =
  | "idle" // nothing checked yet
  | "checking"
  | "up-to-date"
  | "available" // newer release found, not downloaded (automatic download off)
  | "downloading"
  | "ready" // downloaded and verified; applied on restart or quit
  | "installing"
  | "error"
  | "manual"; // self-update not possible here (see `reason`)

/** What `getUpdateState()` / `onUpdateState` give the page. Plain data. */
export interface UpdateState {
  capability: "auto" | "manual";
  reason: ManualReason | null;
  platform: DownloadPlatform | null;
  currentVersion: string;
  autoDownload: boolean;
  status: UpdateStatus;
  /** The newer version (available / downloading / ready / installing). */
  version: string | null;
  /** 0–100 while downloading. */
  percent: number | null;
  /** A Turkish reason, only with status "error". */
  error: string | null;
  /** Last finished check, ms since epoch. */
  checkedAt: number | null;
  /** The page says the user is in a voice room: never a restart (checks and downloads go on). */
  inVoice: boolean;
}

// ------------------------------------------------------------ versions

interface Parsed {
  core: [number, number, number];
  pre: string[] | null;
}

function parse(version: string): Parsed | null {
  const m = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,40}))?$/.exec(version);
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : null };
}

/** Semver order; null when either is not a plain semver. */
export function compareVersions(a: string, b: string): number | null {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return (x.core[i] as number) - (y.core[i] as number);
  if (x.pre === null && y.pre === null) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p) ? Number(p) : null;
    const qn = /^\d+$/.test(q) ? Number(q) : null;
    if (pn !== null && qn !== null) {
      if (pn !== qn) return pn - qn;
    } else if (pn !== null) return -1;
    else if (qn !== null) return 1;
    else if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/** Only strictly newer versions are updates: never a downgrade, never the same build again. */
export function isNewer(candidate: string, current: string): boolean {
  const order = compareVersions(candidate, current);
  return order !== null && order > 0;
}

// ------------------------------------------------------- update metadata

/**
 * The files `latest*.yml` names must be plain asset names of the pinned
 * release (electron-updater resolves them under
 * github.com/<owner>/<repo>/releases/download/<tag>/). An absolute URL, a
 * path or anything odd is refused: the metadata cannot point elsewhere.
 */
export function updateFilesAcceptable(files: unknown): boolean {
  if (!Array.isArray(files) || files.length === 0) return false;
  return files.every((file) => {
    const url = (file as { url?: unknown } | null)?.url;
    const sha512 = (file as { sha512?: unknown } | null)?.sha512;
    return (
      typeof url === "string" &&
      /^Trio-[0-9A-Za-z._-]{1,60}\.(exe|AppImage|zip|dmg)$/.test(url) &&
      typeof sha512 === "string" &&
      sha512.length >= 80
    );
  });
}

/** A Turkish reason for an updater error, never the raw message (it may hold paths/URLs). */
export function errorReason(error: unknown): string {
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  const message = String((error as { message?: unknown } | null)?.message ?? error ?? "");
  if (code === "ERR_UPDATER_INVALID_SIGNATURE") return "yeni sürümün imzası doğrulanamadı";
  if (code === "ERR_CHECKSUM_MISMATCH" || /sha512 checksum mismatch/i.test(message)) {
    return "indirilen dosya doğrulanamadı";
  }
  if (code === "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" || code === "ERR_UPDATER_NO_PUBLISHED_VERSIONS") {
    return "sürüm bilgisi bulunamadı";
  }
  if (code === "TRIO_REFUSED_METADATA") return "sürüm bilgisi kabul edilmedi";
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|net::ERR_|socket hang up|network/i.test(message)) {
    return "internet bağlantısı yok";
  }
  if (/\b(403|429)\b|rate limit/i.test(message)) return "GitHub şu an yanıt vermiyor";
  if (/ENOSPC/i.test(message)) return "diskte yer yok";
  if (/EACCES|EPERM/i.test(message)) return "dosyaya yazma izni yok";
  return "beklenmeyen bir hata oluştu";
}

// ------------------------------------------------------- tray, notification

/** The tray menu's update item (§5): null when there is nothing to say. */
export function trayUpdateItem(state: UpdateState): { label: string; enabled: boolean; install: boolean } | null {
  if (state.capability !== "auto" || !state.version) return null;
  if (state.status === "ready") {
    return state.inVoice
      ? { label: `Güncelleme hazır: ${state.version} (sesli odadan çıkınca)`, enabled: false, install: false }
      : { label: `Yeniden başlat ve güncelle (${state.version})`, enabled: true, install: true };
  }
  if (state.status === "downloading") {
    // Tens only, so the menu is not rebuilt for every percent.
    const tens = Math.floor((state.percent ?? 0) / 10) * 10;
    return { label: `Güncelleme indiriliyor: ${state.version} (%${tens})`, enabled: false, install: false };
  }
  if (state.status === "available") return { label: `Yeni sürüm var: ${state.version}`, enabled: false, install: false };
  if (state.status === "installing") return { label: "Yeniden başlatılıyor…", enabled: false, install: false };
  return null;
}

/** Appended to the tray tooltip: "Trio — Güncelleme hazır: 0.9.1". */
export function trayUpdateTooltip(state: UpdateState): string | null {
  if (state.capability !== "auto" || !state.version) return null;
  if (state.status === "ready") return `Güncelleme hazır: ${state.version}`;
  return null;
}

/** The one native notification when an update becomes ready while the window is hidden. */
export function readyNotification(state: UpdateState): { title: string; body: string } | null {
  if (state.capability !== "auto" || state.status !== "ready" || !state.version) return null;
  return {
    title: "Trio güncellemesi hazır",
    body: state.inVoice
      ? `${state.version} indirildi. Sesli odadan çıkınca yeniden başlatabilirsin; uygulamadan çıkınca da kurulur.`
      : `${state.version} indirildi. Tepsideki menüden yeniden başlatabilirsin; uygulamadan çıkınca da kurulur.`,
  };
}
