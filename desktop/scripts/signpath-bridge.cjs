// SPDX-License-Identifier: MIT
//
// Windows code signing through SignPath (docs/signpath-basvuru.md), INSIDE the
// electron-builder run, so that every hash electron-builder writes afterwards
// (the installer's blockmap, latest.yml's sha512) is computed from the signed
// bytes by construction.
//
// SignPath signs only what a GitHub Actions step uploads as a workflow
// artifact and submits with signpath/github-action-submit-signing-request
// (that is what makes the build "trusted": SignPath reads the origin from
// GitHub, not from us). electron-builder, however, wants each file signed at a
// precise moment of its build: Trio.exe before it is packed, the uninstaller
// before the installer embeds it, the installer before the blockmap and
// latest.yml are written. So the build runs in the background and this file is
// both sides of a small handshake through a per-run directory:
//
//   the sign hook (win.signtoolOptions.sign, inside electron-builder)
//     copies the file to <dir>/<role>/unsigned/<name>, writes request.json,
//     and waits for response.json;
//   the workflow (release.yml + .github/actions/signpath-sign)
//     `wait <role>` -> upload-artifact -> SignPath -> verify the Authenticode
//     signature and its publisher -> `accept <role>` writes response.json;
//   the hook checks the response against the bytes and puts the signed file
//     in place, and electron-builder carries on.
//
// Roles, in the order electron-builder 26.18 signs them for Trio's config:
//   app          release/win-unpacked/Trio.exe
//   (elevate.exe NSIS's helper from electron-builder's toolset: third-party,
//                passed through unsigned, as it ships today)
//   uninstaller  release/Trio-<v>-win-x64.__uninstaller.exe
//   installer    release/Trio-<v>-win-x64.exe
//
// Commands (run from desktop/):
//   node scripts/signpath-bridge.cjs start          start electron-builder --win in the background
//   node scripts/signpath-bridge.cjs wait <role>    wait for its request; prints JSON for the next steps
//   node scripts/signpath-bridge.cjs accept <role>  hand the signed file (already verified) back
//   node scripts/signpath-bridge.cjs finish         wait for the build; check latest.yml against the installer
//   node scripts/signpath-bridge.cjs cleanup        after a failure: stop the background build
//
// Everything is keyed by a nonce per run and by the SHA-256 of the bytes, so a
// stale or mixed-up response is refused rather than shipped.
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");

const ROLES = ["app", "uninstaller", "installer"];
// Fixed names in the SignPath artifacts, so the artifact configurations need
// no version wildcard (docs/signpath-basvuru.md has the XML).
const STAGED = { app: "Trio.exe", uninstaller: "Trio-uninstaller.exe", installer: "Trio-setup.exe" };
const DESKTOP = path.resolve(__dirname, "..");

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (bytes, algorithm = "sha256", encoding = "hex") =>
  createHash(algorithm).update(bytes).digest(encoding);
const hashFile = async (file) => sha(await fsp.readFile(file));
const readJson = async (file) => JSON.parse(await fsp.readFile(file, "utf8"));

