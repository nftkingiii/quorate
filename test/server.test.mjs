// The read-only server's guard rails, over real HTTP. Only routes that answer
// without the chain are tested here, so the suite runs offline.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
let proc;

before(async () => {
  proc = spawn(process.execPath, [fileURLToPath(new URL("../server/index.mjs", import.meta.url))], {
    env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"],
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${BASE}/api/health`); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error("server did not start");
});
after(() => proc?.kill());

test("only GET and HEAD are answered, except POST to the relay", async () => {
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const res = await fetch(`${BASE}/api/quorum`, { method });
    assert.equal(res.status, 405, method);
  }
  for (const method of ["PUT", "DELETE"]) assert.equal((await fetch(`${BASE}/api/relay`, { method })).status, 405, method);
});

test("the relay refuses anything that is not a sealing-account transaction, without contacting the chain", async () => {
  const post = (body, type = "application/json") => fetch(`${BASE}/api/relay`, { method: "POST", headers: { "content-type": type }, body });
  assert.equal((await post("{}", "text/plain")).status, 415);
  assert.equal((await post("not json")).status, 400);
  assert.equal((await post(JSON.stringify({ txBytes: "!!!" }))).status, 400);
  const garbage = await post(JSON.stringify({ txBytes: Buffer.from("hello").toString("base64") }));
  assert.equal(garbage.status, 400);
  assert.match((await garbage.json()).error, /^Refused: /);
  assert.equal((await post("x".repeat(64 * 1024))).status, 413, "oversized body");
});

test("transaction status lookups validate the hash", async () => {
  assert.equal((await fetch(`${BASE}/api/tx?hash=nothex`)).status, 400);
  assert.equal((await fetch(`${BASE}/api/tx?hash=${"G".repeat(64)}`)).status, 400);
});

test("advisory files: only the allow-listed names, nothing else in the project", async () => {
  assert.equal((await fetch(`${BASE}/advisories/epoch-1.json`)).status, 200);
  assert.equal((await fetch(`${BASE}/advisories/QSA-001.blob`)).status, 200);
  for (const p of ["/advisories/..%2fpackage.json", "/advisories/..%2f.keys%2faccounts.json", "/advisories/%2e%2e/.keys/accounts.json", "/advisories/epoch-1.json.bak", "/advisories/.gitattributes"]) {
    const res = await fetch(`${BASE}${p}`);
    const body = await res.text();
    assert.ok(!/mnemonic/.test(body), `${p} leaked key material`);
    assert.notEqual(res.headers.get("content-type"), "application/octet-stream", `${p} served a file`);
  }
});

test("paths outside the app never reach the project folder", async () => {
  for (const p of ["/../.keys/accounts.json", "/%2e%2e/.keys/accounts.json", "/..%5c.keys%5caccounts.json", "/.keys/accounts.json", "/package.json", "/server/index.mjs"]) {
    const body = await (await fetch(`${BASE}${p}`)).text();
    assert.ok(!/mnemonic|"dependencies"|createServer/.test(body), `${p} leaked a project file`);
  }
});

test("folders and unknown paths get the app shell, never an error with internal details", async () => {
  for (const p of ["/assets/", "/assets", "/web", "/does/not/exist"]) {
    const res = await fetch(`${BASE}${p}`);
    assert.ok(res.status === 200 || res.status === 503, `${p} -> ${res.status}`); // 503 only when the app is not built
    const body = await res.text();
    assert.ok(!/EISDIR|ENOENT|node:internal|\/home\/|C:\\\\/.test(body), `${p} leaked an internal detail`);
  }
});

test("bad parameters are refused before touching the chain", async () => {
  assert.equal((await fetch(`${BASE}/api/roster?set=evil`)).status, 400);
  for (const a of ["", "QOR1D29R40KM6SAVYSGCQM4ZY6308YA2KLJD8DCAZM", "qor1x", "qorvaloper1gyvjym2qmf4fckpn68ehkwj9yr30eelpqr8vj2", "../etc"]) {
    assert.equal((await fetch(`${BASE}/api/account?address=${encodeURIComponent(a)}`)).status, 400, a);
  }
  assert.equal((await fetch(`${BASE}/api/nope`)).status, 404);
});

test("security headers are set", async () => {
  const res = await fetch(`${BASE}/api/health`);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.match(res.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});
