// Independent quorum reader. Uses only public data: the chain and the
// ciphertext files in advisories/. It holds no keys. Rules: lib/quorum-core.mjs.
//
//   node scripts/quorum.mjs [coordinator-address] [advisories-dir]
import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_COORDINATOR, readQuorum as readCore } from "../lib/quorum-core.mjs";

export async function readQuorum(coordinator = DEFAULT_COORDINATOR, dir = "advisories") {
  const readFile = async (name) => (existsSync(`${dir}/${name}`) ? new Uint8Array(readFileSync(`${dir}/${name}`)) : null);
  return readCore({ coordinator, readFile });
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/quorum.mjs")) {
  const r = await readQuorum(process.argv[2] || undefined, process.argv[3] || undefined);
  console.log(`Coordinator ${r.coordinator}`);
  for (const e of r.epochs) console.log(`epoch ${e.epoch}: ${e.members.length} members, anchor ${e.anchor} @ ${e.height}`);
  for (const a of r.advisories) {
    console.log(`\n${a.id} (epoch ${a.epoch}, target height ${a.targetHeight}): ${a.ready}/${a.members} ready -> ${a.quorate ? "QUORATE" : "not quorate"}`);
    for (const m of a.roster) console.log(m.ack ? `  ready   ${m.address}  ${m.ack.tx} @ ${m.ack.height}` : `  waiting ${m.address}`);
  }
  if (r.rejected.length) {
    console.log("\nRejected records:");
    for (const x of r.rejected) console.log(`  ${x.tx}  ${x.from ?? ""}  ${x.advisory ?? ""}  ${x.reason}`);
  }
}
