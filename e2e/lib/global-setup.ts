import { execFileSync } from 'node:child_process'
import { startServer, stopServer, WEB_DIR } from './server'

export default async function globalSetup(): Promise<void> {
  if (!process.env.TRIO_E2E_SKIP_BUILD) {
    execFileSync('npm', ['run', 'build'], { cwd: WEB_DIR, stdio: 'inherit' })
  }
  await stopServer() // a leftover from an interrupted run
  await startServer()
}
