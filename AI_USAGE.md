# How AI was used to build Quorate

Quorate was built by one person working with an AI coding agent: Claude Code (Anthropic), running the Claude Opus 5.5 model in the Claude desktop app on Windows. This file describes the workflow, what the AI produced, what the human decided and did, and how the work was checked. It is written from the actual build of 18–19 November 2026, and it says where the AI was wrong.

## The short version

- **The AI wrote almost all of the code and prose** in this repository: the scripts, the read-only server, the web app, the README and this file.
- **The human set every direction and held every gate:** which problem to solve, which angle, which colours, which wallet flow and what level of security. Each push, each wallet action and each faucet claim needed the human's go-ahead.
- **Nothing is claimed without evidence from the chain.** Every result in the README comes from a command that was run and a transaction that was read back, not from the AI's say-so.

## Workflow

The work ran as one long conversation in which the agent could read the web, run commands, edit files and drive a browser pane. Several reusable instructions ("skills") shaped how it worked:

| Skill | What it did here |
|---|---|
| `hackathon` | Read the fest rules, prizes and kits; compared candidate ideas against existing entries; kept a project state file and an evidence log; applied lessons from earlier hackathons (proof first, real chain evidence, no secrets in repos) |
| `frontend-design` | Turned the user's taste rules into a design read before code: one job per screen, explicit demo labelling, one next action at a time |
| [unslop](https://github.com/heydamir/unslop) (Damir Sokolovsky, CC BY 4.0) | A checklist the user asked the agent to apply. The agent audited the first interface against it, wrote a five-line direction, and redid spacing, colour, type and states |

### The loop

1. **Read primary sources first.** The agent read the fest rules and prize pages, the QoreChain version history (v3.2.3 to v3.2.8), and the published kit packages themselves (`@qorechain/sdk`, `@qorechain/qoreseal`, `@qorechain/qorex-types`, `@qorechain/qorex-wallet-mock`). It also queried the live testnet and mainnet, which is how it found that none of the 12 bonded validators had an encryption key registered.
2. **Propose, then wait for a human decision** on anything that changes direction or touches a wallet.
3. **Build the smallest proof first:** an offline sealing proof (9/9), then keys on chain, then the full advisory scenario, then the app.
4. **Verify independently.** The test suite (`npm test`, 36 tests) and the production build run on a separate Linux VM, not the laptop the code was written on. Each on-chain step is checked with a separate read (transaction code, `PQCHybridSignature` extension, `pqc_hybrid_verify` event, byte-for-byte key read-back). The quorum is recomputed by `scripts/quorum.mjs` from public data alone, including from a fresh clone.
5. **Record evidence** (transaction hashes and heights) in the README as it happens.

## What the human did

- **Chose the problem.** The AI first proposed an encrypted teleradiology app, partly because of the builder's background in radiography. The human pushed back: build on what the organisers care about. That redirect produced the core idea: embargoed security patches for QoreChain's own validator set, timed to its coordinated-halt upgrades.
- **Made the design calls.** The human rejected the AI's default warm-cream and serif look ("get creative with the colors"), asked for the unslop pass, and picked the "Night shift" palette from three directions the AI drafted.
- **Chose the wallet architecture.** The human asked which option was less work, better engineered and more secure, then chose to have the operator's wallet join the set while the coordinator stays scripted. This kept the server read-only.
- **Asked for the security fix** after GitHub raised Dependabot alerts on development tooling.
- **Did the things only a person can do:** registered for the fest, claimed test tokens from the faucet (sign-in required), created the fest project page, and approved every push to GitHub.

## What the AI generated

| Area | Files |
|---|---|
| Protocol and shared rules | `lib/protocol.mjs` (memo formats, hashing, chain reads), `lib/quorum-core.mjs` (who counts and why), `lib/bech32.mjs` |
| Chain scripts | `scripts/keygen.mjs`, `onchain-setup.mjs`, `advisory-flow.mjs`, `coordinator.mjs`, `quorum.mjs`, `proof-offline.mjs`, `check-draft-interop.mjs` |
| Read-only server | `server/index.mjs` (GET only, allow-listed files, TTL cache, no keys) |
| Web app | `web/src/*`: the Quorum, Advisory, Operator and Roster tabs, QoreX wallet calls, sealing-key backup (PBKDF2-SHA-256 600,000 rounds, then AES-256-GCM), styles |
| Writing | `README.md`, this file, the commit messages, and the text for the fest project form |
| On-chain activity | 31 testnet transactions, all code 0, counted from the chain on 19 November 2026: 28 signed by the project's scripts and 3 by the test wallet through the QoreX wallet mock |

The agent did not write any QoreChain cryptography. Encryption, epoch keys and hybrid signing all come from the official kits; Quorate decides who receives what and what counts.

## Where the AI was wrong, and how it was caught

These are kept here on purpose. They are the reason every claim is checked.

| Mistake | How it was caught | Fix |
|---|---|---|
| Assumed 5-second blocks for the "time to halt height" estimate. Testnet runs at about 1.4 s | The agent compared heights over ten hours against wall-clock time | The server now measures block time over the last 1,000 blocks |
| Git would have converted line endings in `advisories/*.json` on Windows checkouts, breaking their on-chain hashes | Git's own warning during a commit | `.gitattributes` marks `advisories/` as binary; stored bytes were checked against the anchored hashes |
| The Operator tab stopped looking for QoreX after 6 seconds | The wallet-mock test injected it later and the page missed it | It keeps looking, and there is a "Check again" button |
| A failed chain read made the page think no encryption key was registered, and offered to register a new one. Doing so would have locked the operator out of advisories sealed to the old key | Seen during the end-to-end test on a flaky connection | A failed read is now an error the page retries; the server no longer caches failures |
| The production server answered a folder path such as `/assets/` with a 502 that included an internal error message | A smoke test of the built app on the test VM | Folders and unknown paths now get the app shell, errors carry no internal detail, and a test covers it |
| The agent's own dev-server setup (Vite 5) served the test keys in `.keys/` to anyone who asked for the right URL | Dependabot alerts, then the agent confirmed it by status code and size, without printing the keys | Vite 6.4.4 with strict file rules; rechecked afterwards that key paths return 403 |

## Safety rules the agent followed

- **No secrets in the repository or the conversation.** Keys live in `.keys/`, which git ignores, and every commit was scanned before pushing. The agent never asked for, or printed, a private key or recovery phrase.
- **No action on someone's behalf without a yes.** Pushes, wallet use and anything sent to an outside service waited for the human. The agent did not swap tokens or handle real funds; everything ran on testnet with valueless tokens.
- **Honest labels.** The four operator accounts the project runs are marked "simulated" everywhere. The wallet test used the official QoreX mock and is labelled "QoreX mock (test wallet)"; the README says plainly that a real QoreX wallet has not been tried yet. All advisories are marked `simulated: true` and describe no real vulnerability.

## What remains human work

Judgement about whether QoreChain's validators would use this, conversations with operators, and the demo video's narration are the human's. The AI can draft, but it cannot validate demand.
