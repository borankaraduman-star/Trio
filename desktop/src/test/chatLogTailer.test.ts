import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ChatLogTailer } from "../main/chatLogTailer";

const SECRET = "SECRET-CHAT-1234";
const frame = (seq: number) => `TRIO1;${seq};1800000000;Kahve Kokusu;;37;ROGUE;Orgrimmar;;beat`;

function setup(backlog?: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trio-tail-"));
  const file = path.join(dir, "WoWChatLog.txt");
  const got: string[] = [];
  const tailer = new ChatLogTailer(file, (f) => got.push(f), backlog);
  return { dir, file, got, tailer };
}

test("a missing file is a state, not an error; it is read from the top when it appears", async () => {
  const { file, got, tailer } = setup();
  await tailer.poll();
  assert.equal(tailer.info.state, "missing");
  await tailer.poll();
  fs.writeFileSync(file, `11/19 21:00:00.000  To Kahve Kokusu: ${frame(1)}\n`);
  await tailer.poll();
  // The file appeared after the first look: the first look already happened
  // with nothing there, so a NEW file starts at 0? The first successful stat
  // is the first look: it starts near the end, within the backlog.
  assert.deepEqual(got, [frame(1)]);
  assert.equal(tailer.info.state, "ok");
});

test("appends are followed; only TRIO1 frames come out; other chat never does", async () => {
  const { file, got, tailer } = setup();
  fs.writeFileSync(file, "");
  await tailer.poll();
  fs.appendFileSync(file, `11/19 21:00:01.000  [2. Trade] Ali: ${SECRET} wts\n`);
  fs.appendFileSync(file, `11/19 21:00:02.000  Kahve Kokusu whispers: ${frame(2)}\r\n`);
  fs.appendFileSync(file, `11/19 21:00:03.000  [Guild] Veli: hello ${SECRET}\n`);
  await tailer.poll();
  assert.deepEqual(got, [frame(2)]);
  assert.ok(!JSON.stringify(got).includes(SECRET));
  assert.ok(!JSON.stringify(tailer.info).includes(SECRET));
});

test("a partial last line waits for its newline", async () => {
  const { file, got, tailer } = setup();
  fs.writeFileSync(file, "");
  await tailer.poll();
  const full = `x  To K: ${frame(3)}\n`;
  fs.appendFileSync(file, full.slice(0, 25));
  await tailer.poll();
  assert.deepEqual(got, []);
  fs.appendFileSync(file, full.slice(25));
  await tailer.poll();
  assert.deepEqual(got, [frame(3)]);
});

test("a multi-byte character split across reads is decoded whole", async () => {
  const { file, got, tailer } = setup();
  fs.writeFileSync(file, "");
  await tailer.poll();
  const line = Buffer.from("TRIO1;4;1800000000;Işıl;;1;MAGE;Gölge;;beat\n", "utf8");
  const cut = line.indexOf(0xc4) + 1; // inside "ş"? inside the first two-byte char
  fs.appendFileSync(file, line.subarray(0, cut));
  await tailer.poll();
  fs.appendFileSync(file, line.subarray(cut));
  await tailer.poll();
  assert.deepEqual(got, ["TRIO1;4;1800000000;Işıl;;1;MAGE;Gölge;;beat"]);
});

test("a BOM at the start is skipped", async () => {
  const { file, got, tailer } = setup();
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${frame(5)}\n`)]));
  await tailer.poll();
  assert.deepEqual(got, [frame(5)]);
});

test("truncation (the game restarted) reads the new content from the top", async () => {
  const { file, got, tailer } = setup();
  fs.writeFileSync(file, `${"a".repeat(500)}\n${frame(6)}\n`);
  await tailer.poll();
  assert.deepEqual(got, [frame(6)]);
  fs.truncateSync(file, 0);
  fs.appendFileSync(file, `${frame(7)}\n`);
  await tailer.poll();
  assert.deepEqual(got, [frame(6), frame(7)]);
});

test("rotation (replaced by a new file) starts over even when it is larger", async () => {
  const { file, got, tailer, dir } = setup();
  fs.writeFileSync(file, `${frame(8)}\n`);
  await tailer.poll();
  const next = path.join(dir, "new.txt");
  fs.writeFileSync(next, `${frame(9)}\n${"b".repeat(200)}\n${frame(10)}\n`);
  fs.renameSync(file, path.join(dir, "old.txt"));
  fs.renameSync(next, file);
  await tailer.poll();
  assert.deepEqual(got, [frame(8), frame(9), frame(10)]);
});

test("the file disappearing and coming back reads the new one from the top", async () => {
  const { file, got, tailer } = setup();
  fs.writeFileSync(file, `${frame(11)}\n`);
  await tailer.poll();
  fs.unlinkSync(file);
  await tailer.poll();
  assert.equal(tailer.info.state, "missing");
  fs.writeFileSync(file, `${frame(12)}\n`);
  await tailer.poll();
  assert.deepEqual(got, [frame(11), frame(12)]);
});

test("a huge existing file: only its end is read, and a cut first line is dropped", async () => {
  const { file, got, tailer } = setup(4096);
  const old = `${frame(1)}\n`.repeat(2000); // ~120 KB of old frames
  fs.writeFileSync(file, `${old}${frame(99)}\n`);
  const started = Date.now();
  await tailer.poll();
  assert.ok(Date.now() - started < 2000);
  assert.ok(got.length < 100, `read ${got.length} lines, not the whole file`);
  assert.equal(got[got.length - 1], frame(99));
  assert.ok(got.every((g) => g.startsWith("TRIO1;")), "no line fragment emitted");
  assert.ok(got.every((g) => g.split(";").length === 10), "no half line");
});

test("a very long line without a newline is dropped, not buffered forever", async () => {
  const { file, got, tailer } = setup();
  fs.writeFileSync(file, "");
  await tailer.poll();
  fs.appendFileSync(file, "z".repeat(200 * 1024));
  await tailer.poll();
  fs.appendFileSync(file, `tail ${frame(13)}\n${frame(14)}\n`);
  await tailer.poll();
  assert.deepEqual(got, [frame(14)]);
});
