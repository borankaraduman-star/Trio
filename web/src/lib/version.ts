/** This client's version and build (CONTRACT-V4 A2), embedded by vite.config.ts. */
export const CLIENT_VERSION: string = typeof __TRIO_VERSION__ === 'string' ? __TRIO_VERSION__ : '0.0.0'
export const CLIENT_BUILD: string = typeof __TRIO_BUILD__ === 'string' ? __TRIO_BUILD__ : 'dev'

/** The settings footer: "Trio 0.3.0 (202611190135) · sunucu 0.2.0". */
export function versionLine(client: string, build: string, server: string | null): string {
  const own = `Trio ${client} (${build})`
  return server === null ? own : `${own} · sunucu ${server}`
}
