/**
 * The client error log (CONTRACT-V6-OPS §5): what an uncaught error becomes on
 * the wire, and the rules that keep reporting harmless.
 *
 * Never sent: message contents, tokens, query strings or fragments of URLs
 * (an invite link carries its code in the fragment). Only the error's own
 * message and stack, trimmed, the client version, the path, and a browser
 * family. A reporter never throws and never reports its own failures.
 */

export const STACK_LIMIT = 2048
export const MESSAGE_LIMIT = 500
/** Client-side ceiling per page load; the server allows 10 per hour. */
export const REPORTS_PER_LOAD = 10

export interface ErrorReport {
  message: string
  stack: string
  version: string
  build: string
  context: string
  browser: string
}

// The query/fragment of a URL, up to a stack frame's ":line:col" (kept) or the URL's end.
const URL_TAIL = /((?:https?|wss?|blob):[^\s?#()'"]*)[?#][^\s()'"]*?(?=(?::\d+){1,2}(?=[\s)'"]|$)|[\s()'"]|$)/gi
const SECRET = /((?:token|ticket|code|key|password|davet)=)[^&\s"']+/gi

/** URLs without query or fragment, no `token=…`-shaped values, at most `limit` characters. */
export function scrubText(text: string, limit: number): string {
  return text.replace(URL_TAIL, '$1').replace(SECRET, '$1[redacted]').slice(0, limit)
}

/** "Chrome 131", "Firefox 133", "Safari 18", "Edge 131", "Trio masaüstü", else "diğer". */
export function browserFamily(userAgent: string): string {
  const version = (pattern: RegExp) => userAgent.match(pattern)?.[1] ?? ''
  if (/Electron\//.test(userAgent)) return 'Trio masaüstü'
  if (/Edg\//.test(userAgent)) return `Edge ${version(/Edg\/(\d+)/)}`.trim()
  if (/Firefox\//.test(userAgent)) return `Firefox ${version(/Firefox\/(\d+)/)}`.trim()
  if (/Chrome\//.test(userAgent)) return `Chrome ${version(/Chrome\/(\d+)/)}`.trim()
  if (/Safari\//.test(userAgent)) return `Safari ${version(/Version\/(\d+)/)}`.trim()
  return 'diğer'
}

/** The error's message and stack from whatever was thrown. */
export function describeThrown(thrown: unknown, fallbackMessage: string): { message: string; stack: string } {
  if (thrown instanceof Error) {
    return { message: `${thrown.name}: ${thrown.message}`, stack: typeof thrown.stack === 'string' ? thrown.stack : '' }
  }
  if (typeof thrown === 'string') return { message: thrown, stack: '' }
  return { message: fallbackMessage, stack: '' }
}

export function buildReport(
  thrown: unknown,
  fallbackMessage: string,
  env: { version: string; build: string; path: string; userAgent: string },
): ErrorReport {
  const { message, stack } = describeThrown(thrown, fallbackMessage)
  return {
    message: scrubText(message || fallbackMessage, MESSAGE_LIMIT),
    stack: scrubText(stack, STACK_LIMIT),
    version: env.version.slice(0, 40),
    build: env.build.slice(0, 40),
    // The path only: no query, no fragment (they can carry codes).
    context: scrubText(env.path.split(/[?#]/)[0] || '/', 120),
    browser: browserFamily(env.userAgent),
  }
}

/** A JSON body that fits the server's 4 KB limit: the stack is cut until it does. */
export function encodeReport(report: ErrorReport, maxBytes = 4096): string {
  let body = JSON.stringify(report)
  let stack = report.stack
  while (new TextEncoder().encode(body).length > maxBytes && stack.length > 0) {
    stack = stack.slice(0, Math.floor(stack.length * 0.75))
    body = JSON.stringify({ ...report, stack })
  }
  return body
}

/**
 * Decides what to send: one report per distinct message+first stack line per
 * page load, at most REPORTS_PER_LOAD, and nothing while a report is being
 * handed to `send` (an error raised by reporting itself is dropped, not reported).
 */
export class ReportGate {
  private readonly seen = new Set<string>()
  private sent = 0
  private busy = false

  constructor(private readonly limit = REPORTS_PER_LOAD) {}

  /** Call `send` (once) if this report should go out. Never throws. */
  offer(report: ErrorReport, send: (report: ErrorReport) => Promise<unknown>): boolean {
    try {
      if (this.busy || this.sent >= this.limit) return false
      const key = `${report.message}\n${report.stack.split('\n').find((line) => /^\s*(at\s|\S*@\S)/.test(line)) ?? ''}`
      if (this.seen.has(key)) return false
      this.seen.add(key)
      this.sent += 1
      // `busy` covers the synchronous part of sending: anything thrown from
      // inside it re-enters here and is dropped. A failed request is swallowed.
      this.busy = true
      try {
        send(report).catch(() => undefined)
      } finally {
        this.busy = false
      }
      return true
    } catch {
      return false
    }
  }
}
