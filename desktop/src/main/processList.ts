/**
 * The names of running programs, read the way the OS's own tools print them:
 * `tasklist /FO CSV /NH` on Windows, `ps -A -o comm=` elsewhere. Fixed
 * argument lists, no shell, no native module, nothing that touches another
 * process. Null when the list could not be read.
 */
import { execFile } from "node:child_process";

export type ProcessLister = () => Promise<string[] | null>;

export function parseTasklist(csv: string): string[] {
  const out: string[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const m = /^"([^"]*)"/.exec(line.trim());
    if (m && m[1]) out.push(m[1]);
  }
  return out;
}

export function parsePs(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function run(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 8000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : String(stdout));
    });
  });
}

export const listProcesses: ProcessLister = async () => {
  if (process.platform === "win32") {
    const out = await run("tasklist", ["/FO", "CSV", "/NH"]);
    return out === null ? null : parseTasklist(out);
  }
  const out = await run("ps", ["-A", "-o", "comm="]);
  return out === null ? null : parsePs(out);
};
