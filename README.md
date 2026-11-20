# Quorate

Embargoed security patches that only the current QoreChain validator set can open, and a post-quantum signed quorum confirming they are ready.

Built for Build Before Q-Day, the QoreChain Developer Fest, in the Encrypted Apps category.

## The problem

QoreChain upgrades by coordinated halt. Governance sets a height, every validator swaps the binary, and the chain restarts. Mainnet has done this five times since 14 October 2026, and several of those releases were security batches. Before such a fix is public, the foundation has to get it to the validators privately, and it needs to know they are ready before the height.

## What Quorate does

- **The chain supplies the recipients.** Quorate seals to the bonded validator set, using each operator's ML-KEM-1024 key from QoreChain's native encryption key registry. There is no contact list to maintain.
- **The epoch follows the set.** The advisory is sealed in the browser under an epoch key that is itself sealed to the current members ([QoreSeal](https://github.com/qorechain/qoreseal)). When a validator leaves the set the epoch rotates, so that validator cannot open the next advisory.
- **Readiness is signed.** Each operator decrypts locally and returns a "patched and ready" acknowledgement with a hybrid ML-DSA-87 signature, recorded on testnet. The coordinator tracks the quorum against the upgrade height.
- **Bad inputs are refused.** Tampered advisories and forged acknowledgements are rejected.

## Status

Work in progress. Done and checked so far:

| What | Where | Result |
|---|---|---|
| Offline sealing proof | `scripts/proof-offline.mjs` | 9/9 checks: every operator opens the advisory, the removed operator is locked out of the next epoch, a tampered advisory is rejected |
| Demo set on testnet | `scripts/onchain-setup.mjs` | 13 transactions, all code 0, on `qorechain-diana` |
| Signing keys | `MsgRegisterPQCKeyV2` | 5 accounts, key type `hybrid`, `possession_proven: true` |
| Encryption keys | `MsgRegisterKEMKey` | 4 operators; the keys read back from `/qorechain/pqc/v1/kem/{address}` match byte for byte |
| Advisory scenario on testnet | `scripts/advisory-flow.mjs` | 14 hybrid-signed transactions: 2 epochs, 2 advisories, 8 acknowledgements (2 of them deliberately invalid) |
| Independent quorum check | `scripts/quorum.mjs` | Reads only the chain and `advisories/`, holds no keys. QSA-001 is 3/4 ready (quorate); QSA-002 is 3/3 ready (quorate). Two acknowledgements are rejected, for the right reasons |
| Tamper check | `scripts/quorum.mjs` on an edited copy | Adding operator-4 back into `epoch-2.json` breaks the anchor hash, so epoch 2, QSA-002 and its acknowledgements are all refused |
| Web app (local) | `web/`, `server/index.mjs` | Quorum, Advisory and Roster tabs read testnet and mainnet live through a read-only server that holds no keys |
| Draft sealing | `scripts/check-draft-interop.mjs` | Sealed the way the Advisory tab seals, using the keys exactly as the server hands them to the browser: operators 1–3 open the draft, operator 4 cannot |
| Real validator sets | Roster tab, 19 November 2026 | 0 of 8 mainnet and 0 of 4 testnet validators have an encryption key; their signing keys are hybrid, without proof of possession |
| QoreX operator flow | Operator tab driven by `@qorechain/qorex-wallet-mock` 0.1.0 | Connect, create a sealing key, register it through QoreX `signAndBroadcast` (shielded), be added in epoch 3, open QSA-003 locally, acknowledge through QoreX (shielded); `scripts/quorum.mjs` counts it: QSA-003 1/4 ready |
| Real QoreX finding | Builder's own QoreX extension, 19 November 2026 | QoreX refuses `MsgRegisterKEMKey` from websites ("managed by the wallet itself"), although its integration guide and wallet mock only reserve the ML-DSA-87 key messages. Hence the sealing account below. A report for `qorechain/qorex-integrations` is drafted |
| Sealing-account flow | Operator tab with a fresh QoreX-mock wallet that has no encryption key of its own | Connect, create a key, fund the sealing account through QoreX, register its signing key and publish its encryption key through the relay, bind both ways, open and acknowledge through QoreX; then lose the backup, rebind to a new sealing account, and the coordinator re-keys the next epoch (table below) |
| Backup safety | Operator tab | A wrong passphrase is refused; the right one restores the key, and it must match the sealing account bound on chain |
| Test suite | `npm test` (`test/*.test.mjs`) | 56/56 on Node 22 (testbench VM): every quorum refusal rule and threshold, epoch rotation, the two-way binding rules (one-sided, wrong pair, too late, rebinding), failed account reads never reading as "no key", the sealing-secret backup, MsgSend bytes identical to `cosmjs-types`, QoreX error messages, the relay's gate and rate limit, and the server's guard rails |
| Production build | `npm run build`, then `npm start` | Builds; every visitor loads 334 KB, and the Operator tab (2.7 MB, mostly the QoreChain SDK) loads only when opened |

The QoreX steps were exercised with the official QoreX wallet mock, a test double that signs for real on testnet with the same hybrid scheme. The real extension was tried once, which surfaced the `MsgRegisterKEMKey` refusal; the sealing-account flow avoids that message and has not yet been run end to end with the real extension.

Still to do: an operator acknowledgement from a real QoreX wallet, a public deployment, and the demo video.

### Sealing-account test (19 November 2026)

Operator `qor1hhd5njxjwjp3hhmu675rjwqutehfwpyekqacay`, a QoreX-mock wallet with no encryption key of its own.

| Step | Tx hash | Height |
|---|---|---|
| QoreX funds sealing account 1 `qor1p6z8yv0l2czjs7uf5lq74s4758a0vl6qzzkvcs` | `CD912BF89B7173CA1755086FDE76A0CB5FEFABC7D9AF739DDDE2387F7D0D1764` | 10388061 |
| Sealing account 1 publishes its ML-KEM-1024 key and the `sealer` record (relay, hybrid) | `0CE754D8FB6630AFB0FD0B0F9D5716C3A07CC25BAC779AB169384218E988EBF2` | 10388083 |
| QoreX sends the `bind` record | `8C9084A80E7920C109C06B64FF52BA28CCC6BCFF388BCFD27BC58E1D9882F4F7` | 10388095 |
| Epoch 5 anchor (sealing account 1 named in the file) | `5EF45C7CC8EB86D0B16C95261E384EEB74FA90FAA5E28ECD4FB55240AA157E19` | 10388191 |
| QSA-004 anchor (sealed to sealing account 1, whose backup was then lost in the test) | `DCBEA88C65D5CE375A23942F9C59CAB22EA1C4605E9A79F179BF3AA17AA5E3AE` | 10388208 |
| Epoch 6 anchor (the coordinator detects the moved key; sealing account 2 `qor1jx4zhu5ng34lr682dyltt3f3vjk6g23rtva8qa` named) | `9A07B9F6BC52768DEC1A2DC3710D13891C494F7F6225C6670CF95888C61D6698` | 10409451 |
| QSA-005 anchor | `E913CB9F28196FE5DDF3AACCDFA395C2BE13ACCEDF86DD71C32E2CAD3ECA05B1` | 10409470 |

The sealing accounts' key registrations, the second funding and binding, and the QSA-005 acknowledgement (block 10,409,495) are listed by `scripts/quorum.mjs` and on each account's explorer page. The reader finds epochs 5 and 6 each valid for the binding in force when anchored, QSA-005 1/4 ready, QSA-004 0/4 (its key was lost), and no new refusals.

### QoreX wallet test (19 November 2026)

| Step | Tx hash | Height |
|---|---|---|
| Fund the test wallet `qor1d29r40km6savysgcqm4zy6308ya2kljd8dcazm` (3 QOR) | `4461A34388E2FC8F396B5F2633880A74D364A38A1105C8F559DF3698B9C50A1D` | |
| Test wallet registers its ML-KEM-1024 key through QoreX `signAndBroadcast` | `FF4874887907DCE82E7F9626EA6631E51E0AE30131B56170B4BE56592C2FD585` | 10361739 |
| Epoch 3 anchor (operators 1–3 and the test wallet) | `9577C7B29B68818E34E4196179AD895FBFC28FC4F74024A3345A2154274C3AC2` | 10361786 |
| QSA-003 anchor | `0052D7A2C4C386422E95CA54BEA324D462FBA16D1EEDA44D421A2DC05552B96D` | 10361794 |
| Test wallet acknowledges QSA-003 through QoreX `signAndBroadcast` | `0863F08758E81A032F6EF923605DEAAF825A9FD4D335752672BA948B827EEC65` | 10361881 |

## The app

```sh
npm install
npm run dev:server   # read-only server on :8787 (reads the chain, applies lib/quorum-core.mjs)
npm run dev:web      # Vite on :5173, proxies /api and /advisories to the server
npm test             # 56 tests, no network needed
npm run build && npm start   # production: the read-only server serves web/dist on $PORT (default 8787)
```

Coordinator actions (signed by the coordinator key in `.keys/`):

```sh
node scripts/coordinator.mjs rotate --add qor1...      # next epoch, sealed to the new member list
node scripts/coordinator.mjs rotate                    # re-keys members whose sealing account moved (or --refresh)
node scripts/coordinator.mjs advisory --id QSA-004 --title "..." --simulated
```

The dev server also proxies `/qore-rest` to the testnet REST API. That exists only so the QoreX wallet mock, which runs inside the page, can reach the chain during tests; the real QoreX extension calls the chain itself, and the production server has no such route.

QoreChain's public REST endpoints send no CORS headers, so the browser can neither read the chain nor broadcast to it directly. `server/index.mjs` does both for the page, and holds no keys. Reads are `GET` only, serve only the files in `advisories/`, and are cached for 2–30 seconds. Its one write route, `POST /api/relay`, forwards transactions already signed in the browser, and only two shapes (`lib/relay.mjs`): a sealing account's ML-DSA-87 key registration, and its ML-KEM-1024 key plus a 1 uqor `sealer` record to the coordinator. Each is at most 16 KB, with 10 per visitor per 10 minutes and 200 overall. The relay cannot create or change a transaction; the chain checks every signature. Sealing happens in the browser with `@qorechain/qoreseal`; only ciphertext and hashes leave the page.

- **Quorum.** Each advisory as a ring of operator lamps, lit when an acknowledgement counts, with the threshold tick, the halt height and the blocks left (block time measured over the last 1,000 blocks). Refused records list why they do not count.
- **Advisory.** Anchored ciphertext to download, and a draft composer that seals to the current epoch's ML-KEM-1024 keys as read from the chain. Anchoring stays with the coordinator script (`scripts/coordinator.mjs`); the button says so.
- **Operator.** For a validator operator with QoreX, one step at a time. QoreX will not let a website register an encryption key, so the page runs a small **sealing account** for the operator:
  1. Connect QoreX.
  2. Create one 32-byte secret in the browser; the sealing account, its ML-DSA-87 key and its ML-KEM-1024 key are all derived from it. Download a passphrase-encrypted backup (PBKDF2-SHA-256, 600,000 rounds, then AES-256-GCM, with the operator, network and key id bound in).
  3. QoreX funds the sealing account with 0.3 test QOR.
  4. The sealing account registers its ML-DSA-87 key, then publishes its ML-KEM-1024 key with its half of the binding. Both are signed in the browser and sent through the relay.
  5. QoreX sends the operator's half of the binding.
  6. Once the coordinator includes the operator, advisories open in the browser and are acknowledged through QoreX.

  The secret lives in page memory only: never in local storage, never sent to the server. A lost backup can be replaced by binding a new sealing account; advisories sealed to the old key stay closed, and the page says so.
- **Roster.** The demo set beside the real testnet and mainnet validator sets, with each operator's signing key and encryption key status.

The interface had an [unslop](https://github.com/heydamir/unslop) pass (Damir Sokolovsky, CC BY 4.0).

## How it works

Every record is a hybrid-signed QoreChain transaction (secp256k1 + ML-DSA-87). The reader only accepts transactions that carry the `PQCHybridSignature` extension and the chain's `pqc_hybrid_verify` event. Records are transaction memos, at most 256 characters:

```
quorate/1 epoch <n> members <count> env <sha3-256 of advisories/epoch-<n>.json>
quorate/1 adv <id> epoch <n> height <target height> blob <sha3-256 of advisories/<id>.blob>
quorate/1 ack <id> epoch <n> blob <sha3-256 of the advisory blob>
quorate/1 bind <sealing account>        from the operator: "my encryption key lives on this account"
quorate/1 sealer <operator account>     from the sealing account: "I hold the key for this operator"
```

A binding counts when both halves are on chain, hybrid-signed and sent to the coordinator, and only for epochs anchored after it. An epoch file names, under `sealers`, the members reached through a sealing account. Epoch numbers can skip when one coordinator run makes several membership changes; only the final epoch is published.

1. **Epoch.** The coordinator reads each member's ML-KEM-1024 key from the chain, seals a fresh epoch key to them (QoreSeal `EpochKeyManager`), publishes `advisories/epoch-<n>.json` (the member list and the sealed key), and anchors its hash on chain.
2. **Advisory.** The advisory is encrypted under the epoch key (QoreSeal `sealBatch`), published as `advisories/<id>.blob`, and anchored with its hash and the target upgrade height.
3. **Acknowledgement.** An operator checks both anchors against the files, opens the epoch key with its own ML-KEM secret, decrypts locally, and sends an `ack` transaction to the coordinator, signed with its registered ML-DSA-87 key.
4. **Quorum.** An acknowledgement counts only when the sender belongs to the advisory's epoch, the epoch and blob hash match the anchor, and it comes after the anchor. One acknowledgement per operator. "Quorate" means more than two thirds of the members have acknowledged.
5. **Leaving the set.** Removing a member starts a new epoch with a fresh key that the removed member cannot open. Its acknowledgements for later advisories are rejected.

Everything in `advisories/` is ciphertext. Plaintext advisories and epoch keys never leave the operator's or coordinator's machine.

### Advisory scenario transactions (18 November 2026)

| Step | Tx hash | Height |
|---|---|---|
| Epoch 1 anchor (operators 1–4) | `831736524FAFE75FAACF9641A7021CF6802B77D829CF973AEC16B0BD2BFF2BC9` | 10331583 |
| QSA-001 anchor | `A75D1E7A538974938299A7D531BDF7EDB8BA68F9EBA0D991F17D1A47418D4FD6` | 10331586 |
| Operator 1 ack QSA-001 | `ABDE903492DE92FAF51B0E6915118D2B94C041E69E5E28C3EBB72032730B3BB5` | 10331590 |
| Operator 2 ack QSA-001 | `BEBFDD792644CDE23F6657DA1B1548E3B60DED6891116B10ABF91183B230244E` | 10331594 |
| Operator 3 ack QSA-001 | `FBD6105DAD50662124231CA28C4C93FA4B9881C774E399C6945E3A307C1BF7FE` | 10331599 |
| Epoch 2 anchor (operator 4 removed) | `ADDDD7B2838297F90916CF3681FCBFB81EF5AE715EE55727489D4AE9318BF5D6` | 10331602 |
| QSA-002 anchor | `1D8DCA349F546A0AAA342CD5E8FA72D11C1AABFD2613AD39C7E94CEC601BCD9F` | 10331606 |
| Operator 4 ack QSA-002 (**rejected**: not a member of epoch 2) | `994C3218B79055A2B827539F70787333F965B84F3C06F3BDEE0944E5C0F53CF2` | 10331610 |
| Operator 3 ack of a tampered copy (**rejected**: blob hash) | `F5DE26C580B3342049110B2795038376CB07BDF12294A9239E2EF59D9827F3AA` | 10331613 |
| Operator 1 ack QSA-002 | `2AA7767F17596BE44545D851C399E62F2ACA45701A2EF417CA4CEABA43D1F082` | 10331617 |
| Operator 2 ack QSA-002 | `98EAFFBBDD4645472052BFD95390AB094EC07DB9D8D7A36AA95A816C5EE69D1C` | 10331621 |
| Operator 3 ack QSA-002 | `BC77014E44BA8082B162966575D9E1693BD64A576A2BB7CA8F6AEC46855627E7` | 10331625 |

Both advisories are marked `simulated: true`. They describe no real QoreChain vulnerability.

### Real validators vs. the demo set

The four operators are testnet accounts this project controls, and they are labelled as **simulated**. Quorate also reads the real bonded sets. On 18 November 2026, none of the 4 testnet or 8 mainnet validator operator accounts had an encryption key registered.

## Testnet addresses (qorechain-diana)

| Role | Address |
|---|---|
| Coordinator | `qor1f78j6m6wfvpn5468tpznhcs7p4lm30hejv3zj0` |
| Operator 1 (simulated) | `qor1gxxaq0vznphf4jmhgkyhg8af0nzkqwfrl6a6qd` |
| Operator 2 (simulated) | `qor1nugsk7fcvcufx5ad4y82zfjwn3kyrn85e3d6cx` |
| Operator 3 (simulated) | `qor1aq8tx4y2jke8snqgu6ajdav23nyyw7cznt9c4q` |
| Operator 4 (simulated) | `qor17p9ekrjnwcd5qmwjhz4g5dc38w6f9dx9f2anxt` |

### Setup transactions (18 November 2026)

| Step | Tx hash | Height |
|---|---|---|
| Coordinator ML-DSA-87 key | `25CF49BB103040674C7296402F5133F8A76C972DBEDE8F3E292E353ED80BA93B` | 10330985 |
| Fund operator 1 | `F5456E2F58D507BE1068E0BF7C5C38DA78F13023E76D856A016EB20186E0AE0F` | 10330989 |
| Fund operator 2 | `10D2B8B55585FBD9AEB43949597640791FE4E6E56C2046A74A924015F8D8E00E` | 10330992 |
| Fund operator 3 | `8D721F8E08D2AD9F7E802B2B2BA6F4889FC89A387FC698F6563C3F022E9983E9` | 10330996 |
| Fund operator 4 | `B5DF67D310F68D641A960F5DB83F76CB83769F5B6FC3EE25FE3CEDA10991ABC6` | 10330999 |
| Operator 1 ML-DSA-87 key | `C44F995DD79B9EC7985599D7165D39B95D4F95188206EFD7171060C0BDC2BC59` | 10331004 |
| Operator 1 ML-KEM-1024 key | `AA34C140B2AB5A5203CCF0B95084D48134FBF50A05147F531D29AAF88FA3EC4C` | 10331008 |
| Operator 2 ML-DSA-87 key | `2DE91327EB93BE4FC7905E288C248F214E94B2A6B86158EDD7AA0316B26826EE` | 10331012 |
| Operator 2 ML-KEM-1024 key | `C0656AC8241BAFBDD260C0FDC72CFEECB3AC1EE046FC49182AE09B425F26C005` | 10331016 |
| Operator 3 ML-DSA-87 key | `BEDFC33D04BAE5FCF85E5910BD6055494E7F912DF282F621F69B1E7B49C245BA` | 10331020 |
| Operator 3 ML-KEM-1024 key | `016BA979E2B121540D9FA77795DA2A8CBEAD94FD6A3BE1D12D6CF0B2D79D93DE` | 10331024 |
| Operator 4 ML-DSA-87 key | `EAFA6A39B43CB4017F22C44C7AD7C7FFB1C2A9644E242821635815AAEB88C7F5` | 10331028 |
| Operator 4 ML-KEM-1024 key | `3FD450771F07B00969FBE15E559DC481AA7AB55576BDE3EE1C552CA9ABFE05CD` | 10331032 |

To check one: `curl https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/<hash>`

## Run it

Node.js 20 or newer.

```sh
npm install
node scripts/keygen.mjs          # creates .keys/accounts.json (gitignored), prints addresses
node scripts/proof-offline.mjs   # offline sealing proof, no network
# Fund the coordinator from https://dashboard.qorechain.io/faucet, then:
node scripts/onchain-setup.mjs   # registers keys on testnet; safe to re-run
node scripts/advisory-flow.mjs   # the scenario above (runs once per advisories/ folder)
node scripts/quorum.mjs          # verify from public data only; no keys needed
```

`scripts/quorum.mjs` works on a fresh clone with nothing but `npm install`: it reads this repository's `advisories/` folder and the testnet.

The generated accounts are for testnet only. Never send mainnet funds to them.

## How it was built

With an AI coding agent (Claude Code). What the AI wrote, what the builder decided, how each claim was checked and where the AI got things wrong are in [AI_USAGE.md](AI_USAGE.md).

## Credits

Built on the QoreChain kits, used under Apache-2.0:

- [`@qorechain/sdk`](https://www.npmjs.com/package/@qorechain/sdk) 0.14.0: accounts, hybrid signing, PQC and KEM key registration
- [`@qorechain/qoreseal`](https://github.com/qorechain/qoreseal) 0.1.0: ML-KEM-1024 envelopes and epoch keys

Also: [`@qorechain/qorex-types`](https://github.com/qorechain/qorex-integrations) 0.1.0 for QoreX detection and `signAndBroadcast`, `@qorechain/qorex-wallet-mock` 0.1.0 for the wallet test, React and Vite for the app, [`@noble/hashes`](https://github.com/paulmillr/noble-hashes) for SHA3-256 in the browser, IBM Plex Sans and Plex Mono (SIL Open Font License), and the [unslop](https://github.com/heydamir/unslop) design checklist by Damir Sokolovsky (CC BY 4.0).

QoreSeal's README says its construction is pending external review before 1.0. Quorate inherits that limitation.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
