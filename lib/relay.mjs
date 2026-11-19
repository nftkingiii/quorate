// The server's one write path: it forwards transactions a sealing account has
// already signed in the browser. It holds no keys, cannot create or alter a
// transaction, and the chain checks every signature. It forwards only the two
// shapes a sealing account needs:
//
//   1. [MsgRegisterPQCKeyV2] alone, empty memo   (register its ML-DSA-87 key)
//   2. [MsgRegisterKEMKey, MsgSend] with memo "quorate/1 sealer <operator>",
//      the send being exactly 1 uqor from the same account to the coordinator
//
// Anything else is refused before it reaches the chain.
import { TxBody, TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { MsgSend } from "cosmjs-types/cosmos/bank/v1beta1/tx";
import { parseMemo } from "./protocol.mjs";

export const MAX_TX_BYTES = 16 * 1024;
const PQC_REG = "/qorechain.pqc.v1.MsgRegisterPQCKeyV2";
const KEM_REG = "/qorechain.pqc.v1.MsgRegisterKEMKey";
const SEND = "/cosmos.bank.v1beta1.MsgSend";

// Field 1 of both QoreChain messages is the sender (a string). Read it without a full codec.
function senderField(bytes) {
  let i = 0;
  while (i < bytes.length) {
    const key = bytes[i++];
    const field = key >> 3, wire = key & 7;
    let len = 0, shift = 0, b;
    if (wire === 0) { do { b = bytes[i++]; } while (b & 128); continue; }
    if (wire !== 2) return null;
    do { b = bytes[i++]; len |= (b & 127) << shift; shift += 7; } while (b & 128);
    if (field === 1) return new TextDecoder().decode(bytes.subarray(i, i + len));
    i += len;
  }
  return null;
}

/** Returns { ok: true, kind } or { ok: false, reason }. */
export function checkRelayTx(txBytes, coordinator) {
  if (!(txBytes instanceof Uint8Array) || txBytes.length === 0) return { ok: false, reason: "empty transaction" };
  if (txBytes.length > MAX_TX_BYTES) return { ok: false, reason: "transaction too large" };
  let raw, body;
  try {
    raw = TxRaw.decode(txBytes);
    body = TxBody.decode(raw.bodyBytes);
  } catch {
    return { ok: false, reason: "not a transaction" };
  }
  if (raw.signatures.length !== 1) return { ok: false, reason: "expected exactly one signer" };
  const types = body.messages.map((m) => m.typeUrl);

  if (types.length === 1 && types[0] === PQC_REG) {
    if (body.memo !== "") return { ok: false, reason: "key registration must have an empty memo" };
    return { ok: true, kind: "pqc-key" };
  }

  if (types.length === 2 && types[0] === KEM_REG && types[1] === SEND) {
    const rec = parseMemo(body.memo);
    if (rec?.kind !== "sealer") return { ok: false, reason: "memo must be a quorate/1 sealer record" };
    const kemSender = senderField(body.messages[0].value);
    let send;
    try { send = MsgSend.decode(body.messages[1].value); } catch { return { ok: false, reason: "malformed send" }; }
    if (send.toAddress !== coordinator) return { ok: false, reason: "the send must go to the coordinator" };
    if (send.fromAddress !== kemSender) return { ok: false, reason: "both messages must come from the same account" };
    if (send.amount.length !== 1 || send.amount[0].denom !== "uqor" || send.amount[0].amount !== "1") return { ok: false, reason: "the send must be exactly 1 uqor" };
    if (rec.operator === send.fromAddress) return { ok: false, reason: "a sealing account cannot vouch for itself" };
    return { ok: true, kind: "kem-key-and-binding" };
  }

  return { ok: false, reason: `not a sealing-account transaction (${types.join(", ") || "no messages"})` };
}

/** A fixed-window rate limit per key (the visitor's address) plus a global cap. */
export function rateLimiter({ perKey = 10, globalMax = 200, windowMs = 10 * 60 * 1000, now = () => Date.now() } = {}) {
  const hits = new Map();
  let global = { start: now(), count: 0 };
  return (key) => {
    const t = now();
    if (t - global.start > windowMs) global = { start: t, count: 0 };
    let h = hits.get(key);
    if (!h || t - h.start > windowMs) { h = { start: t, count: 0 }; hits.set(key, h); }
    if (hits.size > 10000) for (const [k, v] of hits) if (t - v.start > windowMs) hits.delete(k);
    if (h.count >= perKey || global.count >= globalMax) return false;
    h.count++; global.count++;
    return true;
  };
}
