// Independent quorum reader. Uses only public data: the chain and the
// ciphertext files in advisories/. It holds no keys.
//
//   node scripts/quorum.mjs [coordinator-address]
//
// Rules:
//  - Anchors (epoch, adv) count only from the coordinator to itself, hybrid-signed.
//  - An epoch's member list is advisories/epoch-<n>.json; its SHA3-256 must
//    equal the env hash in the epoch anchor. Every member must have an
//    ML-KEM-1024 key in the chain's registry.
//  - An ack counts when it is hybrid-signed, sent by a member of the
//    advisory's epoch, names that epoch, carries the blob hash from the
//    advisory anchor, and comes after the anchor. One ack per operator.
//  - Quorate means more than two thirds of the epoch's members acknowledged.
import { existsSync, readFileSync } from "node:fs";
import { fetchKemKey } from "@qorechain/sdk";
import { REST, parseMemo, sha3, txsTo } from "../lib/protocol.mjs";

const DEFAULT_COORDINATOR = "qor1f78j6m6wfvpn5468tpznhcs7p4lm30hejv3zj0";

export async function readQuorum(coordinator = DEFAULT_COORDINATOR, dir = "advisories") {
  const txs = await txsTo(coordinator);
  const epochs = new Map();
  const advisories = new Map();
  const rejected = [];

  for (const t of txs) {
    const rec = parseMemo(t.memo ?? "");
    if (!rec) continue;
    if (!t.hybrid) { rejected.push({ tx: t.hash, from: t.from, reason: "not hybrid-signed" }); continue; }

    if (rec.kind === "epoch" || rec.kind === "adv") {
      if (t.from !== coordinator) { rejected.push({ tx: t.hash, from: t.from, reason: `${rec.kind} anchor not from coordinator` }); continue; }
    }

    if (rec.kind === "epoch") {
      const file = `${dir}/epoch-${rec.epoch}.json`;
      if (!existsSync(file)) { rejected.push({ tx: t.hash, reason: `missing ${file}` }); continue; }
      const bytes = readFileSync(file);
      if (sha3(bytes) !== rec.envHash) { rejected.push({ tx: t.hash, reason: `epoch ${rec.epoch} file does not match anchor` }); continue; }
      const manifest = JSON.parse(bytes.toString("utf8"));
      if (manifest.members.length !== rec.members) { rejected.push({ tx: t.hash, reason: `epoch ${rec.epoch} member count mismatch` }); continue; }
      const kem = await Promise.all(manifest.members.map((a) => fetchKemKey({ rest: REST, address: a })));
      const missing = manifest.members.filter((_, i) => !kem[i].found);
      if (missing.length) { rejected.push({ tx: t.hash, reason: `epoch ${rec.epoch} members without KEM key: ${missing.join(", ")}` }); continue; }
      epochs.set(rec.epoch, { epoch: rec.epoch, members: manifest.members, anchor: t.hash, height: t.height });
    } else if (rec.kind === "adv") {
      const ep = epochs.get(rec.epoch);
      if (!ep) { rejected.push({ tx: t.hash, reason: `advisory ${rec.id} names unknown epoch ${rec.epoch}` }); continue; }
      advisories.set(rec.id, { ...rec, anchor: t.hash, anchorHeight: t.height, members: ep.members, acks: new Map() });
    } else if (rec.kind === "ack") {
      const adv = advisories.get(rec.id);
      const reject = (reason) => rejected.push({ tx: t.hash, from: t.from, advisory: rec.id, reason });
      if (!adv) { reject("ack for an unknown advisory"); continue; }
      if (t.to !== coordinator) { reject("ack not sent to coordinator"); continue; }
      if (!adv.members.includes(t.from)) { reject(`sender is not a member of epoch ${adv.epoch}`); continue; }
      if (rec.epoch !== adv.epoch) { reject(`ack names epoch ${rec.epoch}, advisory is epoch ${adv.epoch}`); continue; }
      if (rec.blobHash !== adv.blobHash) { reject("blob hash does not match the anchored advisory"); continue; }
      if (t.height < adv.anchorHeight) { reject("ack precedes the advisory anchor"); continue; }
      if (adv.acks.has(t.from)) { reject("duplicate ack"); continue; }
      adv.acks.set(t.from, { tx: t.hash, height: t.height });
    }
  }

  const summary = [...advisories.values()].map((a) => {
    const n = a.members.length;
    const k = a.acks.size;
    return {
      id: a.id, epoch: a.epoch, targetHeight: a.height, anchor: a.anchor,
      ready: k, members: n, quorate: k * 3 > n * 2,
      acks: Object.fromEntries(a.acks),
      waiting: a.members.filter((m) => !a.acks.has(m)),
    };
  });
  return { coordinator, epochs: [...epochs.values()], advisories: summary, rejected };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/").replace(/^([A-Za-z]):/, "/$1:")}` || process.argv[1]?.endsWith("quorum.mjs")) {
  const r = await readQuorum(process.argv[2]);
  console.log(`Coordinator ${r.coordinator}`);
  for (const e of r.epochs) console.log(`epoch ${e.epoch}: ${e.members.length} members, anchor ${e.anchor} @ ${e.height}`);
  for (const a of r.advisories) {
    console.log(`\n${a.id} (epoch ${a.epoch}, target height ${a.targetHeight}): ${a.ready}/${a.members} ready -> ${a.quorate ? "QUORATE" : "not quorate"}`);
    for (const [op, ack] of Object.entries(a.acks)) console.log(`  ready   ${op}  ${ack.tx} @ ${ack.height}`);
    for (const op of a.waiting) console.log(`  waiting ${op}`);
  }
  if (r.rejected.length) {
    console.log("\nRejected records:");
    for (const x of r.rejected) console.log(`  ${x.tx}  ${x.from ?? ""}  ${x.advisory ?? ""}  ${x.reason}`);
  }
}
