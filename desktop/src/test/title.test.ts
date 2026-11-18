import { test } from "node:test";
import assert from "node:assert/strict";
import { badgeText, parseUnread } from "../shared/title";

test("parses the leading (n)", () => {
  assert.equal(parseUnread("(3) Trio"), 3);
  assert.equal(parseUnread("(12) genel — Trio"), 12);
  assert.equal(parseUnread("  (1) Trio"), 1);
  assert.equal(parseUnread("(0) Trio"), 0);
});

test("anything else is zero", () => {
  assert.equal(parseUnread("Trio"), 0);
  assert.equal(parseUnread(""), 0);
  assert.equal(parseUnread(null), 0);
  assert.equal(parseUnread(undefined), 0);
  assert.equal(parseUnread("Trio (3)"), 0);
  assert.equal(parseUnread("(abc) Trio"), 0);
  assert.equal(parseUnread("(-2) Trio"), 0);
  assert.equal(parseUnread("(1234567) Trio"), 0);
});

test("badge text caps at 99+", () => {
  assert.equal(badgeText(0), "");
  assert.equal(badgeText(5), "5");
  assert.equal(badgeText(99), "99");
  assert.equal(badgeText(100), "99+");
});
