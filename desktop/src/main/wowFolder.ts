/**
 * Finding the WoW folder: common install locations, the flavour folders in
 * it (`_retail_`, `_classic_`, `_forever_`, …), and the files the game status
 * reads inside the chosen flavour folder.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface Flavour {
  /** Absolute path of the flavour folder (or of the install itself, old layout). */
  path: string;
  /** "_forever_", or "" for the install root. */
  name: string;
  hasLogs: boolean;
  hasWtf: boolean;
  hasAddOns: boolean;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function describe(dir: string, name: string): Flavour {
  return {
    path: dir,
    name,
    hasLogs: isDir(path.join(dir, "Logs")),
    hasWtf: isDir(path.join(dir, "WTF")),
    hasAddOns: isDir(path.join(dir, "Interface", "AddOns")),
  };
}

const usable = (f: Flavour): boolean => f.hasLogs || f.hasWtf || f.hasAddOns;

/**
 * The flavour folders under `root`. When `root` is itself a flavour folder
 * (it has Logs/WTF/Interface), it is the one answer.
 */
export function flavoursIn(root: string): Flavour[] {
  if (!isDir(root)) return [];
  const self = describe(root, "");
  const base = path.basename(root);
  if (/^_.+_$/.test(base) && usable(self)) return [{ ...self, name: base }];
  let names: string[] = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return usable(self) ? [self] : [];
  }
  const found = names
    .filter((n) => /^_.+_$/.test(n))
    .map((n) => describe(path.join(root, n), n))
    .filter(usable)
    .sort((a, b) => flavourRank(a.name) - flavourRank(b.name) || a.name.localeCompare(b.name));
  if (found.length === 0 && usable(self)) return [self];
  return found;
}

/** Forever first (it is what this was built for), then the rest. */
function flavourRank(name: string): number {
  if (/forever/i.test(name)) return 0;
  if (name === "_retail_") return 1;
  return 2;
}

/** Install roots worth looking at on this machine. */
export function candidateRoots(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string[] {
  const out: string[] = [];
  if (platform === "win32") {
    const pf86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const pf = env.ProgramFiles ?? "C:\\Program Files";
    out.push(path.win32.join(pf86, "World of Warcraft"), path.win32.join(pf, "World of Warcraft"));
    if (env.PUBLIC) out.push(path.win32.join(env.PUBLIC, "Games", "World of Warcraft"));
    for (const drive of ["C", "D", "E", "F", "G"]) {
      out.push(`${drive}:\\World of Warcraft`, `${drive}:\\Games\\World of Warcraft`);
      out.push(`${drive}:\\Program Files (x86)\\World of Warcraft`, `${drive}:\\Battle.net\\World of Warcraft`);
    }
  } else if (platform === "darwin") {
    out.push("/Applications/World of Warcraft", path.join(home, "Applications", "World of Warcraft"));
  } else {
    out.push(
      path.join(home, "Games", "world-of-warcraft", "drive_c", "Program Files (x86)", "World of Warcraft"),
      path.join(home, ".wine", "drive_c", "Program Files (x86)", "World of Warcraft"),
    );
  }
  return [...new Set(out)];
}

/** Every flavour folder found under the candidate roots. */
export function autodetect(roots: string[] = candidateRoots()): Flavour[] {
  return roots.flatMap((root) => flavoursIn(root));
}

export function chatLogPath(flavour: string): string {
  return path.join(flavour, "Logs", "WoWChatLog.txt");
}

/**
 * `WTF/Account/<account>/SavedVariables/TrioDurum.lua`, the most recently
 * written one when there are several accounts; null when none.
 */
export function findSavedVariables(flavour: string): { file: string; mtimeMs: number } | null {
  const accounts = path.join(flavour, "WTF", "Account");
  let names: string[] = [];
  try {
    names = fs.readdirSync(accounts);
  } catch {
    return null;
  }
  let best: { file: string; mtimeMs: number } | null = null;
  for (const name of names) {
    const file = path.join(accounts, name, "SavedVariables", "TrioDurum.lua");
    try {
      const st = fs.statSync(file);
      if (st.isFile() && (!best || st.mtimeMs > best.mtimeMs)) best = { file, mtimeMs: st.mtimeMs };
    } catch {
      // not this account
    }
  }
  return best;
}
