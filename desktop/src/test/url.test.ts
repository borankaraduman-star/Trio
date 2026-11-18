import { test } from "node:test";
import assert from "node:assert/strict";
import { isExternalOpenable, isSameOrigin, originOf, validateServerUrl } from "../shared/url";

const ok = (input: string) => {
  const r = validateServerUrl(input);
  assert.ok(r.ok, `${input} should be accepted`);
  return r.origin;
};
const reason = (input: string) => {
  const r = validateServerUrl(input);
  assert.ok(!r.ok, `${input} should be rejected`);
  return r.reason;
};

test("https is accepted and reduced to its origin", () => {
  assert.equal(ok("https://trio.up.railway.app"), "https://trio.up.railway.app");
  assert.equal(ok("https://trio.up.railway.app/"), "https://trio.up.railway.app");
  assert.equal(ok("  https://Trio.Example.com:8443/some/path?q=1#x "), "https://trio.example.com:8443");
  assert.equal(ok("https://trio.example.com:443"), "https://trio.example.com");
});

test("a bare host is read as https", () => {
  assert.equal(ok("trio.up.railway.app"), "https://trio.up.railway.app");
});

test("http only for loopback", () => {
  assert.equal(ok("http://localhost:8000"), "http://localhost:8000");
  assert.equal(ok("http://localhost:5173/"), "http://localhost:5173");
  assert.equal(ok("http://127.0.0.1:8000"), "http://127.0.0.1:8000");
  assert.equal(ok("http://[::1]:8000"), "http://[::1]:8000");
  assert.equal(reason("http://trio.example.com"), "insecure");
  assert.equal(reason("http://192.168.1.10:8000"), "insecure");
  assert.equal(reason("http://localhost.evil.com"), "insecure");
  assert.equal(reason("http://127.0.0.2"), "insecure");
});

test("other schemes, credentials and junk are refused", () => {
  assert.equal(reason(""), "empty");
  assert.equal(reason("   "), "empty");
  assert.equal(reason("ftp://trio.example.com"), "scheme");
  assert.equal(reason("file:///etc/passwd"), "scheme");
  assert.equal(reason("javascript://alert(1)"), "scheme");
  assert.equal(reason("trio-app://local/connect.html"), "scheme");
  assert.equal(reason("https://user:pw@trio.example.com"), "credentials");
  assert.equal(reason("https://"), "malformed");
  assert.equal(reason("https://exa mple.com"), "malformed");
});

test("originOf handles web origins, the local scheme and junk", () => {
  assert.equal(originOf("https://trio.example.com/channels/1"), "https://trio.example.com");
  assert.equal(originOf("http://localhost:5173/x"), "http://localhost:5173");
  assert.equal(originOf("trio-app://local/connect.html"), "trio-app://local");
  assert.equal(originOf("file:///tmp/x.html"), null);
  assert.equal(originOf("about:blank"), null);
  assert.equal(originOf("not a url"), null);
  assert.equal(originOf(""), null);
  assert.equal(originOf(null), null);
});

test("isSameOrigin is exact on scheme, host and port", () => {
  const o = "https://trio.example.com";
  assert.ok(isSameOrigin("https://trio.example.com/api/health", o));
  assert.ok(isSameOrigin("https://trio.example.com/", o)); // Electron's requestingOrigin form
  assert.ok(!isSameOrigin("http://trio.example.com/", o));
  assert.ok(!isSameOrigin("https://trio.example.com:8443/", o));
  assert.ok(!isSameOrigin("https://evil.trio.example.com/", o));
  assert.ok(!isSameOrigin("https://trio.example.com.evil.com/", o));
  assert.ok(!isSameOrigin("https://trio.example.com/", null));
  assert.ok(isSameOrigin("trio-app://local/picker.html", "trio-app://local"));
  assert.ok(!isSameOrigin("trio-app://other/picker.html", "trio-app://local"));
});

test("only web and mail links go to the system browser", () => {
  assert.ok(isExternalOpenable("https://example.com"));
  assert.ok(isExternalOpenable("http://example.com"));
  assert.ok(isExternalOpenable("mailto:a@example.com"));
  assert.ok(!isExternalOpenable("file:///etc/passwd"));
  assert.ok(!isExternalOpenable("smb://host/share"));
  assert.ok(!isExternalOpenable("javascript:alert(1)"));
  assert.ok(!isExternalOpenable("nonsense"));
});
