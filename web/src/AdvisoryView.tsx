import { useMemo, useState } from "react";
import { sealBatch, sealEpochKey } from "@qorechain/qoreseal";
import { sha3_256 } from "@noble/hashes/sha3.js";
import type { CurrentEpoch, QuorumData } from "./api";
import { fmt, short, useResource } from "./api";
import { ErrorBox, Lamp, Placeholder, Simulated, TxLinks } from "./ui";

const EPOCH_PURPOSE = "epoch-key:quorate-advisories";
const ADVISORY_CONTEXT = "quorate:advisories";
const ID_PATTERN = /^[A-Za-z0-9-]{1,32}$/;
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const b64 = (b: Uint8Array) => btoa(Array.from(b, (x) => String.fromCharCode(x)).join(""));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

type Sealed = {
  epoch: number; id: string; manifest: Uint8Array; blob: Uint8Array;
  envHash: string; blobHash: string; epochMemo: string; advMemo: string; recipients: number;
};

export function AdvisoryView({ q }: { q: QuorumData | null }) {
  const ep = useResource<CurrentEpoch>("/api/epoch/current");
  return (
    <>
      <header className="pagehead">
        <h1>Seal an advisory to the set</h1>
        <p>
          Advisories are encrypted in this browser to each member's ML-KEM-1024 key as published on chain. Only ciphertext and
          its hash ever leave the page.
        </p>
      </header>
      <div className="grid2">
        <section className="card" aria-labelledby="anchored">
          <div className="card-pad" style={{ paddingBottom: 12 }}>
            <h2 id="anchored" style={{ margin: 0, font: "500 18px/28px var(--sans)" }}>Anchored advisories</h2>
            <p className="muted" style={{ margin: "4px 0 0" }}>Ciphertext anyone can download; only the epoch's members can open it</p>
          </div>
          {!q && <div style={{ padding: 24 }}><Placeholder height={120} /></div>}
          {q && q.advisories.length === 0 && <div className="empty">Nothing anchored yet</div>}
          {q && [...q.advisories].reverse().map((a) => (
            <div className="list-item" key={a.id}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
                <span style={{ font: "500 16px/24px var(--sans)" }}>{a.id}</span>
                <span className="who" style={{ gap: 6 }}>{a.roster.map((m) => <Lamp key={m.address} state={m.ack ? "lit" : "unlit"} label={m.ack ? "Ready" : "Waiting"} />)}<span className="meta" style={{ marginLeft: 4 }}>{a.quorate ? "Quorate" : `${a.ready} of ${a.members}`}</span></span>
              </div>
              <div className="mono faint" style={{ fontSize: 12 }}>epoch {a.epoch} · {fmt(a.blobBytes ?? 0)} bytes · sha3 {short(a.blobHash, 8, 6)}</div>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
                <TxLinks hash={a.anchor} label="Anchor" />
                <a className="txlinks" href={`/advisories/${a.id}.blob`} download>Download ciphertext</a>
              </div>
            </div>
          ))}
        </section>

        <section className="card card-pad" aria-labelledby="draft">
          <h2 id="draft" style={{ margin: 0, font: "500 18px/28px var(--sans)" }}>Draft a new advisory</h2>
          {ep.error && !ep.data && <div style={{ marginTop: 16 }}><ErrorBox message={ep.error} onRetry={ep.reload} /></div>}
          {!ep.data && !ep.error && <div style={{ marginTop: 16 }}><Placeholder height={300} /></div>}
          {ep.data && q && <Composer epoch={ep.data} q={q} />}
        </section>
      </div>
    </>
  );
}

