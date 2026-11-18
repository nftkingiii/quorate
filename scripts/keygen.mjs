// Creates the testnet demo accounts: one coordinator and four simulated
// validator operators. Secrets go to .keys/accounts.json (gitignored);
// only addresses are printed. Testnet only, never fund from mainnet.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { generateMnemonic, deriveNativeAccount } from "@qorechain/sdk";

const out = ".keys/accounts.json";
if (existsSync(out)) {
  console.error(`${out} already exists; refusing to overwrite.`);
  process.exit(1);
}

const roles = ["coordinator", "operator-1", "operator-2", "operator-3", "operator-4"];
const accounts = [];
for (const role of roles) {
  const mnemonic = generateMnemonic();
  const { address } = await deriveNativeAccount(mnemonic);
  accounts.push({ role, address, mnemonic });
}

mkdirSync(".keys", { recursive: true });
writeFileSync(out, JSON.stringify({ network: "qorechain-diana", accounts }, null, 2));
for (const a of accounts) console.log(`${a.role.padEnd(12)} ${a.address}`);
