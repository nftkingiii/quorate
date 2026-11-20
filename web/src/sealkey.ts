// The operator's sealing secret: 32 bytes from which the page derives the
// sealing account and its ML-KEM-1024 key (see sealer.ts). It lives in page
// memory only (never localStorage, never the server); the operator keeps an
// encrypted backup.
//
// Backup: PBKDF2-SHA-256 (600,000 rounds) derives an AES-256-GCM key from the
// passphrase; the secret is the plaintext. The operator address, the network
// and the sealing account's key id are bound in as additional data, so a backup
// cannot be passed off for another account or key.
import type { SealKeyPair } from "@qorechain/qoreseal";
import { sha3_256 } from "@noble/hashes/sha3.js";

export const BACKUP_FORMAT = "quorate-sealing-key/2";
const ROUNDS = 600_000;
const enc = new TextEncoder();
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const b64 = (b: Uint8Array) => btoa(Array.from(b, (x) => String.fromCharCode(x)).join(""));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export type Backup = {
  format: typeof BACKUP_FORMAT; chainId: string; operator: string;
  /** The sealing account address and the SHA3-256 of its ML-KEM public key, "qor1...:hex". */
  keyId: string;
  kdf: { name: "PBKDF2-SHA-256"; rounds: number; salt: string };
  cipher: { name: "AES-256-GCM"; iv: string; data: string };
};

export const keyFingerprint = (k: SealKeyPair) => hex(sha3_256(k.mlkemPublicKey));
export const MIN_PASSPHRASE = 12;

export function createSecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

async function aesKey(passphrase: string, salt: Uint8Array, rounds: number) {
  const base = await crypto.subtle.importKey("raw", enc.encode(passphrase.normalize("NFKC")), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: rounds }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
const aad = (chainId: string, operator: string, keyId: string) => enc.encode(`${BACKUP_FORMAT}|${chainId}|${operator}|${keyId}`);

export async function exportBackup(secret: Uint8Array, bind: { operator: string; chainId: string; keyId: string }, passphrase: string): Promise<Backup> {
  if (secret.length !== 32) throw new Error("The sealing secret must be 32 bytes");
  if (passphrase.length < MIN_PASSPHRASE) throw new Error(`Use a passphrase of at least ${MIN_PASSPHRASE} characters`);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(passphrase, salt, ROUNDS);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(bind.chainId, bind.operator, bind.keyId) }, key, secret));
  return {
    format: BACKUP_FORMAT, chainId: bind.chainId, operator: bind.operator, keyId: bind.keyId,
    kdf: { name: "PBKDF2-SHA-256", rounds: ROUNDS, salt: b64(salt) },
    cipher: { name: "AES-256-GCM", iv: b64(iv), data: b64(data) },
  };
}

/** Decrypts a backup for the expected operator and network. The caller re-derives the key and checks keyId. */
export async function importBackup(text: string, passphrase: string, expect: { operator: string; chainId: string }): Promise<{ secret: Uint8Array; keyId: string }> {
  let b: Backup;
  try { b = JSON.parse(text); } catch { throw new Error("That file is not a Quorate sealing-key backup"); }
  if ((b?.format as string) === "quorate-sealing-key/1") throw new Error("This backup is from an earlier Quorate version that did not use a sealing account; create a new key");
  if (b?.format !== BACKUP_FORMAT) throw new Error("That file is not a Quorate sealing-key backup");
  if (b.operator !== expect.operator) throw new Error(`This backup belongs to ${b.operator}, not the connected account`);
  if (b.chainId !== expect.chainId) throw new Error(`This backup is for ${b.chainId}`);
  if (!(b.kdf?.rounds >= 100_000 && b.kdf.rounds <= 5_000_000)) throw new Error("This backup uses unexpected settings");
  try {
    const key = await aesKey(passphrase, fromB64(b.kdf.salt), b.kdf.rounds);
    const secret = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(b.cipher.iv), additionalData: aad(b.chainId, b.operator, b.keyId) }, key, fromB64(b.cipher.data)));
    if (secret.length !== 32) throw new Error("bad length");
    return { secret, keyId: b.keyId };
  } catch {
    throw new Error("Wrong passphrase, or the file was changed");
  }
}

export function downloadJson(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2) + "\n"], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const fromBase64 = fromB64;
export const toHex = hex;
