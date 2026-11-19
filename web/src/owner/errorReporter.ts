/**
 * Installs the client error log (CONTRACT-V6-OPS §5): uncaught errors and
 * unhandled rejections go to POST /api/client-errors while signed in.
 * Imported once, for its effect, from main.tsx. Everything here is guarded:
 * a failure to report is silent and is never reported.
 */
import { loadAuth } from '../api'
import { buildReport, encodeReport, ReportGate, type ErrorReport } from '../lib/errorReport'
import { CLIENT_BUILD, CLIENT_VERSION } from '../lib/version'

const gate = new ReportGate()

async function send(report: ErrorReport): Promise<void> {
  const auth = loadAuth()
  if (!auth) return
  await fetch('/api/client-errors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` },
    body: encodeReport(report),
    keepalive: true,
  })
}

function report(thrown: unknown, fallback: string): void {
  try {
    const built = buildReport(thrown, fallback, {
      version: CLIENT_VERSION,
      build: CLIENT_BUILD,
      path: window.location.pathname,
      userAgent: navigator.userAgent,
    })
    gate.offer(built, send)
  } catch {
    // Reporting must never add an error of its own.
  }
}

function install(): void {
  if (typeof window === 'undefined') return
  const marker = window as unknown as { __trioErrorReporter?: boolean }
  if (marker.__trioErrorReporter) return
  marker.__trioErrorReporter = true
  window.addEventListener('error', (event) => {
    // A script from another origin reports only "Script error." with nothing to act on.
    if (!event.error && (!event.message || event.message === 'Script error.')) return
    report(event.error, event.message || 'Hata')
  })
  window.addEventListener('unhandledrejection', (event) => {
    report(event.reason, 'Unhandled rejection')
  })
}

install()
