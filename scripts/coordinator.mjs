// Coordinator actions on testnet (qorechain-diana), signed by the coordinator
// account in .keys/accounts.json. Epoch keys stay in .keys/epochs.json.
//
//   node scripts/coordinator.mjs rotate [--add qor1...]... [--remove qor1...]...
//   node scripts/coordinator.mjs advisory --id QSA-003 --title "..." [--details "..."] [--blocks 20000]
//                                         [--patch v3.2.8-q3] [--simulated]
//
// rotate: reads every member's ML-KEM-1024 key from the chain registry, starts
// the next epoch with a fresh key sealed to the new member list, publishes
// advisories/epoch-<n>.json and anchors its SHA3-256 on chain.
// advisory: seals the advisory under the current epoch key, publishes
// advisories/<id>.blob and anchors its hash with the target halt height.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createClient, deriveNativeAccount, derivePqcCanonical, directSignerFromPrivateKey } from "@qorechain/sdk";
import { fetchMlkemPublicKey } from "@qorechain/qoreseal/network";
import { EpochKeyManager, sealBatch } from "@qorechain/qoreseal";
import { ADVISORY_CONTEXT, CHAIN_ID, EPOCH_PURPOSE, REST, getTx, latestHeight, memo, sha3 } from "../lib/protocol.mjs";
import { decode } from "../lib/bech32.mjs";

const DIR = "advisories";
const [cmd, ...rest] = process.argv.slice(2);
const opts = { add: [], remove: [] };
for (let i = 0; i < rest.length; i++) {
  const k = rest[i].replace(/^--/, "");
  if (k === "simulated") { opts.simulated = true; continue; }
  const v = rest[++i];
  if (k === "add" || k === "remove") opts[k].push(v); else opts[k] = v;
}
const isQor = (a) => { try { const d = decode(a); return d.hrp === "qor" && d.words.length === 32; } catch { return false; } };
const b64 = (u8) => Buffer.from(u8).toString("base64");

const { accounts } = JSON.parse(readFileSync(".keys/accounts.json", "utf8"));
const coordAcct = accounts.find((a) => a.role === "coordinator");
const native = await deriveNativeAccount(coordAcct.mnemonic);
const client = createClient();
const tx = await client.connectTx(await directSignerFromPrivateKey(native.privateKey, "qor"), { pqcKeypair: derivePqcCanonical(native.address, coordAcct.mnemonic) });

async function anchor(text) {
  if (Buffer.byteLength(text) > 256) throw new Error("memo over 256 bytes");
  const r = await tx.bankSend(native.address, [{ denom: "uqor", amount: "1" }], { memo: text });
  const hash = r.transactionHash ?? r.txHash ?? r.hash;
  for (let i = 0; i < 15; i++) {
    try {
      const t = await getTx(hash);
      if (t.code !== 0 || !t.hybrid || t.memo !== text) throw new Error(`anchor ${hash} not as expected`);
      return t;
    } catch (e) { if (/not as expected/.test(e.message)) throw e; await new Promise((r) => setTimeout(r, 2000)); }
  }
  throw new Error(`anchor ${hash} not found`);
}

// Restore the group: history of epoch keys, current members with keys from the chain.
const history = JSON.parse(readFileSync(".keys/epochs.json", "utf8")).map((k) => ({ epoch: BigInt(k.epoch), key: Buffer.from(k.key, "base64") }));
const current = Number(history.at(-1).epoch);
const currentManifest = JSON.parse(readFileSync(`${DIR}/epoch-${current}.json`, "utf8"));
const recipient = async (address) => ({ mlkemPublicKey: await fetchMlkemPublicKey({ rest: REST, address }) });
const group = new EpochKeyManager({
  chainId: CHAIN_ID, purpose: EPOCH_PURPOSE, mode: "mlkem", history,
  members: Object.fromEntries(await Promise.all(currentManifest.members.map(async (a) => [a, await recipient(a)]))),
});
const saveKeys = () => writeFileSync(".keys/epochs.json", JSON.stringify(group.exportKeys().map((k) => ({ epoch: String(k.epoch), key: b64(k.key) }))));

if (cmd === "rotate") {
  for (const a of [...opts.add, ...opts.remove]) if (!isQor(a)) throw new Error(`not a qor1 account address: ${a}`);
  if (!opts.add.length && !opts.remove.length) throw new Error("nothing to change: pass --add or --remove");
  for (const a of opts.add) {
    let r;
    try { r = await recipient(a); } catch { throw new Error(`${a} has no ML-KEM-1024 key on chain yet`); }
    group.addMember(a, r);
  }
  for (const a of opts.remove) group.removeMember(a);
  // Each change above started an epoch; publish only the final one, sealed to the final members.
  const epoch = Number(group.epoch);
  const members = group.members();
  const bytes = Buffer.from(JSON.stringify({ protocol: "quorate/1", chainId: CHAIN_ID, epoch, members, envelope: b64(group.distribution()) }, null, 2) + "\n");
  if (existsSync(`${DIR}/epoch-${epoch}.json`)) throw new Error(`${DIR}/epoch-${epoch}.json already exists`);
  writeFileSync(`${DIR}/epoch-${epoch}.json`, bytes);
  saveKeys();
  const t = await anchor(memo.epoch({ epoch, members: members.length, envHash: sha3(bytes) }));
  console.log(`epoch ${epoch}: ${members.length} members, anchored ${t.hash} @ ${t.height}`);
  for (const m of members) console.log(`  ${m}`);
} else if (cmd === "advisory") {
  if (!opts.id || !/^[A-Za-z0-9-]{1,32}$/.test(opts.id)) throw new Error("--id like QSA-003");
  if (!opts.title) throw new Error("--title is required");
  if (existsSync(`${DIR}/${opts.id}.blob`)) throw new Error(`${opts.id} already exists`);
  const height = (await latestHeight()) + Number(opts.blocks ?? 20000);
  const body = {
    id: opts.id, simulated: !!opts.simulated, title: opts.title, details: opts.details ?? "",
    patch: opts.patch ? { version: opts.patch, sha256: createHash("sha256").update(`simulated qorechaind ${opts.patch}`).digest("hex") } : null,
    upgradeHeight: height,
  };
  const sealed = sealBatch({ epochKey: group.currentKey, context: ADVISORY_CONTEXT, batchIndex: Number(opts.id.match(/\d+$/)?.[0] ?? 0), data: Buffer.from(JSON.stringify(body)) });
  writeFileSync(`${DIR}/${opts.id}.blob`, sealed.blob);
  const t = await anchor(memo.adv({ id: opts.id, epoch: Number(group.epoch), height, blobHash: sha3(sealed.blob) }));
  console.log(`${opts.id} sealed under epoch ${group.epoch} to ${group.members().length} members, halt height ${height}, anchored ${t.hash} @ ${t.height}`);
} else {
  console.error("usage: coordinator.mjs rotate --add qor1... | --remove qor1...   or   advisory --id QSA-003 --title ...");
  process.exit(2);
}
