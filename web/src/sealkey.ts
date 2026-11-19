// The operator's ML-KEM-1024 sealing key. QoreX cannot hold or use an
// encryption key, so the page creates one, keeps it in memory only (never
// localStorage, never the server) and gives the operator an encrypted backup.
//
// Backup: PBKDF2-SHA-256 (600,000 rounds) derives an AES-256-GCM key from the
// passphrase; the 32-byte QoreSeal seed is the plaintext. The account address
// and the public-key hash are bound in as additional data, so a backup cannot
// be passed off for another account or key.
import { sealKeysFromSeed } from "@qorechain/qoreseal";
import type { SealKeyPair } from "@qorechain/qoreseal";
import { sha3_256 } from "@noble/hashes/sha3.js";

export const BACKUP_FORMAT = "quorate-sealing-key/1";
const ROUNDS = 600_000;
const enc = new TextEncoder();
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const b64 = (b: Uint8Array) => btoa(Array.from(b, (x) => String.fromCharCode(x)).join(""));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export type Backup = {
  format: typeof BACKUP_FORMAT; chainId: string; address: string;
  publicKeySha3: string; kdf: { name: "PBKDF2-SHA-256"; rounds: number; salt: string };
  cipher: { name: "AES-256-GCM"; iv: string; data: string };
};

export const keyFingerprint = (k: SealKeyPair) => hex(sha3_256(k.mlkemPublicKey));
export const MIN_PASSPHRASE = 12;

export function createSealKey(): SealKeyPair {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const keys = sealKeysFromSeed(seed);
  seed.fill(0);
  return keys;
}

async function aesKey(passphrase: string, salt: Uint8Array, rounds: number) {
  const base = await crypto.subtle.importKey("raw", enc.encode(passphrase.normalize("NFKC")), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: rounds }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
const aad = (chainId: string, address: string, fp: string) => enc.encode(`${BACKUP_FORMAT}|${chainId}|${address}|${fp}`);

export async function exportBackup(keys: SealKeyPair, address: string, chainId: string, passphrase: string): Promise<Backup> {
  if (passphrase.length < MIN_PASSPHRASE) throw new Error(`Use a passphrase of at least ${MIN_PASSPHRASE} characters`);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const fp = keyFingerprint(keys);
  const key = await aesKey(passphrase, salt, ROUNDS);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(chainId, address, fp) }, key, keys.seed));
  return {
    format: BACKUP_FORMAT, chainId, address, publicKeySha3: fp,
    kdf: { name: "PBKDF2-SHA-256", rounds: ROUNDS, salt: b64(salt) },
    cipher: { name: "AES-256-GCM", iv: b64(iv), data: b64(data) },
  };
}

export async function importBackup(text: string, passphrase: string, expect: { address: string; chainId: string }): Promise<SealKeyPair> {
  let b: Backup;
  try { b = JSON.parse(text); } catch { throw new Error("That file is not a Quorate sealing-key backup"); }
  if (b.format !== BACKUP_FORMAT) throw new Error("That file is not a Quorate sealing-key backup");
  if (b.address !== expect.address) throw new Error(`This backup belongs to ${b.address}, not the connected account`);
  if (b.chainId !== expect.chainId) throw new Error(`This backup is for ${b.chainId}`);
  if (!(b.kdf.rounds >= 100_000 && b.kdf.rounds <= 5_000_000)) throw new Error("This backup uses unexpected settings");
  let seed: Uint8Array;
  try {
    const key = await aesKey(passphrase, fromB64(b.kdf.salt), b.kdf.rounds);
    seed = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(b.cipher.iv), additionalData: aad(b.chainId, b.address, b.publicKeySha3) }, key, fromB64(b.cipher.data)));
  } catch {
    throw new Error("Wrong passphrase, or the file was changed");
  }
  const keys = sealKeysFromSeed(seed);
  seed.fill(0);
  if (keyFingerprint(keys) !== b.publicKeySha3) throw new Error("The backup does not match its own key");
  return keys;
}

export function downloadJson(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2) + "\n"], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const fromBase64 = fromB64;
export const toHex = hex;