async function optionalJson(file) {
  try {
    return await readJson(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// Written to a temporary name and renamed, so a reader never sees half a file.
async function writeJson(file, value) {
  await fsp.writeFile(`${file}.tmp`, JSON.stringify(value, null, 2), { flag: "wx" });
  await fsp.rename(`${file}.tmp`, file);
}

function root() {
  const dir = process.env.SIGNPATH_DIRECTORY;
  if (!dir) throw new Error("SIGNPATH_DIRECTORY is not set");
  return path.resolve(dir);
}

/** The paths electron-builder signs, from the session's output dir and version. */
function expectedPaths(session) {
  const installer = path.join(session.output, `${session.productFilename}-${session.version}-win-x64.exe`);
  return {
    app: path.join(session.output, "win-unpacked", `${session.productFilename}.exe`),
    // NsisTarget: `${path.basename(installerPath, "exe")}__uninstaller.exe` (the dot stays).
    uninstaller: path.join(session.output, `${path.basename(installer, "exe")}__uninstaller.exe`),
    installer,
  };
}

/** Which role a file electron-builder wants signed has; "skip" for elevate.exe. */
function classify(file, session) {
  const resolved = path.resolve(file);
  const expected = expectedPaths(session);
  for (const role of ROLES) {
    if (samePath(resolved, expected[role])) return role;
  }
  if (path.basename(resolved).toLowerCase() === "elevate.exe") return "skip";
  throw new Error(`signpath-bridge: unexpected file to sign: ${resolved}`);
}

function samePath(a, b) {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * The sign hook's core: one call per file, in electron-builder's order.
 * `timeoutMs` bounds the wait for each response (SignPath waits for a person
 * to approve the request).
 */
function createSigner(session, { timeoutMs = 75 * 60_000, pollMs = 500 } = {}) {
  let next = 0;
  return async function signFile(file, { hash = "sha256", isNest = false } = {}) {
    const role = classify(file, session);
    if (role === "skip") return "skipped";
    if (hash !== "sha256" || isNest) throw new Error("signpath-bridge: only one sha256 signature per file");
    if (ROLES[next] !== role) {
      throw new Error(`signpath-bridge: expected to sign ${ROLES[next] ?? "nothing more"}, got ${role}`);
    }
    const source = path.resolve(file);
    const dir = path.join(session.root, role);
    const unsigned = path.join(dir, "unsigned", STAGED[role]);
    const signed = path.join(dir, "signed", STAGED[role]);
    await fsp.mkdir(path.dirname(unsigned), { recursive: true });
    await fsp.copyFile(source, unsigned);
    const unsignedSha256 = await hashFile(unsigned);
    const request = { nonce: session.nonce, id: randomUUID(), role, unsignedSha256 };
    await writeJson(path.join(dir, "request.json"), request);

    const deadline = Date.now() + timeoutMs;
    let response;
    while (!(response = await optionalJson(path.join(dir, "response.json")))) {
      if (Date.now() >= deadline) throw new Error(`signpath-bridge: timed out waiting for the signed ${role}`);
      await pause(pollMs);
    }
    if (
      response.nonce !== session.nonce ||
      response.id !== request.id ||
      response.unsignedSha256 !== unsignedSha256 ||
      response.signedSha256 !== (await hashFile(signed)) ||
      response.signedSha256 === unsignedSha256
    ) {
      throw new Error(`signpath-bridge: the response for ${role} does not match its request`);
    }
    if ((await hashFile(source)) !== unsignedSha256) {
      throw new Error(`signpath-bridge: ${source} changed while it was being signed`);
    }
    await fsp.copyFile(signed, source);
    if ((await hashFile(source)) !== response.signedSha256) {
      throw new Error(`signpath-bridge: ${source} is not the signed file after replacing it`);
    }
    next++;
    return role;
  };
}

/** For `wait`: the request of a role, checked against the staged bytes. */
async function readRequest(session, role) {
  if (!ROLES.includes(role)) throw new Error(`signpath-bridge: unknown role ${role}`);
  const dir = path.join(session.root, role);
  const request = await optionalJson(path.join(dir, "request.json"));
  if (!request) return null;
  const unsigned = path.join(dir, "unsigned", STAGED[role]);
  if (request.nonce !== session.nonce || request.role !== role || (await hashFile(unsigned)) !== request.unsignedSha256) {
    throw new Error(`signpath-bridge: the request for ${role} is stale or its file changed`);
  }
  return {
    role,
    path: unsigned,
    file: STAGED[role],
    signedDirectory: path.join(dir, "signed"),
  };
}

/** For `accept`: exactly one file came back from SignPath, under the staged name, with new bytes. */
async function writeResponse(session, role) {
  const info = await readRequest(session, role);
  if (!info) throw new Error(`signpath-bridge: no request for ${role}`);
  const request = await readJson(path.join(session.root, role, "request.json"));
  const files = await fsp.readdir(info.signedDirectory);
  if (files.length !== 1 || files[0] !== info.file) {
    throw new Error(`signpath-bridge: expected exactly ${info.file} from SignPath, got ${files.join(", ") || "nothing"}`);
  }
  const signedSha256 = await hashFile(path.join(info.signedDirectory, info.file));
  if (signedSha256 === request.unsignedSha256) throw new Error(`signpath-bridge: ${role} came back unchanged`);
  await writeJson(path.join(session.root, role, "response.json"), {
    nonce: session.nonce,
    id: request.id,
    unsignedSha256: request.unsignedSha256,
    signedSha256,
  });
}

/**
 * For `finish`: latest.yml must name the installer with the sha512 and size of
 * the bytes on disk, i.e. of the SIGNED installer (release.yml checks the same
 * again before publishing; this fails the Windows job early).
 */
async function checkUpdateMetadata(session) {
  const installer = expectedPaths(session).installer;
  const bytes = await fsp.readFile(installer);
  const sha512 = sha(bytes, "sha512", "base64");
  const text = await fsp.readFile(path.join(session.output, "latest.yml"), "utf8");
  const name = path.basename(installer);
  const entry = new RegExp(`^  - url: ${escape(name)}\\n    sha512: (\\S+)\\n    size: (\\d+)$`, "m").exec(text);
  const top = /^sha512: (\S+)$/m.exec(text);
  if (!entry || entry[1] !== sha512 || Number(entry[2]) !== bytes.length || !top || top[1] !== sha512) {
    throw new Error("signpath-bridge: latest.yml does not describe the signed installer");
  }
  return { installer: name, sha512, size: bytes.length };
}

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---- electron-builder's hook ------------------------------------------------

let signer = null;

/** win.signtoolOptions.sign: electron-builder calls this once per file. */
async function sign(configuration) {
  const session = await readJson(path.join(root(), "session.json"));
  if (!signer) signer = createSigner(session);
  const result = await signer(configuration.path, { hash: configuration.hash, isNest: configuration.isNest });
  console.log(`signpath-bridge: ${path.basename(configuration.path)}: ${result}`);
}

// ---- the workflow's side ----------------------------------------------------

function requireHostedWindows() {
  if (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted") {
    throw new Error("signpath-bridge: SignPath signing runs only on a GitHub-hosted Windows runner");
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cli(command, role) {
  const dir = root();
  if (command === "start") {
    requireHostedWindows();
    const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, "package.json"), "utf8"));
    await fsp.mkdir(dir); // fails when it exists: never reuse an earlier run's files
    const session = {
      root: dir,
      nonce: randomUUID(),
      output: path.join(DESKTOP, pkg.build.directories.output),
      productFilename: pkg.build.productName,
      version: pkg.version,
    };
    await writeJson(path.join(dir, "session.json"), session);
    const out = fs.openSync(path.join(dir, "builder.log"), "w");
    const child = spawn(process.execPath, [__filename, "build"], {
      cwd: DESKTOP,
      detached: true,
      stdio: ["ignore", out, out],
      env: process.env,
    });
    fs.closeSync(out);
    child.unref();
    await writeJson(path.join(dir, "pid.json"), { pid: child.pid });
    console.error(`signpath-bridge: electron-builder started (pid ${child.pid})`);
    return;
  }
  const session = await readJson(path.join(dir, "session.json"));
  if (command === "build") {
    const cliPath = require.resolve("electron-builder/cli.js", { paths: [DESKTOP] });
    const result = spawnSync(process.execPath, [cliPath, "--win", "--publish", "never"], {
      cwd: DESKTOP,
      stdio: "inherit",
      env: process.env,
    });
    await writeJson(path.join(dir, "build-result.json"), { success: result.status === 0, status: result.status });
    process.exitCode = result.status ?? 1;
    return;
  }
  const { pid } = await readJson(path.join(dir, "pid.json"));
  if (command === "wait") {
    const deadline = Date.now() + 30 * 60_000;
    for (;;) {
      const info = await readRequest(session, role);
      if (info) {
        process.stdout.write(`${JSON.stringify(info)}\n`);
        return;
      }
      const result = await optionalJson(path.join(dir, "build-result.json"));
      if (result || !alive(pid)) {
        printLog(dir);
        throw new Error(`signpath-bridge: electron-builder stopped before asking for ${role}`);
      }
      if (Date.now() >= deadline) throw new Error(`signpath-bridge: electron-builder never asked for ${role}`);
      await pause(1000);
    }
  }
  if (command === "accept") {
    await writeResponse(session, role);
    console.error(`signpath-bridge: ${role} handed back`);
    return;
  }
  if (command === "finish") {
    const deadline = Date.now() + 30 * 60_000;
    let result;
    while (!(result = await optionalJson(path.join(dir, "build-result.json")))) {
      if (!alive(pid)) break;
      if (Date.now() >= deadline) break;
      await pause(1000);
    }
    printLog(dir);
    if (!result || !result.success) throw new Error("signpath-bridge: electron-builder did not finish successfully");
    for (const r of ROLES) {
      if (!(await optionalJson(path.join(dir, r, "response.json")))) throw new Error(`signpath-bridge: ${r} was never signed`);
    }
    console.error(JSON.stringify(await checkUpdateMetadata(session)));
    return;
  }
  if (command === "cleanup") {
    printLog(dir);
    if ((await optionalJson(path.join(dir, "build-result.json")))?.success) return;
    if (alive(pid)) {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "inherit" });
    }
    return;
  }
  throw new Error(`signpath-bridge: unknown command ${command}`);
}

function printLog(dir) {
  try {
    process.stderr.write(fs.readFileSync(path.join(dir, "builder.log"), "utf8"));
  } catch {
    // no log yet
  }
}

module.exports = {
  sign,
  ROLES,
  STAGED,
  expectedPaths,
  classify,
  createSigner,
  readRequest,
  writeResponse,
  checkUpdateMetadata,
};

if (require.main === module) {
  cli(process.argv[2], process.argv[3]).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
