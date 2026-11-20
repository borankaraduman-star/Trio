/** CONTRACT-V11-ADDRESS §5: the desktop shell's optional `moveServer` (absent in older shells). */
export type MoveServerResult = { ok: true } | { ok: false; reason?: string }

interface MoveBridge {
  isDesktop?: unknown
  moveServer?: (request: { origin: string; code: string }) => Promise<MoveServerResult>
}

function bridge(): MoveBridge | null {
  const found = (globalThis as { trioDesktop?: MoveBridge }).trioDesktop
  return found && found.isDesktop === true ? found : null
}

/** 'browser', a desktop shell that can move itself, or one that cannot ('old-shell'). */
export function moveKind(): 'browser' | 'desktop' | 'old-shell' {
  const found = bridge()
  if (!found) return 'browser'
  return typeof found.moveServer === 'function' ? 'desktop' : 'old-shell'
}

export async function askShellToMove(origin: string, code: string): Promise<MoveServerResult> {
  const move = bridge()?.moveServer
  if (typeof move !== 'function') return { ok: false, reason: 'unsupported' }
  try {
    const result = await move({ origin, code })
    return result && result.ok === true ? { ok: true } : { ok: false, reason: result?.reason }
  } catch {
    return { ok: false, reason: 'failed' }
  }
}
