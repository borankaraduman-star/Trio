/**
 * The real Trio server as a child process, controlled from the global setup
 * AND from tests (the resilience test kills and restarts it).
 *
 * Everything another process needs to find the server is kept in
 * `.state/server.json`: its port, its pid, and the environment it runs with.
 */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const E2E_DIR = path.resolve(here, '..')
export const ROOT = path.resolve(E2E_DIR, '..')
export const WEB_DIR = path.join(ROOT, 'web')
const STATE_DIR = path.join(E2E_DIR, '.state')
const STATE_FILE = path.join(STATE_DIR, 'server.json')

export const INVITE_CODE = 'trio-e2e-davet'

export interface ServerState {
  port: number
  pid: number
  /** Directory uvicorn runs in (it imports `trio_server` from there). */
  serverDir: string
  /** Temp directory holding the database and uploads of the CURRENT run. */
  dataDir: string
  dbPath: string
  logFile: string
}

/** The directory whose `trio_server` package is run. `TRIO_E2E_SERVER_DIR` overrides it. */
export function serverDir(): string {
  return path.resolve(process.env.TRIO_E2E_SERVER_DIR ?? path.join(ROOT, 'server'))
}

/** The uvicorn of the server's virtualenv (always `server/.venv`). */
function uvicorn(): string {
  return path.join(ROOT, 'server', '.venv', 'bin', 'uvicorn')
}

export function readState(): ServerState {
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as ServerState
}

function writeState(state: ServerState): void {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

export function baseUrl(state: ServerState = readState()): string {
  return `http://127.0.0.1:${state.port}`
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
    })
  })
}

/**
 * Is `pid` still THE SERVER this suite started on `port`? Not merely "does a
 * process with that number exist": pid numbers are reused (a container's
 * `pid_max` is often 32768, and browsers burn through that in minutes), so
 * after our server died its number may belong to anything — another suite's
 * server on the same machine, a browser. Signalling by number alone killed
 * other runs' servers (seen as "server exited during start" with an empty log).
 */
function alive(pid: number, port: number): boolean {
  let command: string
  try {
    command = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ')
  } catch {
    try {
      // No /proc (macOS): ask ps.
      command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      return false
    }
  }
  return command.includes('trio_server') && command.includes(`--port ${port}`)
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function healthy(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`)
    return response.ok
  } catch {
    return false
  }
}

/**
 * Start a server. `dataDir` reuses an existing database (a restart);
 * without it a fresh, empty one is created.
 */
export async function startServer(options: { port?: number; dataDir?: string } = {}): Promise<ServerState> {
  const port = options.port ?? (await freePort())
  const dataDir = options.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'trio-e2e-'))
  const dbPath = path.join(dataDir, 'trio.db')
  const logFile = path.join(STATE_DIR, 'server.log')
  fs.mkdirSync(STATE_DIR, { recursive: true })
  const log = fs.openSync(logFile, 'a')
  fs.writeSync(log, `\n--- start ${new Date().toISOString()} port=${port} db=${dbPath}\n`)

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TRIO_INVITE_CODE: INVITE_CODE,
    TRIO_DB_PATH: dbPath,
    TRIO_UPLOAD_DIR: path.join(dataDir, 'uploads'),
    TRIO_STATIC_DIR: path.join(WEB_DIR, 'dist'),
    // No STUN: every peer is on this machine, host candidates are enough,
    // and a STUN server out on the internet would only slow ICE down.
    TRIO_STUN_URLS: '',
    PYTHONDONTWRITEBYTECODE: '1',
  }
  const child = spawn(
    uvicorn(),
    ['trio_server.main:app', '--host', '127.0.0.1', '--port', String(port), '--log-level', 'warning'],
    { cwd: serverDir(), env, stdio: ['ignore', log, log], detached: true },
  )
  // How it ended goes into the log: a server killed from outside leaves no other trace.
  child.on('exit', (code, signal) => {
    try {
      fs.appendFileSync(logFile, `--- exit ${new Date().toISOString()} pid=${child.pid} code=${code} signal=${signal}\n`)
    } catch {
      // The log is a convenience.
    }
  })
  child.unref()
  fs.closeSync(log)
  if (!child.pid) throw new Error('could not start the server')
  const state: ServerState = { port, pid: child.pid, serverDir: serverDir(), dataDir, dbPath, logFile }
  writeState(state)

  await waitFor(
    async () => {
      if (!alive(child.pid!, port)) throw new Error(`server exited during start; see ${logFile}`)
      return healthy(port)
    },
    20000,
    'the server to answer /api/health',
  )
  return state
}

/** Stop the server. `signal` SIGKILL simulates a crash. */
export async function stopServer(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  let state: ServerState
  try {
    state = readState()
  } catch {
    return
  }
  if (!alive(state.pid, state.port)) return
  try {
    process.kill(state.pid, signal)
  } catch {
    return
  }
  await waitFor(() => !alive(state.pid, state.port), 10000, 'the server to exit').catch(() => {
    if (alive(state.pid, state.port)) process.kill(state.pid, 'SIGKILL')
  })
}

/** Kill the server and start it again on the same port with the same database. */
export async function restartServer(signal: NodeJS.Signals = 'SIGKILL'): Promise<ServerState> {
  const state = readState()
  await stopServer(signal)
  return startServer({ port: state.port, dataDir: state.dataDir })
}

/** A brand-new server (empty database, fresh rate limits) on the same port. */
export async function freshServer(): Promise<ServerState> {
  const state = readState()
  await stopServer('SIGTERM')
  return startServer({ port: state.port })
}
