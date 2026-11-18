// Offline proof of the Quorate sealing flow with @qorechain/qoreseal.
// No network: shows the epoch-key behaviour the on-chain flow relies on.
//  1. An advisory sealed to the 4-operator set opens for every operator.
//  2. operator-4 leaves the bonded set -> new epoch; operator-4 cannot open
//     the new epoch key or the next advisory.
//  3. A tampered advisory blob is rejected.
import { readFileSync } from "node:fs";
import {
  EpochKeyManager,
  deriveSealKeys,
  openBatch,
  openEpochKey,
  recipientOf,
  sealBatch,
} from "@qorechain/qoreseal";

const CHAIN = "qorechain-diana";
const PURPOSE = "epoch-key:quorate-advisories";
const CONTEXT = "quorate:advisories";
const { accounts } = JSON.parse(readFileSync(".keys/accounts.json", "utf8"));
const ops = accounts.filter((a) => a.role.startsWith("operator"));
const keys = Object.fromEntries(ops.map((o) => [o.address, deriveSealKeys({ mnemonic: o.mnemonic })]));

const results = [];
const check = (name, ok) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
};
const throws = (fn) => {
  try { fn(); return false; } catch { return true; }
};
const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

// Coordinator side.
const group = new EpochKeyManager({
  chainId: CHAIN,
  purpose: PURPOSE,
  members: Object.fromEntries(ops.map((o) => [o.address, recipientOf(keys[o.address])])),
});
const dist1 = group.distribution();
const adv1 = sealBatch({
  epochKey: group.currentKey,
  context: CONTEXT,
  batchIndex: 1,
  data: enc("QSA-2026-001: patch v3.2.8-hotfix1 before height 9,990,000"),
});

// Every operator opens advisory 1.
for (const o of ops) {
  const ek = openEpochKey({ chainId: CHAIN, purpose: PURPOSE, envelope: dist1, keys: keys[o.address] });
  const opened = openBatch({ blob: adv1.blob, keys: [ek] });
  check(`${o.role} opens advisory 1 (epoch ${ek.epoch})`, dec(opened.data).startsWith("QSA-2026-001"));
}

// operator-4 leaves the set: new epoch.
const leaver = ops[3];
const rot = group.removeMember(leaver.address);
const adv2 = sealBatch({ epochKey: group.currentKey, context: CONTEXT, batchIndex: 2, data: enc("QSA-2026-002: embargoed") });
check(`rotation to epoch ${rot.epoch} after ${leaver.role} leaves`, rot.epoch === 2n && rot.members.length === 3);
check(
  `${leaver.role} cannot open the epoch ${rot.epoch} key`,
  throws(() => openEpochKey({ chainId: CHAIN, purpose: PURPOSE, envelope: rot.envelope, keys: keys[leaver.address] })),
);
const oldKey = openEpochKey({ chainId: CHAIN, purpose: PURPOSE, envelope: dist1, keys: keys[leaver.address] });
check(`${leaver.role} cannot open advisory 2 with its old epoch key`, throws(() => openBatch({ blob: adv2.blob, keys: [oldKey] })));
const stayer = ops[0];
const ek2 = openEpochKey({ chainId: CHAIN, purpose: PURPOSE, envelope: rot.envelope, keys: keys[stayer.address] });
check(`${stayer.role} opens advisory 2`, dec(openBatch({ blob: adv2.blob, keys: [ek2] }).data).startsWith("QSA-2026-002"));

// Tampering.
const tampered = adv2.blob.slice();
tampered[tampered.length - 1] ^= 1;
check("tampered advisory blob is rejected", throws(() => openBatch({ blob: tampered, keys: [ek2] })));

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
