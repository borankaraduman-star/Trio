import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Fetcher } from "../main/health";
import { checkNext, cleanCode, moveUrl, verifyMove, verifyNextStore } from "../main/serverMove";
import { ConfigStore } from "../main/config";

const OLD = "https://trio-production-8a183220.up.railway.app";
const NEW = "https://trio.example.org";
const CODE = "K7QX3MZ9PA";

/** A fake network: origin → the /api/health body (or a status / a throw). */
function network(answers: Record<string, unknown>, asked: string[] = []): Fetcher {
  return async (url) => {
    asked.push(url);
    const origin = url.replace(/\/api\/health$/, "");
    if (!(origin in answers)) throw new Error("ECONNREFUSED");
    const body = answers[origin];
    if (typeof body === "number") return { status: body, json: async () => ({}) };
    return { status: 200, json: async () => body };
  };
}

test("a hostile page cannot move the shell to an address the trusted server did not declare", async () => {
  const asked: string[] = [];
  const fetcher = network({ [OLD]: { ok: true, public_url: NEW }, "https://evil.example": { ok: true, public_url: "https://evil.example" } }, asked);
  const r = await verifyMove(OLD, { origin: "https://evil.example", code: CODE }, fetcher);
  assert.deepEqual(r, { ok: false, reason: "not-declared" });
  // The evil host was never even asked.
  assert.deepEqual(asked, [`${OLD}/api/health`]);
});

test("the declared canonical address is accepted once it answers as Trio", async () => {
  const fetcher = network({ [OLD]: { ok: true, public_url: NEW }, [NEW]: { ok: true, public_url: NEW } });
  assert.deepEqual(await verifyMove(OLD, { origin: NEW, code: "k7qx3-mz9pa" }, fetcher), { ok: true, origin: NEW, code: CODE });
  assert.equal(moveUrl(NEW, CODE), `${NEW}/#tasi=${CODE}`);
});

test("refusals: bad input, unreachable, not a Trio server, a server that disagrees", async () => {
  const good = { [OLD]: { ok: true, public_url: NEW } };
  for (const request of [
    { origin: `${NEW}/path`, code: CODE },
    { origin: "javascript:alert(1)", code: CODE },
    { origin: NEW, code: "0000000000" },
    { origin: NEW, code: `${CODE}#x` },
    { origin: OLD, code: CODE },
    {},
  ]) {
    assert.deepEqual(await verifyMove(OLD, request, network({ ...good, [NEW]: { ok: true, public_url: NEW } })), { ok: false, reason: "invalid" });
  }
  assert.deepEqual(await verifyMove(null, { origin: NEW, code: CODE }, network(good)), { ok: false, reason: "invalid" });
  assert.deepEqual(await verifyMove(OLD, { origin: NEW, code: CODE }, network(good)), { ok: false, reason: "unreachable" });
  assert.deepEqual(await verifyMove(OLD, { origin: NEW, code: CODE }, network({ ...good, [NEW]: 404 })), { ok: false, reason: "unreachable" });
  assert.deepEqual(
    await verifyMove(OLD, { origin: NEW, code: CODE }, network({ ...good, [NEW]: { ok: true, public_url: "https://other.example" } })),
    { ok: false, reason: "not-trio" },
  );
  assert.deepEqual(await verifyMove(OLD, { origin: NEW, code: CODE }, network({ [OLD]: { ok: true } })), { ok: false, reason: "not-declared" });
});

test("a next code is kept only for the address the current server announced", async () => {
  const now = Date.parse("2026-11-20T12:00:00Z");
  const expiresAt = "2026-11-27T12:00:00.000Z";
  const fetcher = network({ [OLD]: { ok: true, next_url: NEW } });
  const r = await verifyNextStore(OLD, { origin: NEW, code: CODE, expiresAt }, fetcher, now);
  assert.deepEqual(r, { ok: true, next: { origin: NEW, code: CODE, expiresAt: Date.parse(expiresAt) } });
  assert.deepEqual(await verifyNextStore(OLD, { origin: "https://evil.example", code: CODE, expiresAt }, fetcher, now), {
    ok: false,
    reason: "not-declared",
  });
  assert.deepEqual(await verifyNextStore(OLD, { origin: NEW, code: CODE, expiresAt: "2026-11-01T00:00:00Z" }, fetcher, now), {
    ok: false,
    reason: "invalid",
  });
  // A page that claims a year is held to the server's week.
  const long = await verifyNextStore(OLD, { origin: NEW, code: CODE, expiresAt: "2027-11-20T00:00:00Z" }, fetcher, now);
  assert.ok(long.ok && long.next.expiresAt <= now + 8 * 24 * 3600 * 1000);
});

test("after the rename: the remembered next address is used only when it says it is that address", async () => {
  const now = 1_000;
  const next = { origin: NEW, code: CODE, expiresAt: now + 10_000 };
  assert.deepEqual(await checkNext(next, network({ [NEW]: { ok: true, next_url: NEW } }), now), { ok: true, origin: NEW, code: CODE });
  assert.deepEqual(await checkNext(next, network({ [NEW]: { ok: true, public_url: NEW } }), now), { ok: true, origin: NEW, code: CODE });
  assert.deepEqual(await checkNext(next, network({}), now), { ok: false, reason: "unreachable" });
  assert.deepEqual(await checkNext(next, network({ [NEW]: { ok: true } }), now), { ok: false, reason: "not-trio" });
  assert.deepEqual(await checkNext({ ...next, expiresAt: now }, network({ [NEW]: { ok: true, next_url: NEW } }), now), {
    ok: false,
    reason: "invalid",
  });
  assert.deepEqual(await checkNext(null, network({}), now), { ok: false, reason: "invalid" });
  assert.equal(cleanCode("abc"), null);
});

test("the config keeps the next code beside the server and forgets it on a change of server", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trio-cfg-"));
  const store = new ConfigStore(dir);
  store.setServerOrigin(OLD);
  store.setNextMove({ origin: NEW, code: CODE, expiresAt: 5 });
  assert.equal(store.getServerOrigin(), OLD);
  assert.deepEqual(store.getNextMove(), { origin: NEW, code: CODE, expiresAt: 5 });
  store.setServerOrigin(NEW);
  assert.equal(store.getNextMove(), null);
  assert.equal(store.getServerOrigin(), NEW);
  fs.rmSync(dir, { recursive: true });
});
