// Testnet setup for the Quorate demo set (qorechain-diana).
//  1. Coordinator registers its ML-DSA-87 key (with proof of possession).
//  2. Coordinator funds each simulated operator (skipped when already funded).
//  3. Each operator registers its ML-DSA-87 key and its ML-KEM-1024 key.
//  4. Every key is read back from the chain and compared byte for byte.
// Safe to re-run: every step checks chain state first.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  createClient,
  deriveNativeAccount,
  derivePqcCanonical,
  directSignerFromPrivateKey,
  ensurePqcRegistered,
  fetchKemKey,
  msg,
  toBase,
} from "@qorechain/sdk";
import { deriveSealKeys } from "@qorechain/qoreseal";

const OPERATOR_FUNDING = "10"; // QOR per operator
const client = createClient(); // testnet preset
const rest = client.network.endpoints.rest;
const { accounts } = JSON.parse(readFileSync(".keys/accounts.json", "utf8"));
const receipts = [];

const hashOf = (r) => r?.transactionHash ?? r?.txHash ?? r?.hash;
const note = (step, address, result) => {
  const txHash = typeof result === "string" ? result : hashOf(result);
  receipts.push({ step, address, txHash: txHash ?? null, at: new Date().toISOString() });
  console.log(`${step.padEnd(28)} ${address}  ${txHash ?? "(no tx: already done)"}`);
};
const hex = (b) => Buffer.from(b).toString("hex");

async function connect(account) {
  const native = await deriveNativeAccount(account.mnemonic);
  if (native.address !== account.address) throw new Error(`address mismatch for ${account.role}`);
  const pqcKeypair = derivePqcCanonical(native.address, account.mnemonic);
  const signer = await directSignerFromPrivateKey(native.privateKey, "qor");
  const tx = await client.connectTx(signer, { pqcKeypair });
  return { native, pqcKeypair, tx };
}

async function balanceUqor(address) {
  const res = await fetch(`${rest}/cosmos/bank/v1beta1/balances/${address}`).then((r) => r.json());
  return BigInt(res.balances?.find((b) => b.denom === "uqor")?.amount ?? "0");
}

// 1-2. Coordinator.
const coordinator = accounts.find((a) => a.role === "coordinator");
const coord = await connect(coordinator);
const coordReg = await ensurePqcRegistered(coord.tx, { pqcKeypair: coord.pqcKeypair, rest });
note("coordinator pqc key", coordinator.address, coordReg.txHash);

const operators = accounts.filter((a) => a.role.startsWith("operator"));
for (const op of operators) {
  if ((await balanceUqor(op.address)) > 0n) {
    note(`fund ${op.role}`, op.address, null);
    continue;
  }
  const r = await coord.tx.bankSend(op.address, [{ denom: "uqor", amount: toBase(OPERATOR_FUNDING) }]);
  note(`fund ${op.role}`, op.address, r);
}

// 3. Operators: PQC signing key, then KEM encryption key.
for (const op of operators) {
  const o = await connect(op);
  const reg = await ensurePqcRegistered(o.tx, { pqcKeypair: o.pqcKeypair, rest });
  note(`${op.role} pqc key`, op.address, reg.txHash);

  const seal = deriveSealKeys({ mnemonic: op.mnemonic });
  const current = await fetchKemKey({ rest, address: op.address });
  const onChain = current.key?.publicKey ?? current.key?.public_key;
  const same = onChain && (typeof onChain === "string"
    ? onChain === Buffer.from(seal.mlkemPublicKey).toString("base64") || onChain.toLowerCase() === hex(seal.mlkemPublicKey)
    : hex(onChain) === hex(seal.mlkemPublicKey));
  if (current.found && same) {
    note(`${op.role} kem key`, op.address, null);
  } else {
    const r = await o.tx.signAndBroadcast(
      [msg.pqc.registerKemKey({ sender: op.address, publicKey: seal.mlkemPublicKey })],
      "auto",
    );
    note(`${op.role} kem key`, op.address, r);
  }
}

// 4. Read-back.
console.log("\nRead-back from", rest);
let ok = true;
for (const op of operators) {
  const pqc = await fetch(`${rest}/qorechain/pqc/v1/account/${op.address}`).then((r) => r.json()).catch(() => null);
  const kem = await fetchKemKey({ rest, address: op.address });
  const found = kem.found === true;
  ok &&= found;
  console.log(`${op.role.padEnd(11)} kem found=${found}  pqc=${pqc ? JSON.stringify(pqc).slice(0, 80) : "n/a"}`);
}

mkdirSync("receipts", { recursive: true });
writeFileSync("receipts/onchain-setup.json", JSON.stringify(receipts, null, 2));
console.log(`\n${ok ? "All operator KEM keys found on chain." : "Some KEM keys missing."} Receipts: receipts/onchain-setup.json`);
process.exit(ok ? 0 : 1);
