// The quorum rules (lib/quorum-core.mjs) against scripted chain histories.
// No network: transactions and files are fixtures built with real hashes, so
// each refusal below fails for exactly one reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readQuorum } from "../lib/quorum-core.mjs";
import { memo, sha3 } from "../lib/protocol.mjs";

const COORD = "qor1coordinator";
const [A, B, C, D, OUT] = ["qor1alice", "qor1bob", "qor1carol", "qor1dave", "qor1outsider"];
const enc = (o) => new TextEncoder().encode(JSON.stringify(o, null, 2) + "\n");

function world() {
  const files = new Map();
  const txs = [];
  const noKem = new Set();
  let height = 100;
  const tx = (from, to, text, extra = {}) => {
    const t = { hash: `TX${txs.length}`, height: height++, code: 0, memo: text, from, to, hybrid: true, ...extra };
    txs.push(t);
    return t;
  };
  const w = {
    files, txs, noKem, tx,
    epoch(n, members, { from = COORD, countOverride, tamper = false } = {}) {
      const bytes = enc({ protocol: "quorate/1", chainId: "test", epoch: n, members, envelope: "AA==" });
      files.set(`epoch-${n}.json`, tamper ? enc({ protocol: "quorate/1", chainId: "test", epoch: n, members: [...members, OUT], envelope: "AA==" }) : bytes);
      return tx(from, COORD, memo.epoch({ epoch: n, members: countOverride ?? members.length, envHash: sha3(bytes) }));
    },
    advisory(id, epoch, { from = COORD, blob = `ciphertext of ${id}`, store = true } = {}) {
      const bytes = new TextEncoder().encode(blob);
      if (store) files.set(`${id}.blob`, bytes);
      const blobHash = sha3(bytes);
      tx(from, COORD, memo.adv({ id, epoch, height: 9999, blobHash }));
      return blobHash;
    },
    ack(from, id, epoch, blobHash, extra = {}) {
      return tx(from, extra.to ?? COORD, memo.ack({ id, epoch, blobHash }), extra);
    },
    read() {
      return readQuorum({
        coordinator: COORD,
        readFile: async (name) => files.get(name) ?? null,
        fetchTxs: async () => txs,
        hasKem: async (a) => !noKem.has(a),
      });
    },
  };
  return w;
}

const reasons = (r) => r.rejected.map((x) => x.reason);
const adv = (r, id) => r.advisories.find((a) => a.id === id);

test("valid acknowledgements count and the quorum needs more than two thirds", async () => {
  const w = world();
  w.epoch(1, [A, B, C]);
  const h = w.advisory("QSA-1", 1);
  w.ack(A, "QSA-1", 1, h);
  w.ack(B, "QSA-1", 1, h);
  let r = await w.read();
  assert.equal(adv(r, "QSA-1").ready, 2);
  assert.equal(adv(r, "QSA-1").needed, 3);
  assert.equal(adv(r, "QSA-1").quorate, false, "2 of 3 is exactly two thirds, not more");
  w.ack(C, "QSA-1", 1, h);
  r = await w.read();
  assert.equal(adv(r, "QSA-1").quorate, true);
  assert.deepEqual(r.rejected, []);
  assert.equal(adv(r, "QSA-1").blobMatches, true);
});

test("thresholds: 3 of 4 is quorate, 2 of 4 is not, 1 of 1 is", async () => {
  const w = world();
  w.epoch(1, [A, B, C, D]);
  const h = w.advisory("QSA-1", 1);
  w.ack(A, "QSA-1", 1, h);
  w.ack(B, "QSA-1", 1, h);
  assert.equal(adv(await w.read(), "QSA-1").quorate, false);
  w.ack(C, "QSA-1", 1, h);
  const r = await w.read();
  assert.equal(adv(r, "QSA-1").quorate, true);
  assert.equal(adv(r, "QSA-1").needed, 3);

  const solo = world();
  solo.epoch(1, [A]);
  const hs = solo.advisory("QSA-1", 1);
  solo.ack(A, "QSA-1", 1, hs);
  assert.equal(adv(await solo.read(), "QSA-1").quorate, true);
});

test("a record without the ML-DSA-87 layer is refused", async () => {
  const w = world();
  w.epoch(1, [A]);
  const h = w.advisory("QSA-1", 1);
  w.ack(A, "QSA-1", 1, h, { hybrid: false });
  const r = await w.read();
  assert.equal(adv(r, "QSA-1").ready, 0);
  assert.deepEqual(reasons(r), ["not hybrid-signed"]);
});