function Composer({ epoch, q }: { epoch: CurrentEpoch; q: QuorumData }) {
  const nextEpoch = (epoch.epoch ?? 0) + 1;
  const taken = useMemo(() => new Set(q.advisories.map((a) => a.id)), [q]);
  const nextId = `QSA-${String(q.advisories.length + 1).padStart(3, "0")}`;
  const [id, setId] = useState(nextId);
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [patchVersion, setPatchVersion] = useState("");
  const [patchSha, setPatchSha] = useState("");
  const [target, setTarget] = useState(String(q.height + 20000));
  const [sealed, setSealed] = useState<Sealed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const usable = epoch.members.filter((m) => m.mlkemPublicKey);
  const problems = [
    !ID_PATTERN.test(id) && "The ID can use letters, digits and dashes, up to 32 characters.",
    taken.has(id) && `${id} is already anchored.`,
    !title.trim() && "Add a title.",
    !(Number(target) > q.height) && `The target height must be above the current height, ${fmt(q.height)}.`,
    patchSha && !/^[0-9a-f]{64}$/i.test(patchSha) && "The patch hash must be 64 hex characters (SHA-256).",
    usable.length === 0 && "No member has an encryption key on chain.",
  ].filter(Boolean) as string[];

  function seal() {
    setBusy(true);
    setError(null);
    try {
      const key = crypto.getRandomValues(new Uint8Array(32));
      const epochKey = { epoch: BigInt(nextEpoch), key };
      const envelope = sealEpochKey({
        chainId: epoch.chainId, purpose: EPOCH_PURPOSE, epochKey, mode: "mlkem",
        recipients: usable.map((m) => ({ mlkemPublicKey: fromB64(m.mlkemPublicKey!) })),
      });
      const members = usable.map((m) => m.address);
      const manifest = new TextEncoder().encode(JSON.stringify({ protocol: "quorate/1", chainId: epoch.chainId, epoch: nextEpoch, members, envelope: b64(envelope) }, null, 2) + "\n");
      const body = { id, title: title.trim(), details: details.trim(), patch: patchVersion ? { version: patchVersion, sha256: patchSha.toLowerCase() } : null, upgradeHeight: Number(target) };
      const batch = sealBatch({ epochKey, context: ADVISORY_CONTEXT, batchIndex: Number(id.match(/\d+$/)?.[0] ?? 0), data: new TextEncoder().encode(JSON.stringify(body)) });
      key.fill(0); // the draft epoch key is not kept
      const envHash = hex(sha3_256(manifest));
      const blobHash = hex(sha3_256(batch.blob));
      setSealed({
        epoch: nextEpoch, id, manifest, blob: batch.blob, envHash, blobHash, recipients: members.length,
        epochMemo: `quorate/1 epoch ${nextEpoch} members ${members.length} env ${envHash}`,
        advMemo: `quorate/1 adv ${id} epoch ${nextEpoch} height ${Number(target)} blob ${blobHash}`,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const download = (name: string, bytes: Uint8Array, type: string) => {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div style={{ display: "grid", gap: 20, marginTop: 16 }}>
      <ol className="steps" aria-label="Progress">
        <li className="done"><span className="mark">✓</span><span>Recipients read from the chain: epoch {epoch.epoch}, {usable.length} members with an ML-KEM-1024 key</span></li>
        <li className={sealed ? "done" : "current"}><span className="mark">{sealed ? "✓" : "02"}</span><span>Write and seal in this browser</span></li>
        <li className={sealed ? "current" : ""}><span className="mark">03</span><span>Anchor on chain with the coordinator's QoreX signature <span className="faint">· not wired yet</span></span></li>
      </ol>

      <div className="recips" aria-label="Recipients">
        {usable.map((m) => (
          <span className="recip" key={m.address}>
            <span className="name">{m.name ?? "Operator"}</span>{m.simulated && <Simulated />}
          </span>
        ))}
      </div>

      {!sealed && (
        <form style={{ display: "grid", gap: 16 }} onSubmit={(e) => { e.preventDefault(); if (!problems.length) seal(); }}>
          <div className="row2">
            <div className="field"><label htmlFor="f-id">Advisory ID</label><input id="f-id" className="input mono" value={id} onChange={(e) => setId(e.target.value)} /></div>
            <div className="field"><label htmlFor="f-h">Target upgrade height</label><input id="f-h" className="input mono" inputMode="numeric" value={target} onChange={(e) => setTarget(e.target.value.replace(/\D/g, ""))} /></div>
          </div>
          <div className="field"><label htmlFor="f-t">Title</label><input id="f-t" className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What is affected" /></div>
          <div className="field"><label htmlFor="f-d">Details for operators</label><textarea id="f-d" className="textarea" value={details} onChange={(e) => setDetails(e.target.value)} placeholder="Impact, who must act and how to verify the fix" /></div>
          <div className="row2">
            <div className="field"><label htmlFor="f-pv">Patch version</label><input id="f-pv" className="input mono" value={patchVersion} onChange={(e) => setPatchVersion(e.target.value)} placeholder="v3.2.8-hotfix1" /></div>
            <div className="field"><label htmlFor="f-ps">Binary SHA-256</label><input id="f-ps" className="input mono" value={patchSha} onChange={(e) => setPatchSha(e.target.value.trim())} placeholder="64 hex characters" /></div>
          </div>
          {problems.length > 0 && (title || id !== nextId) && <p className="faint" style={{ margin: 0 }}>{problems[0]}</p>}
          {error && <ErrorBox message={error} />}
          <div><button className="btn primary" type="submit" disabled={problems.length > 0 || busy}>{busy ? "Sealing…" : `Seal to ${usable.length} members`}</button></div>
          <p className="meta" style={{ margin: 0 }}>
            A draft starts epoch {nextEpoch} with a fresh key, because the current epoch key stays with the coordinator. Nothing is sent anywhere
          </p>
        </form>
      )}

      {sealed && (
        <div style={{ display: "grid", gap: 16 }}>
          <div className="note"><span><strong>Sealed in this browser</strong> · {sealed.id} is encrypted under a new epoch {sealed.epoch} key, and that key is sealed to {sealed.recipients} ML-KEM-1024 keys from the chain. The key was wiped after sealing</span></div>
          <dl className="facts">
            <dt>Ciphertext</dt><dd className="mono">{fmt(sealed.blob.length)} bytes · sha3 {short(sealed.blobHash, 10, 8)}</dd>
            <dt>Epoch file</dt><dd className="mono">{fmt(sealed.manifest.length)} bytes · sha3 {short(sealed.envHash, 10, 8)}</dd>
          </dl>
          <div className="field"><span className="meta-label">Anchor memos the coordinator would sign</span>
            <pre className="code">{sealed.epochMemo}{"\n"}{sealed.advMemo}</pre>
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button className="btn" onClick={() => download(`${sealed.id}.blob`, sealed.blob, "application/octet-stream")}>Download ciphertext</button>
            <button className="btn" onClick={() => download(`epoch-${sealed.epoch}.json`, sealed.manifest, "application/json")}>Download epoch file</button>
            <button className="btn primary" disabled title="Needs the coordinator's QoreX wallet; coming next">Anchor with QoreX</button>
          </div>
          <div><button className="linkbtn" onClick={() => setSealed(null)}>Start another draft</button></div>
        </div>
      )}
    </div>
  );
}
