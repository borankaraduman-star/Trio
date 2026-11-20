// The SignPath handshake (scripts/signpath-bridge.cjs) without SignPath:
// a fake "workflow" answers the hook's requests with modified bytes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface Session {
  root: string;
  nonce: string;
  output: string;
  productFilename: string;
  version: string;
}
interface Request {
  role: string;
  path: string;
  file: string;
  signedDirectory: string;
}
interface Bridge {
  ROLES: string[];
  expectedPaths(session: Session): Record<string, string>;
  classify(file: string, session: Session): string;
  createSigner(
    session: Session,
    options?: { timeoutMs?: number; pollMs?: number },
  ): (file: string, options?: { hash?: string; isNest?: boolean }) => Promise<string>;
  readRequest(session: Session, role: string): Promise<Request | null>;
  writeResponse(session: Session, role: string): Promise<void>;
  checkUpdateMetadata(session: Session): Promise<{ installer: string; sha512: string; size: number }>;
}

// dist/test/ -> desktop/scripts/
const bridge = require(path.join(__dirname, "..", "..", "scripts", "signpath-bridge.cjs")) as Bridge;

function setup(): Session {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "trio-signpath-"));
  const output = path.join(base, "release");
  fs.mkdirSync(path.join(output, "win-unpacked"), { recursive: true });
  const session = { root: path.join(base, "signpath"), nonce: "n-1", output, productFilename: "Trio", version: "0.9.0" };
  fs.mkdirSync(session.root);
  const paths = bridge.expectedPaths(session);
  for (const role of bridge.ROLES) fs.writeFileSync(paths[role], `unsigned ${role}`);
  return session;
}

/** Plays SignPath: waits for the request, "signs" by appending bytes, accepts. */
async function answer(session: Session, role: string, mutate = (b: Buffer) => Buffer.concat([b, Buffer.from(" +sig")])) {
  let info: Request | null = null;
  while (!(info = await bridge.readRequest(session, role))) await new Promise((r) => setTimeout(r, 5));
  fs.mkdirSync(info.signedDirectory, { recursive: true });
  fs.writeFileSync(path.join(info.signedDirectory, info.file), mutate(fs.readFileSync(info.path)));
  await bridge.writeResponse(session, role);
}

test("classify: the three files electron-builder signs, elevate.exe passed through, anything else refused", () => {
  const session = setup();
  const out = session.output;
  assert.equal(bridge.classify(path.join(out, "win-unpacked", "Trio.exe"), session), "app");
  // NsisTarget keeps the dot: basename(installer, "exe") + "__uninstaller.exe".
  assert.equal(bridge.classify(path.join(out, "Trio-0.9.0-win-x64.__uninstaller.exe"), session), "uninstaller");
  assert.equal(bridge.classify(path.join(out, "Trio-0.9.0-win-x64.exe"), session), "installer");
  assert.equal(bridge.classify(path.join(os.tmpdir(), "elevate-staging", "resources", "elevate.exe"), session), "skip");
  assert.throws(() => bridge.classify(path.join(out, "win-unpacked", "other.exe"), session), /unexpected file/);
  assert.throws(() => bridge.classify(path.join(out, "Trio-0.8.0-win-x64.exe"), session), /unexpected file/);
});

test("the hook waits for each signed file, in order, and puts it in place", async () => {
  const session = setup();
  const paths = bridge.expectedPaths(session);
  const sign = bridge.createSigner(session, { timeoutMs: 5000, pollMs: 5 });
  assert.equal(await sign(path.join(os.tmpdir(), "x", "elevate.exe")), "skipped");
  for (const role of bridge.ROLES) {
    const [result] = await Promise.all([sign(paths[role]), answer(session, role)]);
    assert.equal(result, role);
    assert.equal(fs.readFileSync(paths[role], "utf8"), `unsigned ${role} +sig`);
  }
});

test("out of order, a second hash, or a stale response is refused", async () => {
  const session = setup();
  const paths = bridge.expectedPaths(session);
  const sign = bridge.createSigner(session, { timeoutMs: 5000, pollMs: 5 });
  await assert.rejects(sign(paths.installer), /expected to sign app, got installer/);
  await assert.rejects(sign(paths.app, { hash: "sha1" }), /one sha256/);
  await assert.rejects(sign(paths.app, { isNest: true }), /one sha256/);

  const pending = sign(paths.app);
  let info: Request | null = null;
  while (!(info = await bridge.readRequest(session, "app"))) await new Promise((r) => setTimeout(r, 5));
  fs.mkdirSync(info.signedDirectory, { recursive: true });
  fs.writeFileSync(path.join(info.signedDirectory, info.file), "signed");
  const request = JSON.parse(fs.readFileSync(path.join(session.root, "app", "request.json"), "utf8"));
  fs.writeFileSync(
    path.join(session.root, "app", "response.json"),
    JSON.stringify({ nonce: "other-run", id: request.id, unsignedSha256: request.unsignedSha256, signedSha256: "x" }),
  );
  await assert.rejects(pending, /does not match its request/);
  assert.equal(fs.readFileSync(paths.app, "utf8"), "unsigned app", "the unsigned file stays in place");
});

test("accept refuses an unchanged file, a wrong name, or extra files from SignPath", async () => {
  const session = setup();
  const sign = bridge.createSigner(session, { timeoutMs: 300, pollMs: 5 });
  const pending = sign(bridge.expectedPaths(session).app).catch((e: Error) => e);
  let info: Request | null = null;
  while (!(info = await bridge.readRequest(session, "app"))) await new Promise((r) => setTimeout(r, 5));
  fs.mkdirSync(info.signedDirectory, { recursive: true });
  fs.copyFileSync(info.path, path.join(info.signedDirectory, info.file));
  await assert.rejects(bridge.writeResponse(session, "app"), /came back unchanged/);
  fs.writeFileSync(path.join(info.signedDirectory, "extra.dll"), "x");
  await assert.rejects(bridge.writeResponse(session, "app"), /expected exactly Trio.exe/);
  assert.match(String(await pending), /timed out/);
});

test("finish: latest.yml must carry the sha512 and size of the signed installer", async () => {
  const session = setup();
  const installer = bridge.expectedPaths(session).installer;
  const bytes = fs.readFileSync(installer);
  const sha512 = createHash("sha512").update(bytes).digest("base64");
  const yml = (hash: string, size: number) =>
    [
      "version: 0.9.0",
      "files:",
      "  - url: Trio-0.9.0-win-x64.exe",
      `    sha512: ${hash}`,
      `    size: ${size}`,
      "path: Trio-0.9.0-win-x64.exe",
      `sha512: ${hash}`,
      "releaseDate: '2026-11-20T00:00:00.000Z'",
      "",
    ].join("\n");
  fs.writeFileSync(path.join(session.output, "latest.yml"), yml(sha512, bytes.length));
  assert.equal((await bridge.checkUpdateMetadata(session)).sha512, sha512);
  fs.writeFileSync(path.join(session.output, "latest.yml"), yml("A".repeat(88), bytes.length));
  await assert.rejects(bridge.checkUpdateMetadata(session), /does not describe the signed installer/);
  fs.writeFileSync(path.join(session.output, "latest.yml"), yml(sha512, bytes.length + 1));
  await assert.rejects(bridge.checkUpdateMetadata(session), /does not describe the signed installer/);
});