test("anchors count only from the coordinator", async () => {
  const w = world();
  w.epoch(1, [A], { from: OUT });
  const r = await w.read();
  assert.equal(r.epochs.length, 0);
  assert.deepEqual(reasons(r), ["epoch anchor not from the coordinator"]);

  const w2 = world();
  w2.epoch(1, [A]);
  w2.advisory("QSA-1", 1, { from: A });
  const r2 = await w2.read();
  assert.equal(r2.advisories.length, 0);
  assert.deepEqual(reasons(r2), ["adv anchor not from the coordinator"]);
});

test("an epoch file that does not match its anchor is refused, and everything that depends on it", async () => {
  const w = world();
  w.epoch(1, [A, B], { tamper: true }); // someone slipped an outsider into the published file
  const h = w.advisory("QSA-1", 1);
  w.ack(OUT, "QSA-1", 1, h);
  const r = await w.read();
  assert.equal(r.epochs.length, 0);
  assert.equal(r.advisories.length, 0);
  assert.deepEqual(reasons(r), [
    "epoch 1 file does not match its anchor",
    "names unknown epoch 1",
    "acknowledges an unknown advisory",
  ]);
});

test("missing epoch file, wrong member count, and members without an encryption key are refused", async () => {
  const w = world();
  w.epoch(1, [A]);
  w.files.delete("epoch-1.json");
  assert.deepEqual(reasons(await w.read()), ["epoch-1.json is missing"]);

  const w2 = world();
  w2.epoch(1, [A, B], { countOverride: 3 });
  assert.deepEqual(reasons(await w2.read()), ["epoch 1 member count does not match"]);

  const w3 = world();
  w3.noKem.add(B);
  w3.epoch(1, [A, B]);
  assert.deepEqual(reasons(await w3.read()), ["epoch 1 has members without an encryption key"]);
});

test("acknowledgements that do not match are refused, each for its own reason", async () => {
  const w = world();
  w.epoch(1, [A, B, C]);
  const h = w.advisory("QSA-1", 1);
  w.ack(A, "QSA-2", 1, h);                            // unknown advisory
  w.ack(A, "QSA-1", 1, h, { to: B });                 // not sent to the coordinator
  w.ack(OUT, "QSA-1", 1, h);                          // not a member
  w.ack(A, "QSA-1", 2, h);                            // wrong epoch
  w.ack(B, "QSA-1", 1, sha3(new TextEncoder().encode("tampered copy"))); // wrong ciphertext
  w.ack(C, "QSA-1", 1, h);                            // valid
  w.ack(C, "QSA-1", 1, h);                            // duplicate
  const r = await w.read();
  assert.equal(adv(r, "QSA-1").ready, 1);
  assert.deepEqual(reasons(r), [
    "acknowledges an unknown advisory",
    "not sent to the coordinator",
    "sender is not a member of epoch 1",
    "names epoch 2, the advisory is epoch 1",
    "blob hash does not match the anchored advisory",
    "duplicate acknowledgement",
  ]);
});

test("an acknowledgement recorded before the anchor does not count", async () => {
  const w = world();
  w.epoch(1, [A]);
  const h = w.advisory("QSA-1", 1);
  // Same block order as the chain would return, but the ack claims an earlier height.
  w.ack(A, "QSA-1", 1, h, { height: 1 });
  const r = await w.read();
  assert.equal(adv(r, "QSA-1").ready, 0);
  assert.deepEqual(reasons(r), ["comes before the advisory anchor"]);
});

test("a member removed in a later epoch cannot count toward that epoch's advisories", async () => {
  const w = world();
  w.epoch(1, [A, B, C]);
  const h1 = w.advisory("QSA-1", 1);
  w.epoch(2, [A, B]);
  const h2 = w.advisory("QSA-2", 2);
  w.ack(C, "QSA-1", 1, h1); // still counts for the epoch it belonged to
  w.ack(C, "QSA-2", 2, h2); // refused: not a member of epoch 2
  const r = await w.read();
  assert.equal(adv(r, "QSA-1").ready, 1);
  assert.equal(adv(r, "QSA-2").ready, 0);
  assert.deepEqual(reasons(r), ["sender is not a member of epoch 2"]);
});

test("an advisory whose ciphertext file is missing is shown as missing, not as matching", async () => {
  const w = world();
  w.epoch(1, [A]);
  w.advisory("QSA-1", 1, { store: false });
  const a = adv(await w.read(), "QSA-1");
  assert.equal(a.blobBytes, null);
  assert.equal(a.blobMatches, false);
});

test("transactions that are not Quorate records are ignored", async () => {
  const w = world();
  w.epoch(1, [A]);
  w.tx(A, COORD, "thanks for the coffee");
  w.tx(A, COORD, "quorate/1 ack QSA-1 epoch one blob nope");
  const r = await w.read();
  assert.deepEqual(r.rejected, []);
});
