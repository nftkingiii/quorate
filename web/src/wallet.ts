// QoreX, native lane. The page builds protobuf messages; QoreX shows them,
// sets the fee, adds the hybrid secp256k1 + ML-DSA-87 signature and
// broadcasts (signAndBroadcast). Nothing here sees a signing key.
import { getQorexNative, hasCapability } from "@qorechain/qorex-types";
import type { QorexNativeProvider } from "@qorechain/qorex-types";
import { buildRegisterKemKeyMessage } from "@qorechain/qoreseal";

export const CHAIN_ID = "qorechain-diana";

export type TxOutcome = { txHash: string; code: number; height?: number; shield: string };

export function qorex(): QorexNativeProvider | null {
  const n = getQorexNative();
  return n ?? null;
}

/** Whether QoreX (or its official test double) is in the page. */
export const isMock = () => typeof window !== "undefined" && "__qorexMock" in window;

export async function connect(): Promise<{ address: string; name: string }> {
  const n = qorex();
  if (!n) throw new Error("QoreX was not found in this browser. Install the QoreX extension and switch it to Testnet.");
  await n.enable(CHAIN_ID);
  const key = await n.getKey(CHAIN_ID);
  return { address: key.bech32Address, name: key.name };
}

async function send(messages: { typeUrl: string; value: Uint8Array }[], memo?: string, gasLimit?: number): Promise<TxOutcome> {
  const n = qorex();
  if (!n) throw new Error("QoreX is not connected");
  if (!hasCapability(n, "signAndBroadcast")) throw new Error("This QoreX version cannot sign QoreChain transactions for a page. Update QoreX.");
  const res = await n.signAndBroadcast({ chainId: CHAIN_ID, messages, memo, gasLimit });
  if (res.code !== 0) throw new Error(`The chain refused the transaction (code ${res.code}, ${res.txHash})`);
  return res as TxOutcome;
}

/** MsgRegisterKEMKey for the connected account: publishes the ML-KEM-1024 key others seal to. */
export function registerSealingKey(sender: string, mlkemPublicKey: Uint8Array) {
  return send([buildRegisterKemKeyMessage({ sender, mlkemPublicKey })], undefined, 300000);
}

/** An acknowledgement: 1 uqor to the coordinator, the record in the memo. */
export function acknowledge(from: string, coordinator: string, memo: string) {
  return send([{ typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: encodeMsgSend(from, coordinator, "uqor", "1") }], memo, 250000);
}

// Minimal protobuf for cosmos.bank.v1beta1.MsgSend:
//   1 from_address (string), 2 to_address (string), 3 amount (repeated Coin {1 denom, 2 amount})
const enc = new TextEncoder();
function varint(n: number): number[] {
  const out: number[] = [];
  while (n > 127) { out.push((n & 127) | 128); n >>>= 7; }
  out.push(n);
  return out;
}
function field(no: number, bytes: Uint8Array): number[] {
  return [(no << 3) | 2, ...varint(bytes.length), ...bytes];
}
export function encodeMsgSend(from: string, to: string, denom: string, amount: string): Uint8Array {
  const coin = new Uint8Array([...field(1, enc.encode(denom)), ...field(2, enc.encode(amount))]);
  return new Uint8Array([...field(1, enc.encode(from)), ...field(2, enc.encode(to)), ...field(3, coin)]);
}

/** Turns QoreX and chain refusals into a sentence a person can act on. */
export function explain(err: unknown): string {
  const m = (err as Error)?.message ?? String(err);
  if (/reject|denied|cancel/i.test(m)) return "You declined the request in QoreX. Nothing was sent.";
  if (/unsupported chain|selected network|network/i.test(m) && /diana|vladi|network/i.test(m)) return "Switch QoreX to Testnet (qorechain-diana) and try again.";
  if (/insufficient|funds/i.test(m)) return "This account needs a little test QOR for the fee. Claim it from the faucet and try again.";
  // QoreX answers "wallet is locked" instead of opening itself, and a page cannot open an extension's popup.
  if (/wallet is locked|locked/i.test(m)) return "QoreX is locked. Click the QoreX icon in your browser's toolbar, unlock it, then click the button here again.";
  if (/is managed by the wallet itself/i.test(m)) return "QoreX does not let websites send this message: it reserves it for the wallet itself. Nothing was sent.";
  return m;
}
