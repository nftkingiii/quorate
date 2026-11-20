// Account reads shared by the server and its tests. `getJson` is passed in so
// tests can simulate a chain that answers, refuses or times out.
import { sha3 } from "./protocol.mjs";
import { decode } from "./bech32.mjs";

/** A lower-case qor1 account address (20 bytes). */
export function isQorAddress(a) {
  try { const d = decode(a); return d.hrp === "qor" && a === a.toLowerCase() && d.words.length === 32; } catch { return false; }
}

/** Signing and encryption key status; "unknown" when the chain could not be read. */
export async function keyStatus(getJson, rest, address) {
  const [pqc, kem] = await Promise.all([
    getJson(`${rest}/qorechain/pqc/v1/account/${address}`).catch(() => null),
    getJson(`${rest}/qorechain/pqc/v1/kem/${address}`).catch(() => null),
  ]);
  return {
    signingKey: pqc ? (pqc.found ? { type: pqc.account?.key_type ?? null, possessionProven: pqc.account?.possession_proven === true } : null) : "unknown",
    encryptionKey: kem ? kem.found === true : "unknown",
  };
}

/**
 * What an operator needs to know about its own account. A failed read throws:
 * it must never look like "no key registered", or the page would offer to
 * register a new key and lock the operator out of advisories sealed to the old one.
 */
export async function readAccount(getJson, rest, address) {
  const [status, kem, bank, auth] = await Promise.all([
    keyStatus(getJson, rest, address),
    getJson(`${rest}/qorechain/pqc/v1/kem/${address}`).catch(() => null),
    getJson(`${rest}/cosmos/bank/v1beta1/balances/${address}`).catch(() => null),
    getJson(`${rest}/cosmos/auth/v1beta1/accounts/${address}`).catch(() => null), // absent until the account first receives funds
  ]);
  const base = auth?.account?.base_account ?? auth?.account;
  if (!kem || status.signingKey === "unknown") throw new Error("Could not read this account from the chain");
  const pk = kem.key?.public_key ?? null;
  return {
    address,
    signingKey: status.signingKey,
    encryptionKey: { found: kem.found === true, publicKeySha3: pk ? sha3(Buffer.from(pk, "base64")) : null },
    balanceUqor: bank?.balances?.find((b) => b.denom === "uqor")?.amount ?? (bank ? "0" : null),
    accountNumber: base?.account_number != null ? Number(base.account_number) : null,
    sequence: base?.sequence != null ? Number(base.sequence) : null,
    readAt: new Date().toISOString(),
  };
}
