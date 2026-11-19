/**
 * The desktop app's version for the web client (CONTRACT-V6-VOICE, "Desktop
 * version"). The sandboxed preload cannot call `app.getVersion()`, so the
 * main process appends it to the renderer's `process.argv` through
 * `webPreferences.additionalArguments`, and the preload reads it back and
 * exposes `window.trioDesktop.appVersion`. The preload repeats this parse
 * inline (a sandboxed preload imports only `electron`); a test holds the two
 * to the same prefix.
 */
export const VERSION_ARG_PREFIX = "--trio-app-version=";

const VERSION_RE = /^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}(?:[-+][0-9A-Za-z.-]{1,24})?$/;

export function versionArgument(version: string): string[] {
  return VERSION_RE.test(version) ? [`${VERSION_ARG_PREFIX}${version}`] : [];
}

export function versionFromArgv(argv: readonly unknown[]): string | null {
  for (const arg of argv) {
    if (typeof arg !== "string" || !arg.startsWith(VERSION_ARG_PREFIX)) continue;
    const value = arg.slice(VERSION_ARG_PREFIX.length);
    return VERSION_RE.test(value) ? value : null;
  }
  return null;
}

/** The disabled menu line, "Trio 0.4.0". */
export function versionLabel(version: string): string {
  return `Trio ${version}`;
}
