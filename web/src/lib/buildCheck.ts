/**
 * Is the page running the client the server now serves?
 *
 * A deploy restarts the server and every tab reconnects on its own, but the
 * JavaScript already in memory stays the OLD build until somebody reloads. A
 * tab left open across the attachments release kept a client that renders an
 * image-only message as an empty row. Vite puts a content hash in the entry
 * script's name, so comparing the `<script type="module" src>` of a fresh
 * `index.html` with the one this page was loaded from says whether a newer
 * build is live — no server change and no version number to maintain.
 */

/** The entry script's path in an index.html, e.g. `/assets/index-9rxOsY4f.js`, or null. */
export function entryScript(html: string): string | null {
  const match = /<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/i.exec(html)
  return match ? match[1] : null
}

/** The entry script this page was loaded from, as a path. */
export function currentEntryScript(doc: Document = document): string | null {
  const script = doc.querySelector<HTMLScriptElement>('script[type="module"][src]')
  if (!script) return null
  try {
    return new URL(script.src, doc.baseURI).pathname
  } catch {
    return null
  }
}

/** True only when the server's index.html names a different entry script than ours. */
export async function newerBuildIsLive(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const mine = currentEntryScript()
  if (!mine) return false // dev server (no hashed entry) or unknown shape: never reload
  try {
    const response = await fetchImpl('/', { cache: 'no-store', credentials: 'same-origin' })
    if (!response.ok) return false
    const served = entryScript(await response.text())
    return served !== null && served !== mine
  } catch {
    return false
  }
}
