import { stopServer } from './server'

export default async function globalTeardown(): Promise<void> {
  await stopServer('SIGTERM')
}
