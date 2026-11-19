// Account reads (lib/accounts.mjs) against a chain that answers, refuses or
// times out. The rule under test: a failed read must never look like
// "no encryption key registered".
import { test } from "node:test";
import assert from "node:assert/strict";
import { isQorAddress, readAccount } from "../lib/accounts.mjs";
import { sha3 } from "../lib/protocol.mjs";

const ADDR = "qor1d29r40km6savysgcqm4zy6308ya2kljd8dcazm";
const REST = "https://rest.test";
const KEY = Buffer.from("an ML-KEM public key, for the test").toString("base64");

function chain(overrides = {}) {
  const answers = {
    account: { found: true, account: { key_type: "hybrid", possession_proven: true } },
    kem: { found: true, key: { public_key: KEY } },
    balances: { balances: [{ denom: "uqor", amount: "2895000" }] },
    ...overrides,
  };
  return async (url) => {
    const kind = url.includes("/pqc/v1/account/") ? "account" : url.includes("/pqc/v1/kem/") ? "kem" : "balances";
    const a = answers[kind];
    if (a instanceof Error) throw a;
    return a;
  };
}

test("a healthy read reports both keys and the key's fingerprint", async () => {
  const r = await readAccount(chain(), REST, ADDR);
  assert.deepEqual(r.signingKey, { type: "hybrid", possessionProven: true });
  assert.equal(r.encryptionKey.found, true);
  assert.equal(r.encryptionKey.publicKeySha3, sha3(Buffer.from(KEY, "base64")));
  assert.equal(r.balanceUqor, "2895000");
});

test("an account with no encryption key reads as found: false only when the chain says so", async () => {
  const r = await readAccount(chain({ kem: { found: false, key: null } }), REST, ADDR);
  assert.deepEqual(r.encryptionKey, { found: false, publicKeySha3: null });
});

test("a failed encryption-key read throws instead of reporting no key", async () => {
  await assert.rejects(readAccount(chain({ kem: new Error("ECONNRESET") }), REST, ADDR), /Could not read this account/);
});

test("a failed signing-key read throws too", async () => {
  await assert.rejects(readAccount(chain({ account: new Error("timeout") }), REST, ADDR), /Could not read this account/);
});

test("a failed balance read still returns the keys, with the balance unknown", async () => {
  const r = await readAccount(chain({ balances: new Error("timeout") }), REST, ADDR);
  assert.equal(r.balanceUqor, null);
  assert.equal(r.encryptionKey.found, true);
});

test("only lower-case 20-byte qor1 addresses are accepted", () => {
  assert.equal(isQorAddress(ADDR), true);
  assert.equal(isQorAddress(ADDR.toUpperCase()), false);
  assert.equal(isQorAddress("qorvaloper1gyvjym2qmf4fckpn68ehkwj9yr30eelpqr8vj2"), false, "operator address, not an account");
  assert.equal(isQorAddress(ADDR.slice(0, -1) + "q"), false, "bad checksum");
  assert.equal(isQorAddress("../../etc/passwd"), false);
  assert.equal(isQorAddress(""), false);
});
