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

Still to do: seal to the on-chain keys, rotate the epoch on a set change, record the acknowledgement transaction, and build the web app.

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
```

The generated accounts are for testnet only. Never send mainnet funds to them.

## Credits

Built on the QoreChain kits, used under Apache-2.0:

- [`@qorechain/sdk`](https://www.npmjs.com/package/@qorechain/sdk) 0.14.0: accounts, hybrid signing, PQC and KEM key registration
- [`@qorechain/qoreseal`](https://github.com/qorechain/qoreseal) 0.1.0: ML-KEM-1024 envelopes and epoch keys

QoreSeal's README says its construction is pending external review before 1.0. Quorate inherits that limitation.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
