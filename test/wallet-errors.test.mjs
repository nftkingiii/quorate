// QoreX refusals become sentences a person can act on (web/src/wallet.ts).
// The texts are QoreX's documented messages plus the one a real extension
// returned on 19 November 2026.
import { test } from "node:test";
import assert from "node:assert/strict";
import { explain } from "../web/src/wallet.ts";

test("a locked wallet says how to unlock it", () => {
  assert.match(explain(new Error("QoreX: wallet is locked")), /QoreX is locked\. Click the QoreX icon/);
});

test("a wallet-managed message says nothing was sent", () => {
  const m = explain(new Error("QoreX: /qorechain.pqc.v1.MsgRegisterKEMKey is managed by the wallet itself, not by a website"));
  assert.match(m, /does not let websites send this message/);
  assert.match(m, /Nothing was sent/);
});

test("a rejected signature says nothing was sent", () => {
  assert.match(explain(new Error("QoreX: signature rejected")), /declined the request in QoreX\. Nothing was sent/);
});

test("anything unrecognised is passed through unchanged", () => {
  assert.equal(explain(new Error("Transaction failed on-chain (code 5).")), "Transaction failed on-chain (code 5).");
});
