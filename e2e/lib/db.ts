/** Direct writes to the running server's SQLite file, for seeding what the UI cannot (old dates). */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { readState, ROOT } from './server'

export function sql(statement: string, params: (string | number)[] = []): void {
  const python = path.join(ROOT, 'server', '.venv', 'bin', 'python')
  const script = [
    'import sqlite3, sys, json',
    'c = sqlite3.connect(sys.argv[1], timeout=10)',
    'c.execute(sys.argv[2], json.loads(sys.argv[3]))',
    'c.commit()',
  ].join('\n')
  execFileSync(python, ['-c', script, readState().dbPath, statement, JSON.stringify(params)])
}
