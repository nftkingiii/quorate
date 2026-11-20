// The sealing-secret backup (web/src/sealkey.ts): PBKDF2-SHA-256 then AES-256-GCM,
// with the operator, the network and the sealing key id bound in as additional data.
// Runs the browser module directly (Node strips the TypeScript types).
import { test } from "node:test";
import assert from "node:assert/strict";
import { MIN_PASSPHRASE, createSecret, exportBackup, importBackup } from "../web/src/sealkey.ts";

const OP = "qor1d29r40km6savysgcqm4zy6308ya2kljd8dcazm";
const OTHER = "qor1gxxaq0vznphf4jmhgkyhg8af0nzkqwfrl6a6qd";
const CHAIN = "qorechain-diana";
const PASS = "a long test passphrase";
const KEY_ID = "qor144tdxkmh9w6768dnej6tykwv9dnt2k3taemq0x:" + "ab".repeat(32);
const expect = { operator: OP, chainId: CHAIN };

const secret = createSecret();
const backup = await exportBackup(secret, { operator: OP, chainId: CHAIN, keyId: KEY_ID }, PASS);
const text = JSON.stringify(backup);

test("the backup restores the same secret and key id with the right passphrase", async () => {
  const r = await importBackup(text, PASS, expect);
  assert.deepEqual(Buffer.from(r.secret), Buffer.from(secret));
  assert.equal(r.keyId, KEY_ID);
});

test("the backup holds no secret in clear", () => {
  assert.equal(backup.kdf.rounds, 600000);
  assert.equal(Buffer.from(backup.cipher.data, "base64").length, 48, "32-byte secret + 16-byte GCM tag");
  assert.ok(!text.includes(Buffer.from(secret).toString("base64")));
  assert.ok(!text.includes(Buffer.from(secret).toString("hex")));
});

test("a wrong passphrase is refused", async () => {
  await assert.rejects(importBackup(text, "not the passphrase", expect), /Wrong passphrase/);
});

test("a changed ciphertext is refused", async () => {
  const b = structuredClone(backup);
  const data = Buffer.from(b.cipher.data, "base64");
  data[0] ^= 1;
  b.cipher.data = data.toString("base64");
  await assert.rejects(importBackup(JSON.stringify(b), PASS, expect), /Wrong passphrase, or the file was changed/);
});

test("a backup relabelled with another key id is refused (bound as additional data)", async () => {
  const b = { ...backup, keyId: "qor1x:" + "00".repeat(32) };
  await assert.rejects(importBackup(JSON.stringify(b), PASS, expect), /Wrong passphrase, or the file was changed/);
});

test("a backup for another operator or network is refused before decrypting", async () => {
  await assert.rejects(importBackup(text, PASS, { operator: OTHER, chainId: CHAIN }), /belongs to/);
  await assert.rejects(importBackup(text, PASS, { operator: OP, chainId: "qorechain-vladi" }), /is for qorechain-diana/);
});

test("a backup relabelled to another operator fails decryption (bound as additional data)", async () => {
  const b = { ...backup, operator: OTHER };
  await assert.rejects(importBackup(JSON.stringify(b), PASS, { operator: OTHER, chainId: CHAIN }), /Wrong passphrase, or the file was changed/);
});

test("old-format, malformed and unexpected backups are refused with a clear reason", async () => {
  await assert.rejects(importBackup(JSON.stringify({ format: "quorate-sealing-key/1" }), PASS, expect), /earlier Quorate version/);
  await assert.rejects(importBackup(JSON.stringify({ ...backup, kdf: { ...backup.kdf, rounds: 1 } }), PASS, expect), /unexpected settings/);
  await assert.rejects(importBackup("not json", PASS, expect), /not a Quorate sealing-key backup/);
  await assert.rejects(importBackup(JSON.stringify({ format: "other" }), PASS, expect), /not a Quorate sealing-key backup/);
});

test("short passphrases and wrong-size secrets are refused when creating a backup", async () => {
  await assert.rejects(exportBackup(secret, { operator: OP, chainId: CHAIN, keyId: KEY_ID }, "x".repeat(MIN_PASSPHRASE - 1)), /at least/);
  await assert.rejects(exportBackup(new Uint8Array(16), { operator: OP, chainId: CHAIN, keyId: KEY_ID }, PASS), /32 bytes/);
});

test("two backups of the same secret use different salts and nonces", async () => {
  const again = await exportBackup(secret, { operator: OP, chainId: CHAIN, keyId: KEY_ID }, PASS);
  assert.notEqual(again.kdf.salt, backup.kdf.salt);
  assert.notEqual(again.cipher.iv, backup.cipher.iv);
});
