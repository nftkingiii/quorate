import { useState } from "react";
import type { Advisory, QuorumData } from "./api";
import { ROLES, blocksToTime, fmt, nameOf, short } from "./api";
import { Chevron, ErrorBox, Lamp, Placeholder, QuorumRing, Simulated, Tag, TxLinks } from "./ui";

export function QuorumView({ q, error, onRetry, goRoster }: { q: QuorumData | null; error: string | null; onRetry: () => void; goRoster: () => void }) {
  return (
    <>
      <header className="pagehead">
        <h1>Who has the fix before the halt height</h1>
        <p>
          Each advisory is sealed to its epoch's validator set. An operator's lamp lights only when it has decrypted the
          advisory and sent a post-quantum signed acknowledgement that matches the anchored ciphertext.
        </p>
      </header>

      <div className="note" style={{ marginBottom: 24 }}>
        <span><strong>Demo set</strong> · The operators are testnet accounts run by this project, not real validators. The real sets are on{" "}
          <button className="linkbtn" onClick={goRoster}>Roster</button></span>
      </div>

      {error && !q && <ErrorBox message={error} onRetry={onRetry} />}
      {!q && !error && <div className="stack"><Placeholder height={264} /><Placeholder height={264} /></div>}

      {q && (
        <div className="stack">
          {q.advisories.length === 0 && <div className="card empty">No advisories are anchored yet</div>}
          {[...q.advisories].reverse().map((a) => <AdvisoryCard key={a.id} a={a} height={q.height} blockSeconds={q.blockSeconds} />)}
        </div>
      )}

      {q && q.rejected.length > 0 && (
        <>
          <h2 className="section-title">Refused records</h2>
          <p className="section-sub">On chain and hybrid-signed, but they do not count. The reason comes from the rules below.</p>
          <div className="card tablewrap">
            <table className="table">
              <thead><tr><th>Operator</th><th>Advisory</th><th>Why it does not count</th><th>Transaction</th></tr></thead>
              <tbody>
                {q.rejected.map((r) => (
                  <tr key={r.tx}>
                    <td>
                      <span className="who">
                        <Lamp state="off" label="Refused" />
                        <span><span className="name">{r.from ? nameOf(r.from) : "Unknown"}</span>{" "}{r.from && ROLES[r.from] && <Simulated />}</span>
                      </span>
                    </td>
                    <td className="mono">{r.advisory ?? "—"}</td>
                    <td>{r.reason[0].toUpperCase() + r.reason.slice(1)}</td>
                    <td><TxLinks hash={r.tx} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h2 className="section-title">How Quorate counts</h2>
      <p className="section-sub">The same rules run in <span className="mono">scripts/quorum.mjs</span>, so anyone can check this page from a fresh clone</p>
      <div className="rules">
        {RULES.map((r, i) => (
          <div className="rule" key={r.t}>
            <div className="rule-n">{String(i + 1).padStart(2, "0")}</div>
            <h3>{r.t}</h3><p>{r.d}</p>
          </div>
        ))}
      </div>
    </>
  );
}

const RULES = [
  { t: "Recipients come from the chain", d: "An epoch lists its members, and every member must have an ML-KEM-1024 key in QoreChain's encryption key registry. The member list is a published file whose SHA3-256 hash the coordinator anchors on chain." },
  { t: "Only the coordinator anchors", d: "Epoch and advisory anchors count only when the coordinator sends them, signed with both secp256k1 and ML-DSA-87. The advisory anchor fixes the ciphertext hash and the target halt height." },
  { t: "An acknowledgement must match", d: "It counts when the sender is a member of the advisory's epoch, names that epoch, carries the anchored ciphertext hash, comes after the anchor and is the operator's first one." },
  { t: "Quorate is more than two thirds", d: "The chain's own consensus threshold: an advisory is quorate when more than two thirds of its epoch's members have acknowledged it." },
];

function AdvisoryCard({ a, height, blockSeconds }: { a: Advisory; height: number; blockSeconds: number | null }) {
  const [open, setOpen] = useState(false);
  const left = a.targetHeight - height;
  const eta = left > 0 ? blocksToTime(left, blockSeconds) : null;
  return (
    <article className="card" aria-labelledby={`adv-${a.id}`}>
      <div className="adv">
        <div className="ring-cell">
          <QuorumRing lit={a.roster.map((m) => !!m.ack)} total={a.members} needed={a.needed} quorate={a.quorate} />
        </div>

        <div>
          <h2 className="adv-id" id={`adv-${a.id}`}>{a.id}</h2>
          <dl className="facts">
            <dt>Epoch</dt><dd>{a.epoch} · {a.members} operators</dd>
            <dt>Quorum</dt><dd>{a.needed} of {a.members}</dd>
            <dt>Halt height</dt><dd><span className="height">{fmt(a.targetHeight)}</span></dd>
          </dl>
          <div className="countdown">
            {left > 0 ? (
              <>
                <div className="countdown-n">{fmt(left)}</div>
                <div className="meta">blocks to the halt height{eta ? ` · ${eta}` : ""}</div>
              </>
            ) : (
              <div className="meta">Halt height passed{a.quorate ? " with a quorum" : " without a quorum"}</div>
            )}
          </div>
        </div>

        <div className="evid">
          <div className="evid-row">
            <span className="meta">Advisory anchor · block {fmt(a.anchorHeight)}</span>
            <TxLinks hash={a.anchor} label="Advisory anchor" />
          </div>
          <div className="evid-row">
            <span className="meta">Ciphertext SHA3-256</span>
            <span className="hash">{short(a.blobHash, 20, 20)}</span>
            <span>
              {a.blobMatches
                ? <Tag tone="ok">Matches the anchor · {fmt(a.blobBytes ?? 0)} bytes</Tag>
                : <Tag tone="bad">{a.blobBytes == null ? "File missing" : "Does not match the anchor"}</Tag>}
            </span>
          </div>
          <div className="evid-row">
            <span className="meta">Operators</span>
            <span className="who" style={{ gap: 8 }}>
              {a.roster.map((m) => <Lamp key={m.address} state={m.ack ? "lit" : "unlit"} label={`${nameOf(m.address)}: ${m.ack ? "ready" : "waiting"}`} />)}
            </span>
          </div>
        </div>
      </div>

      <div className="adv-foot">
        <button className="disclosure" aria-expanded={open} aria-controls={`ops-${a.id}`} onClick={() => setOpen(!open)}>
          <span>{open ? "Hide" : "Show"} the {a.members} operators of epoch {a.epoch}</span><Chevron />
        </button>
        {open && (
          <div className="tablewrap" id={`ops-${a.id}`}>
            <table className="table">
              <thead><tr><th>Operator</th><th>Account</th><th>Acknowledgement</th></tr></thead>
              <tbody>
                {a.roster.map((m) => (
                  <tr key={m.address}>
                    <td>
                      <span className="who">
                        <Lamp state={m.ack ? "lit" : "unlit"} label={m.ack ? "Ready" : "Waiting"} />
                        <span><span className="name">{nameOf(m.address)}</span> {ROLES[m.address] && <Simulated />}</span>
                      </span>
                    </td>
                    <td className="mono faint">{short(m.address, 12, 6)}</td>
                    <td>{m.ack
                      ? <span className="who" style={{ gap: 12 }}><TxLinks hash={m.ack.tx} label="Acknowledgement" /><span className="meta">block {fmt(m.ack.height)}</span></span>
                      : <span className="faint">Waiting</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </article>
  );
}
