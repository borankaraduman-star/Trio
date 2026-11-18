import { test } from "node:test";
import assert from "node:assert/strict";
import { checkHealth, type Fetcher } from "../main/health";

const answer = (status: number, body: unknown): Fetcher => async () => ({
  status,
  json: async () => {
    if (body instanceof Error) throw body;
    return body;
  },
});

test("200 {ok: true} passes and the right URL is asked", async () => {
  let asked = "";
  const r = await checkHealth("https://trio.example.com", async (url) => {
    asked = url;
    return { status: 200, json: async () => ({ ok: true }) };
  });
  assert.deepEqual(r, { ok: true });
  assert.equal(asked, "https://trio.example.com/api/health");
});

test("other answers fail with a Turkish message", async () => {
  for (const f of [answer(404, {}), answer(200, { ok: false }), answer(200, new Error("not json")), answer(200, null)]) {
    const r = await checkHealth("https://x.example", f);
    assert.equal(r.ok, false);
  }
  const down = await checkHealth("https://x.example", async () => {
    throw new Error("ECONNREFUSED");
  });
  assert.ok(!down.ok && down.message.includes("ulaşılamadı"));
});

test("a timeout aborts", async () => {
  const r = await checkHealth(
    "https://x.example",
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    20,
  );
  assert.ok(!r.ok && r.message.includes("zamanında"));
});
