// Checks that a draft sealed the way the Advisory tab seals it opens for the
// right operators. It uses the keys exactly as the browser receives them from
// the read-only server (/api/epoch/current, base64), then opens the result
// with each operator's own ML-KEM secret from .keys/accounts.json.
//
//   node scripts/check-draft-interop.mjs [server-url]
import { readFileSync } from "node:fs";
import { deriveSealKeys, openBatch, openEpochKey, sealBatch, sealEpochKey } from "@qorechain/qoreseal";

const base = process.argv[2] ?? "http://localhost:8787";
const epoch = await fetch(`${base}/api/epoch/current`).then((r) => r.json());
const members = epoch.members.filter((m) => m.mlkemPublicKey);
const fromB64 = (s) => Uint8Array.from(Buffer.from(s, "base64"));

// Same calls as web/src/AdvisoryView.tsx.
const epochKey = { epoch: BigInt(epoch.epoch + 1), key: crypto.getRandomValues(new Uint8Array(32)) };
const envelope = sealEpochKey({
  chainId: epoch.chainId, purpose: "epoch-key:quorate-advisories", epochKey, mode: "mlkem",
  recipients: members.map((m) => ({ mlkemPublicKey: fromB64(m.mlkemPublicKey) })),
});
const blob = sealBatch({ epochKey, context: "quorate:advisories", batchIndex: 3, data: new TextEncoder().encode('{"id":"QSA-003","title":"interop check"}') }).blob;

const { accounts } = JSON.parse(readFileSync(".keys/accounts.json", "utf8"));
const memberSet = new Set(members.map((m) => m.address));
let failures = 0;
for (const a of accounts.filter((x) => x.role.startsWith("operator"))) {
  const expectOpen = memberSet.has(a.address);
  let opened = false;
  try {
    const ek = openEpochKey({ chainId: epoch.chainId, purpose: "epoch-key:quorate-advisories", envelope, keys: deriveSealKeys({ mnemonic: a.mnemonic }) });
    opened = JSON.parse(Buffer.from(openBatch({ blob, keys: [ek] }).data)).id === "QSA-003";
  } catch { opened = false; }
  const ok = opened === expectOpen;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${a.role} ${expectOpen ? "opens" : "cannot open"} the draft (epoch ${epoch.epoch + 1})`);
}
process.exit(failures ? 1 : 0);
