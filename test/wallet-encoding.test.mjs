// The hand-written MsgSend encoder (web/src/wallet.ts) must produce exactly
// the bytes the reference protobuf implementation produces, since QoreX signs
// whatever bytes the page hands it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MsgSend } from "cosmjs-types/cosmos/bank/v1beta1/tx";
import { encodeMsgSend } from "../web/src/wallet.ts";

const cases = [
  ["qor1d29r40km6savysgcqm4zy6308ya2kljd8dcazm", "qor1f78j6m6wfvpn5468tpznhcs7p4lm30hejv3zj0", "uqor", "1"],
  ["qor1gxxaq0vznphf4jmhgkyhg8af0nzkqwfrl6a6qd", "qor1nugsk7fcvcufx5ad4y82zfjwn3kyrn85e3d6cx", "erc20:0x97143B771D34ddb9130b807b135Ae675A5a963CA", "1000000000000000000000"],
];

for (const [from, to, denom, amount] of cases) {
  test(`MsgSend ${denom} ${amount} matches cosmjs-types byte for byte`, () => {
    const reference = MsgSend.encode(MsgSend.fromPartial({ fromAddress: from, toAddress: to, amount: [{ denom, amount }] })).finish();
    assert.deepEqual(Buffer.from(encodeMsgSend(from, to, denom, amount)), Buffer.from(reference));
  });
}

test("a long denom crosses the one-byte length boundary correctly", () => {
  const denom = "d".repeat(200);
  const reference = MsgSend.encode(MsgSend.fromPartial({ fromAddress: "a", toAddress: "b", amount: [{ denom, amount: "1" }] })).finish();
  assert.deepEqual(Buffer.from(encodeMsgSend("a", "b", denom, "1")), Buffer.from(reference));
});
