// Quorate protocol v1: memo formats, hashing and chain reads shared by the
// coordinator, the operators and the independent quorum reader.
//
// Everything public lives in two places:
//  - on chain: hybrid-signed transactions whose memo is one of the records below
//  - in advisories/: ciphertext only (sealed advisory blobs, sealed epoch keys)
//
// Records (memo, at most 256 characters):
//   quorate/1 epoch <n> members <count> env <sha3-256 of the epoch-key envelope>
//   quorate/1 adv <id> epoch <n> height <target> blob <sha3-256 of the advisory blob>
//   quorate/1 ack <id> epoch <n> blob <sha3-256 of the advisory blob>
//   quorate/1 bind <sealing account>        sent by an operator: "my encryption key lives on this account"
//   quorate/1 sealer <operator account>     sent by that sealing account: "I hold the key for this operator"
// A binding counts only when both halves are on chain, hybrid-signed, and sent to the coordinator.
import { createHash } from "node:crypto";

export const CHAIN_ID = "qorechain-diana";
export const REST = "https://api-testnet.qore.host";
export const EPOCH_PURPOSE = "epoch-key:quorate-advisories";
export const ADVISORY_CONTEXT = "quorate:advisories";
export const PREFIX = "quorate/1";

export const sha3 = (bytes) => createHash("sha3-256").update(bytes).digest("hex");

export const memo = {
  epoch: ({ epoch, members, envHash }) => `${PREFIX} epoch ${epoch} members ${members} env ${envHash}`,
  adv: ({ id, epoch, height, blobHash }) => `${PREFIX} adv ${id} epoch ${epoch} height ${height} blob ${blobHash}`,
  ack: ({ id, epoch, blobHash }) => `${PREFIX} ack ${id} epoch ${epoch} blob ${blobHash}`,
  bind: ({ sealer }) => `${PREFIX} bind ${sealer}`,
  sealer: ({ operator }) => `${PREFIX} sealer ${operator}`,
};

const PATTERNS = {
  epoch: /^quorate\/1 epoch (\d+) members (\d+) env ([0-9a-f]{64})$/,
  adv: /^quorate\/1 adv ([A-Za-z0-9-]{1,32}) epoch (\d+) height (\d+) blob ([0-9a-f]{64})$/,
  ack: /^quorate\/1 ack ([A-Za-z0-9-]{1,32}) epoch (\d+) blob ([0-9a-f]{64})$/,
  bind: /^quorate\/1 bind (qor1[02-9ac-hj-np-z]{38})$/,
  sealer: /^quorate\/1 sealer (qor1[02-9ac-hj-np-z]{38})$/,
};

/** Parse a memo into a record, or null when it is not a Quorate record. */
export function parseMemo(text) {
  let m;
  if ((m = PATTERNS.epoch.exec(text))) return { kind: "epoch", epoch: Number(m[1]), members: Number(m[2]), envHash: m[3] };
  if ((m = PATTERNS.adv.exec(text))) return { kind: "adv", id: m[1], epoch: Number(m[2]), height: Number(m[3]), blobHash: m[4] };
  if ((m = PATTERNS.ack.exec(text))) return { kind: "ack", id: m[1], epoch: Number(m[2]), blobHash: m[3] };
  if ((m = PATTERNS.bind.exec(text))) return { kind: "bind", sealer: m[1] };
  if ((m = PATTERNS.sealer.exec(text))) return { kind: "sealer", operator: m[1] };
  return null;
}

async function getJson(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return await res.json();
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

/** A transaction as Quorate needs it, with proof it was post-quantum signed. */
function summarise(tx, resp) {
  const ext = [...(tx.body.extension_options ?? []), ...(tx.body.non_critical_extension_options ?? [])];
  const events = new Set((resp.events ?? []).map((e) => e.type));
  const send = tx.body.messages.find((m) => m["@type"] === "/cosmos.bank.v1beta1.MsgSend");
  return {
    hash: resp.txhash,
    height: Number(resp.height),
    code: resp.code,
    memo: tx.body.memo,
    from: send?.from_address ?? null,
    to: send?.to_address ?? null,
    hybrid: ext.some((e) => e["@type"] === "/qorechain.pqc.v1.PQCHybridSignature") && events.has("pqc_hybrid_verify"),
  };
}

export async function getTx(hash) {
  const d = await getJson(`${REST}/cosmos/tx/v1beta1/txs/${hash}`);
  return summarise(d.tx, d.tx_response);
}

/** Every successful bank transfer received by `address`, oldest first. */
export async function txsTo(address) {
  const out = [];
  for (let page = 1; ; page++) {
    const q = encodeURIComponent(`transfer.recipient='${address}'`);
    const d = await getJson(`${REST}/cosmos/tx/v1beta1/txs?query=${q}&page=${page}&limit=100&order_by=ORDER_BY_ASC`);
    d.txs.forEach((tx, i) => out.push(summarise(tx, d.tx_responses[i])));
    if (out.length >= Number(d.total ?? 0) || d.txs.length === 0) break;
  }
  return out.filter((t) => t.code === 0);
}

export async function latestHeight() {
  const d = await getJson(`${REST}/cosmos/base/tendermint/v1beta1/blocks/latest`);
  return Number(d.block.header.height);
}

/** Latest height and the measured average block time over the last `span` blocks. */
export async function chainClock(span = 1000) {
  const latest = await getJson(`${REST}/cosmos/base/tendermint/v1beta1/blocks/latest`);
  const height = Number(latest.block.header.height);
  const past = await getJson(`${REST}/cosmos/base/tendermint/v1beta1/blocks/${height - span}`);
  const seconds = (Date.parse(latest.block.header.time) - Date.parse(past.block.header.time)) / 1000 / span;
  return { height, blockSeconds: Number.isFinite(seconds) && seconds > 0 ? seconds : null };
}
