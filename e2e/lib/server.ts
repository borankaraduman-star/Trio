/**
 * The real Trio server as a child process, controlled from the global setup
 * AND from tests (the resilience test kills and restarts it).
 *
 * Everything another process needs to find the server is kept in
 * `.state/server.json`: its port, its pid, and the environment it runs with.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
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
  /** Extra environment this server was started with (kept across a restart). */
  env?: Record<string, string>
}

/** The directory whose `trio_server` package is run. `TRIO_E2E_SERVER_DIR` overrides it. */
export function serverDir(): string {
  return path.resolve(process.env.TRIO_E2E_SERVER_DIR ?? path.join(ROOT, 'server'))
}

/** The python of the server's virtualenv (always `server/.venv`). */
export function python(): string {
  return path.join(ROOT, 'server', '.venv', 'bin', 'python')
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

/** Servers this process spawned, by pid, until their `exit` has been seen. */
const spawned = new Map<number, ChildProcess>()

/** Has the child exited, as far as its own handle knows? */
function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

/**
 * Is `pid` still THE SERVER this suite started on `port`? Not merely "does a
 * process with that number exist": pid numbers are reused (a container's
 * `pid_max` is often 32768, and browsers burn through that in minutes), so
 * after our server died its number may belong to anything — another suite's
 * server on the same machine, a browser. Signalling by number alone killed
 * other runs' servers.
 *
 * A pid THIS process spawned is answered from its ChildProcess handle, which
 * is the authority: the kernel cannot hand that number to anything else until
 * we have reaped the child, and `exit` is reported only once every thread of
 * it is gone and its sockets are closed. /proc is a guess by comparison (a
 * process between fork and exec still shows node's command line, and one that
 * is being killed shows an empty one while its threads still hold the port).
 * Only a pid read back from `.state/server.json` that another process
 * started (global setup vs. a test worker) is judged by its command line.
 */
function alive(pid: number, port: number): boolean {
  const child = spawned.get(pid)
  if (child) return !exited(child)
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

/**
 * Nothing accepts connections on `port` any more. A killed server's pid can
 * look gone (its command line reads empty once the main thread has dropped
 * its memory) while another of its threads is still finishing and the
 * listening socket is still open; a new server started then fails to bind.
 */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code === 'ECONNREFUSED'))
  })
}

/** What the log says since `marker` (this start), at most the last 40 lines: a CI job log shows it. */
function logTail(logFile: string, marker: string): string {
  try {
    const text = fs.readFileSync(logFile, 'utf8')
    const from = text.lastIndexOf(marker)
    return (from >= 0 ? text.slice(from) : text).split('\n').slice(-40).join('\n')
  } catch {
    return '(log unreadable)'
  }
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
export async function startServer(
  options: { port?: number; dataDir?: string; env?: Record<string, string> } = {},
): Promise<ServerState> {
  const port = options.port ?? (await freePort())
  // A restart reuses the port of a server that was just stopped.
  if (options.port !== undefined) await waitFor(() => portFree(port), 10000, `port ${port} to be free`)
  const dataDir = options.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'trio-e2e-'))
  const dbPath = path.join(dataDir, 'trio.db')
  const logFile = path.join(STATE_DIR, 'server.log')
  fs.mkdirSync(STATE_DIR, { recursive: true })
  const log = fs.openSync(logFile, 'a')
  const marker = `--- start ${new Date().toISOString()} port=${port} db=${dbPath}`
  fs.writeSync(log, `\n${marker}\n`)

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
    ...options.env,
  }
  // The server's own entry point: it holds the uvicorn options production
  // runs with (one worker, the websocket size cap, the 20 s ping) — CONTRACT-V3 §1, §6.
  const child = spawn(
    python(),
    ['-m', 'trio_server', '--host', '127.0.0.1', '--port', String(port), '--log-level', 'warning'],
    { cwd: serverDir(), env, stdio: ['ignore', log, log], detached: true },
  )
  if (child.pid) spawned.set(child.pid, child)
  // How it ended goes into the log: a server killed from outside leaves no other trace.
  child.on('exit', (code, signal) => {
    if (child.pid) spawned.delete(child.pid)
    try {
      fs.appendFileSync(logFile, `--- exit ${new Date().toISOString()} pid=${child.pid} code=${code} signal=${signal}\n`)
    } catch {
      // The log is a convenience.
    }
  })
  child.unref()
  fs.closeSync(log)
  if (!child.pid) throw new Error('could not start the server')
  const state: ServerState = { port, pid: child.pid, serverDir: serverDir(), dataDir, dbPath, logFile, env: options.env }
  writeState(state)

  await waitFor(
    async () => {
      // Asked of the handle, never of /proc (see `alive`).
      if (exited(child)) {
        throw new Error(
          `server exited during start (code=${child.exitCode} signal=${child.signalCode}); ` +
            `the end of ${logFile}:\n${logTail(logFile, marker)}`,
        )
      }
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
  return startServer({ port: state.port, dataDir: state.dataDir, env: state.env })
}

/** A brand-new server (empty database, fresh rate limits) on the same port; `env` adds settings. */
export async function freshServer(env?: Record<string, string>): Promise<ServerState> {
  const state = readState()
  await stopServer('SIGTERM')
  return startServer({ port: state.port, env })
}

/**
 * `python -m trio_server.admin --db <this run's database> <args>` (CONTRACT-V3 §3),
 * as the server's operator would run it against the live file. Returns stdout.
 */
export function admin(...args: string[]): string {
  const state = readState()
  return execFileSync(python(), ['-m', 'trio_server.admin', '--db', state.dbPath, ...args], {
    cwd: state.serverDir,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    encoding: 'utf8',
  })
}
