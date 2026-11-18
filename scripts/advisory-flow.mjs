// End-to-end Quorate scenario on testnet (qorechain-diana), demo set only.
// The four operators are accounts this project controls (simulated).
//
//  1. Epoch 1 = operators 1-4. Recipients' ML-KEM-1024 keys are read from the
//     chain's registry, not from local files. The epoch key is sealed to them
//     and the manifest hash is anchored on chain by the coordinator.
//  2. QSA-001 is sealed under epoch 1 and anchored with its blob hash and a
//     target upgrade height.
//  3. Operators 1-3 check both anchors on chain, decrypt locally and send a
//     hybrid-signed ack. Operator 4 stays silent.
//  4. Operator 4 leaves the set: epoch 2 = operators 1-3, anchored.
//  5. QSA-002 is sealed under epoch 2 and anchored.
//  6. Refusals: operator 4 cannot open the epoch 2 key; it acks QSA-002 anyway
//     (not a member); operator 3 acks a tampered copy (wrong blob hash).
//  7. Operators 1, 2 and then 3 (correct copy) ack QSA-002.
// Then run scripts/quorum.mjs to verify everything from public data alone.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  createClient,
  deriveNativeAccount,
  derivePqcCanonical,
  directSignerFromPrivateKey,
} from "@qorechain/sdk";
import { fetchMlkemPublicKey } from "@qorechain/qoreseal/network";
import { EpochKeyManager, deriveSealKeys, openBatch, openEpochKey, sealBatch } from "@qorechain/qoreseal";
import { ADVISORY_CONTEXT, CHAIN_ID, EPOCH_PURPOSE, REST, getTx, latestHeight, memo, parseMemo, sha3 } from "../lib/protocol.mjs";

const DIR = "advisories";
if (existsSync(`${DIR}/epoch-1.json`)) {
  console.error(`${DIR}/epoch-1.json exists: this scenario already ran. Use scripts/quorum.mjs to read it.`);
  process.exit(1);
}
mkdirSync(DIR, { recursive: true });

const client = createClient();
const { accounts } = JSON.parse(readFileSync(".keys/accounts.json", "utf8"));
const byRole = Object.fromEntries(accounts.map((a) => [a.role, a]));
const ops = ["operator-1", "operator-2", "operator-3", "operator-4"].map((r) => byRole[r]);
const log = [];
const step = (text, extra = {}) => { log.push({ text, ...extra, at: new Date().toISOString() }); console.log(text, extra.tx ? `  ${extra.tx}` : ""); };
const b64 = (u8) => Buffer.from(u8).toString("base64");

async function signer(account) {
  const native = await deriveNativeAccount(account.mnemonic);
  const pqcKeypair = derivePqcCanonical(native.address, account.mnemonic);
  const tx = await client.connectTx(await directSignerFromPrivateKey(native.privateKey, "qor"), { pqcKeypair });
  return { address: native.address, tx };
}
const send = async (from, to, text) => {
  if (text.length > 256) throw new Error("memo over 256 characters");
  const r = await from.tx.bankSend(to, [{ denom: "uqor", amount: "1" }], { memo: text });
  const hash = r.transactionHash ?? r.txHash ?? r.hash;
  const seen = await waitTx(hash);
  if (seen.code !== 0 || !seen.hybrid || seen.memo !== text) throw new Error(`tx ${hash} not as expected: ${JSON.stringify(seen)}`);
  return hash;
};
async function waitTx(hash) {
  for (let i = 0; i < 15; i++) {
    try { return await getTx(hash); } catch { await new Promise((r) => setTimeout(r, 2000)); }
  }
  throw new Error(`tx ${hash} not found`);
}

const coordinator = await signer(byRole.coordinator);
const opSigners = Object.fromEntries(await Promise.all(ops.map(async (o) => [o.address, await signer(o)])));
const opSeal = Object.fromEntries(ops.map((o) => [o.address, deriveSealKeys({ mnemonic: o.mnemonic })]));

// Recipients from the chain's KEM registry.
const members = {};
for (const o of ops) members[o.address] = { mlkemPublicKey: await fetchMlkemPublicKey({ rest: REST, address: o.address }) };
step("Read 4 ML-KEM-1024 keys from the chain registry");

const group = new EpochKeyManager({ chainId: CHAIN_ID, purpose: EPOCH_PURPOSE, mode: "mlkem", members });
const saveKeys = () => writeFileSync(".keys/epochs.json", JSON.stringify(group.exportKeys().map((k) => ({ epoch: String(k.epoch), key: b64(k.key) }))));

async function publishEpoch(epoch, memberList, envelope) {
  const file = `${DIR}/epoch-${epoch}.json`;
  const bytes = Buffer.from(JSON.stringify({ protocol: "quorate/1", chainId: CHAIN_ID, epoch, members: memberList, envelope: b64(envelope) }, null, 2) + "\n");
  writeFileSync(file, bytes);
  const tx = await send(coordinator, coordinator.address, memo.epoch({ epoch, members: memberList.length, envHash: sha3(bytes) }));
  step(`Anchored epoch ${epoch} (${memberList.length} members)`, { tx });
  return tx;
}

