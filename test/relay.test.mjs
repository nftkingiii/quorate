// The relay's gate (lib/relay.mjs): only the two sealing-account transaction
// shapes pass. Transactions here are real protobuf with dummy signatures; the
// relay never checks signatures (the chain does), it only checks the shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TxBody, TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { MsgSend } from "cosmjs-types/cosmos/bank/v1beta1/tx";
import { buildRegisterKemKeyMessage, generateSealKeys } from "@qorechain/qoreseal";
import { MAX_TX_BYTES, checkRelayTx, rateLimiter } from "../lib/relay.mjs";

const COORD = "qor1f78j6m6wfvpn5468tpznhcs7p4lm30hejv3zj0";
const SEALER = "qor144tdxkmh9w6768dnej6tykwv9dnt2k3taemq0x";
const OPERATOR = "qor1d29r40km6savysgcqm4zy6308ya2kljd8dcazm";
const OTHER = "qor1gxxaq0vznphf4jmhgkyhg8af0nzkqwfrl6a6qd";
const kemKey = generateSealKeys().mlkemPublicKey;

const tx = (messages, memo = "", signatures = 1) => TxRaw.encode(TxRaw.fromPartial({
  bodyBytes: TxBody.encode(TxBody.fromPartial({ messages, memo })).finish(),
  authInfoBytes: new Uint8Array([1]),
  signatures: Array.from({ length: signatures }, () => new Uint8Array(64)),
})).finish();
const pqcReg = { typeUrl: "/qorechain.pqc.v1.MsgRegisterPQCKeyV2", value: new Uint8Array([10, 3, 97, 98, 99]) };
const kem = (sender = SEALER) => buildRegisterKemKeyMessage({ sender, mlkemPublicKey: kemKey });
const send = ({ from = SEALER, to = COORD, amount = "1", denom = "uqor" } = {}) => ({
  typeUrl: "/cosmos.bank.v1beta1.MsgSend",
  value: MsgSend.encode(MsgSend.fromPartial({ fromAddress: from, toAddress: to, amount: [{ denom, amount }] })).finish(),
});
const sealerMemo = (op = OPERATOR) => `quorate/1 sealer ${op}`;
const check = (bytes) => checkRelayTx(bytes, COORD);

test("the two sealing-account shapes pass", () => {
  assert.deepEqual(check(tx([pqcReg])), { ok: true, kind: "pqc-key" });
  assert.deepEqual(check(tx([kem(), send()], sealerMemo())), { ok: true, kind: "kem-key-and-binding" });
});

test("a key registration with a memo, or bundled with anything, is refused", () => {
  assert.equal(check(tx([pqcReg], "hello")).ok, false);
  assert.equal(check(tx([pqcReg, send()], sealerMemo())).ok, false);
});

test("the key-and-binding transaction must be exactly right", () => {
  const cases = {
    "plain memo": tx([kem(), send()], "hello"),
    "ack memo instead of sealer": tx([kem(), send()], "quorate/1 ack QSA-1 epoch 1 blob " + "a".repeat(64)),
    "send to someone else": tx([kem(), send({ to: OTHER })], sealerMemo()),
    "more than 1 uqor": tx([kem(), send({ amount: "2" })], sealerMemo()),
    "another denom": tx([kem(), send({ denom: "ufoo" })], sealerMemo()),
    "send from a different account": tx([kem(), send({ from: OTHER })], sealerMemo()),
    "vouching for itself": tx([kem(), send()], sealerMemo(SEALER)),
    "messages in the other order": tx([send(), kem()], sealerMemo()),
    "send alone": tx([send()], sealerMemo()),
    "key alone": tx([kem()], sealerMemo()),
    "an extra message": tx([kem(), send(), send()], sealerMemo()),
  };
  for (const [name, bytes] of Object.entries(cases)) assert.equal(check(bytes).ok, false, name);
});

test("anything else is refused before it reaches the chain", () => {
  const vote = { typeUrl: "/cosmos.gov.v1.MsgVote", value: new Uint8Array([8, 1]) };
  assert.equal(check(tx([vote])).ok, false);
  assert.equal(check(tx([])).ok, false);
  assert.equal(check(tx([pqcReg], "", 2)).ok, false, "two signers");
  assert.equal(check(new Uint8Array([1, 2, 3, 4])).ok, false, "garbage");
  assert.equal(check(new Uint8Array()).ok, false, "empty");
  assert.equal(check(new Uint8Array(MAX_TX_BYTES + 1)).ok, false, "too large");
});

test("the rate limiter caps each visitor and everyone together, then resets", () => {
  let now = 0;
  const allow = rateLimiter({ perKey: 2, globalMax: 3, windowMs: 1000, now: () => now });
  assert.equal(allow("a"), true);
  assert.equal(allow("a"), true);
  assert.equal(allow("a"), false, "per visitor");
  assert.equal(allow("b"), true);
  assert.equal(allow("c"), false, "global cap");
  now = 1001;
  assert.equal(allow("a"), true, "new window");
});
