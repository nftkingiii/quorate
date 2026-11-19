// The Quorate quorum rules, shared by the CLI (scripts/quorum.mjs) and the
// read-only server (server/index.mjs). Public data only; no keys.
//
//  - Anchors (epoch, adv) count only from the coordinator to itself, hybrid-signed.
//  - An epoch's member list is advisories/epoch-<n>.json; its SHA3-256 must
//    equal the env hash in the epoch anchor. Every member must have an
//    ML-KEM-1024 key in the chain's registry.
//  - An ack counts when it is hybrid-signed, sent by a member of the
//    advisory's epoch, names that epoch, carries the blob hash from the
//    advisory anchor, and comes after the anchor. One ack per operator.
//  - Quorate means more than two thirds of the epoch's members acknowledged.
import { REST, parseMemo, sha3, txsTo } from "./protocol.mjs";

export const DEFAULT_COORDINATOR = "qor1f78j6m6wfvpn5468tpznhcs7p4lm30hejv3zj0";

export async function kemFound(address, rest = REST) {
  const res = await fetch(`${rest}/qorechain/pqc/v1/kem/${address}`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`KEM lookup ${res.status}`);
  return (await res.json()).found === true;
}

/**
 * @param {object} opts
 * @param {string} [opts.coordinator]
 * @param {(name: string) => Promise<Uint8Array|null>} opts.readFile  reads advisories/<name>, null when missing
 * @param {(address: string) => Promise<object[]>} [opts.fetchTxs]  transfers received by an address (tests pass fixtures)
 * @param {(address: string) => Promise<boolean>} [opts.hasKem]  whether an address has an ML-KEM key on chain
 */
export async function readQuorum({ coordinator = DEFAULT_COORDINATOR, readFile, fetchTxs = txsTo, hasKem = kemFound }) {
  const txs = await fetchTxs(coordinator);
  const epochs = new Map();
  const advisories = new Map();
  const rejected = [];

  for (const t of txs) {
    const rec = parseMemo(t.memo ?? "");
    if (!rec) continue;
    const reject = (reason, extra = {}) => rejected.push({ tx: t.hash, height: t.height, from: t.from, kind: rec.kind, reason, ...extra });
    if (!t.hybrid) { reject("not hybrid-signed"); continue; }
    if ((rec.kind === "epoch" || rec.kind === "adv") && t.from !== coordinator) { reject(`${rec.kind} anchor not from the coordinator`); continue; }

    if (rec.kind === "epoch") {
      const bytes = await readFile(`epoch-${rec.epoch}.json`);
      if (!bytes) { reject(`epoch-${rec.epoch}.json is missing`); continue; }
      if (sha3(bytes) !== rec.envHash) { reject(`epoch ${rec.epoch} file does not match its anchor`); continue; }
      const manifest = JSON.parse(new TextDecoder().decode(bytes));
      if (manifest.members.length !== rec.members) { reject(`epoch ${rec.epoch} member count does not match`); continue; }
      const found = await Promise.all(manifest.members.map((a) => hasKem(a)));
      const missing = manifest.members.filter((_, i) => !found[i]);
      if (missing.length) { reject(`epoch ${rec.epoch} has members without an encryption key`); continue; }
      epochs.set(rec.epoch, { epoch: rec.epoch, members: manifest.members, anchor: t.hash, height: t.height, envHash: rec.envHash });
    } else if (rec.kind === "adv") {
      const ep = epochs.get(rec.epoch);
      if (!ep) { reject(`names unknown epoch ${rec.epoch}`, { advisory: rec.id }); continue; }
      const blob = await readFile(`${rec.id}.blob`);
      advisories.set(rec.id, {
        ...rec, anchor: t.hash, anchorHeight: t.height, members: ep.members,
        blobBytes: blob ? blob.length : null, blobMatches: blob ? sha3(blob) === rec.blobHash : false,
        acks: new Map(),
      });
    } else if (rec.kind === "ack") {
      const adv = advisories.get(rec.id);
      const r = (reason) => reject(reason, { advisory: rec.id });
      if (!adv) { r("acknowledges an unknown advisory"); continue; }
      if (t.to !== coordinator) { r("not sent to the coordinator"); continue; }
      if (!adv.members.includes(t.from)) { r(`sender is not a member of epoch ${adv.epoch}`); continue; }
      if (rec.epoch !== adv.epoch) { r(`names epoch ${rec.epoch}, the advisory is epoch ${adv.epoch}`); continue; }
      if (rec.blobHash !== adv.blobHash) { r("blob hash does not match the anchored advisory"); continue; }
      if (t.height < adv.anchorHeight) { r("comes before the advisory anchor"); continue; }
      if (adv.acks.has(t.from)) { r("duplicate acknowledgement"); continue; }
      adv.acks.set(t.from, { tx: t.hash, height: t.height });
    }
  }

  const advisoryList = [...advisories.values()].map((a) => {
    const n = a.members.length;
    const k = a.acks.size;
    return {
      id: a.id, epoch: a.epoch, targetHeight: a.height, anchor: a.anchor, anchorHeight: a.anchorHeight,
      blobHash: a.blobHash, blobBytes: a.blobBytes, blobMatches: a.blobMatches,
      ready: k, members: n, needed: Math.floor((2 * n) / 3) + 1, quorate: k * 3 > n * 2,
      roster: a.members.map((m) => ({ address: m, ack: a.acks.get(m) ?? null })),
    };
  });
  return { coordinator, epochs: [...epochs.values()], advisories: advisoryList, rejected };
}