async function publishAdvisory(id, body, targetHeight) {
  const sealed = sealBatch({ epochKey: group.currentKey, context: ADVISORY_CONTEXT, batchIndex: Number(id.split("-").pop()), data: Buffer.from(JSON.stringify(body)) });
  writeFileSync(`${DIR}/${id}.blob`, sealed.blob);
  const blobHash = sha3(sealed.blob);
  const tx = await send(coordinator, coordinator.address, memo.adv({ id, epoch: Number(group.epoch), height: targetHeight, blobHash }));
  step(`Anchored ${id} under epoch ${group.epoch}, target height ${targetHeight}`, { tx });
  return { tx, blobHash };
}

// What an operator does: check anchors on chain, open locally, ack.
async function operatorAck(address, id, epochTx, advTx) {
  const epochRec = parseMemo((await getTx(epochTx)).memo);
  const advRec = parseMemo((await getTx(advTx)).memo);
  const manifestBytes = readFileSync(`${DIR}/epoch-${epochRec.epoch}.json`);
  if (sha3(manifestBytes) !== epochRec.envHash) throw new Error("epoch manifest does not match anchor");
  const blob = readFileSync(`${DIR}/${id}.blob`);
  if (sha3(blob) !== advRec.blobHash) throw new Error("advisory blob does not match anchor");
  const envelope = Buffer.from(JSON.parse(manifestBytes).envelope, "base64");
  const ek = openEpochKey({ chainId: CHAIN_ID, purpose: EPOCH_PURPOSE, envelope, keys: opSeal[address] });
  const advisory = JSON.parse(Buffer.from(openBatch({ blob, keys: [ek] }).data).toString("utf8"));
  const tx = await send(opSigners[address], coordinator.address, memo.ack({ id, epoch: epochRec.epoch, blobHash: advRec.blobHash }));
  step(`${ops.find((o) => o.address === address).role} opened ${advisory.id} ("${advisory.title}") and acked`, { tx });
  return tx;
}

const patch = (v) => ({ version: v, sha256: createHash("sha256").update(`simulated qorechaind ${v}`).digest("hex") });
const h = await latestHeight();

// 1-3.
const epoch1 = await publishEpoch(1, ops.map((o) => o.address), group.distribution());
saveKeys();
const adv1 = await publishAdvisory("QSA-001", {
  id: "QSA-001", simulated: true, title: "Simulated: mempool admission bug", severity: "high",
  patch: patch("v3.2.8-q1"), upgradeHeight: h + 20000,
}, h + 20000);
for (const o of ops.slice(0, 3)) await operatorAck(o.address, "QSA-001", epoch1, adv1.tx);
step("operator-4 has not acked QSA-001 (offline)");

// 4-5.
const leaver = ops[3];
const rot = group.removeMember(leaver.address);
const epoch2 = await publishEpoch(Number(rot.epoch), rot.members, rot.envelope);
saveKeys();
const adv2 = await publishAdvisory("QSA-002", {
  id: "QSA-002", simulated: true, title: "Simulated: light-node reward rounding", severity: "medium",
  patch: patch("v3.2.8-q2"), upgradeHeight: h + 30000,
}, h + 30000);

// 6. Refusals.
try {
  const env2 = Buffer.from(JSON.parse(readFileSync(`${DIR}/epoch-2.json`)).envelope, "base64");
  openEpochKey({ chainId: CHAIN_ID, purpose: EPOCH_PURPOSE, envelope: env2, keys: opSeal[leaver.address] });
  throw new Error("REFUSAL FAILED: operator-4 opened the epoch 2 key");
} catch (e) {
  if (e.message.startsWith("REFUSAL FAILED")) throw e;
  step("operator-4 cannot open the epoch 2 key (refused locally)", { error: e.message });
}
const strayAck = await send(opSigners[leaver.address], coordinator.address, memo.ack({ id: "QSA-002", epoch: 2, blobHash: adv2.blobHash }));
step("operator-4 acked QSA-002 anyway (expected: rejected, not a member)", { tx: strayAck });
const wrongAck = await send(opSigners[ops[2].address], coordinator.address, memo.ack({ id: "QSA-002", epoch: 2, blobHash: sha3(Buffer.from("tampered copy")) }));
step("operator-3 acked a tampered copy of QSA-002 (expected: rejected, blob hash)", { tx: wrongAck });

// 7.
for (const o of ops.slice(0, 3)) await operatorAck(o.address, "QSA-002", epoch2, adv2.tx);

mkdirSync("receipts", { recursive: true });
writeFileSync("receipts/advisory-flow.json", JSON.stringify(log, null, 2));
console.log("\nDone. Verify from public data: node scripts/quorum.mjs");
