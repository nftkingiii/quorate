// The sealing-key backup (web/src/sealkey.ts): PBKDF2-SHA-256 then AES-256-GCM,
// with the account and key fingerprint bound in as additional data.
// Runs the browser module directly (Node strips the TypeScript types).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSealKey, exportBackup, importBackup, keyFingerprint, MIN_PASSPHRASE } from "../web/src/sealkey.ts";

const ADDR = "qor1d29r40km6savysgcqm4zy6308ya2kljd8dcazm";
const OTHER = "qor1gxxaq0vznphf4jmhgkyhg8af0nzkqwfrl6a6qd";
const CHAIN = "qorechain-diana";
const PASS = "a long test passphrase";
const expect = { address: ADDR, chainId: CHAIN };

const keys = createSealKey();
const backup = await exportBackup(keys, ADDR, CHAIN, PASS);
const text = JSON.stringify(backup);

test("the backup restores the same key with the right passphrase", async () => {
  const k = await importBackup(text, PASS, expect);
  assert.equal(keyFingerprint(k), keyFingerprint(keys));
  assert.deepEqual(Buffer.from(k.mlkemSecretKey), Buffer.from(keys.mlkemSecretKey));
});

test("the backup holds no key material in clear", () => {
  assert.equal(backup.kdf.rounds, 600000);
  assert.equal(Buffer.from(backup.cipher.data, "base64").length, 48, "32-byte seed + 16-byte GCM tag");
  assert.ok(!text.includes(Buffer.from(keys.seed).toString("base64")));
  assert.ok(!text.includes(Buffer.from(keys.seed).toString("hex")));
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

test("a backup relabelled with another key fingerprint is refused (bound as additional data)", async () => {
  const b = { ...backup, publicKeySha3: "00".repeat(32) };
  await assert.rejects(importBackup(JSON.stringify(b), PASS, expect), /Wrong passphrase, or the file was changed/);
});

test("a backup for another account or network is refused before decrypting", async () => {
  await assert.rejects(importBackup(text, PASS, { address: OTHER, chainId: CHAIN }), /belongs to/);
  await assert.rejects(importBackup(text, PASS, { address: ADDR, chainId: "qorechain-vladi" }), /is for qorechain-diana/);
});

test("a backup relabelled to another account fails decryption (bound as additional data)", async () => {
  const b = { ...backup, address: OTHER };
  await assert.rejects(importBackup(JSON.stringify(b), PASS, { address: OTHER, chainId: CHAIN }), /Wrong passphrase, or the file was changed/);
});

test("unexpected KDF settings and non-backup files are refused", async () => {
  await assert.rejects(importBackup(JSON.stringify({ ...backup, kdf: { ...backup.kdf, rounds: 1 } }), PASS, expect), /unexpected settings/);
  await assert.rejects(importBackup("not json", PASS, expect), /not a Quorate sealing-key backup/);
  await assert.rejects(importBackup(JSON.stringify({ format: "other" }), PASS, expect), /not a Quorate sealing-key backup/);
});

test("short passphrases are refused when creating a backup", async () => {
  await assert.rejects(exportBackup(keys, ADDR, CHAIN, "x".repeat(MIN_PASSPHRASE - 1)), /at least/);
});

test("two backups of the same key use different salts and nonces", async () => {
  const again = await exportBackup(keys, ADDR, CHAIN, PASS);
  assert.notEqual(again.kdf.salt, backup.kdf.salt);
  assert.notEqual(again.cipher.iv, backup.cipher.iv);
});
