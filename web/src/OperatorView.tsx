import { useCallback, useEffect, useMemo, useState } from "react";
import { openBatch, openEpochKey } from "@qorechain/qoreseal";
import { sha3_256 } from "@noble/hashes/sha3.js";
import type { AccountData, Advisory, QuorumData } from "./api";
import { fmt, getJson, short } from "./api";
import { CHAIN_ID, acknowledge, bindSealer, connect, explain, fundSealer, isMock, qorex } from "./wallet";
import { MIN_PASSPHRASE, createSecret, downloadJson, exportBackup, fromBase64, importBackup, keyFingerprint, toHex } from "./sealkey";
import type { Sealer } from "./sealer";
import { SEALER_FEES_UQOR, SEALER_FUNDING_UQOR, buildKeyAndBinding, buildKeyRegistration, deriveSealer, relay } from "./sealer";
import { ErrorBox, Lamp, Tag, TxLinks } from "./ui";

const EPOCH_PURPOSE = "epoch-key:quorate-advisories";
type Opened = { title?: string; details?: string; patch?: { version: string; sha256: string } | null };
type Done = { what: string; txHash: string; height?: number; shield?: string };

/**
 * One valid next action at a time. Real QoreX will not let a website register
 * an encryption key, so the operator's key lives on a small sealing account
 * the page runs, bound both ways to the operator's QoreX account:
 *   connect → sealing key (create or load) → fund it from QoreX → it registers
 *   its signing key → it publishes its encryption key and its half of the bind
 *   → QoreX sends the operator's half → coordinator adds you → open + acknowledge.
 */
export function OperatorView({ q, reloadQuorum }: { q: QuorumData | null; reloadQuorum: () => void }) {
  const [address, setAddress] = useState<string | null>(null);
  const [sealer, setSealer] = useState<Sealer | null>(null);
  const [sealerAcct, setSealerAcct] = useState<AccountData | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [replacing, setReplacing] = useState(false); // the operator lost the bound key's backup and makes a new one
  const [connectedAt, setConnectedAt] = useState<number>(0); // choose "create" or "load" only from a chain read made after connecting
  const [bindSentFor, setBindSentFor] = useState<string | null>(null); // the chain view is cached for 15 s; do not offer the bind twice
  const [hasWallet, setHasWallet] = useState(() => !!qorex());

  // QoreX can inject itself after the page loads; keep looking until it does.
  useEffect(() => {
    if (hasWallet) return;
    const t = setInterval(() => { if (qorex()) setHasWallet(true); }, 1000);
    return () => clearInterval(t);
  }, [hasWallet]);

  // Keeps the last good reading when the chain cannot be read; retries a few times.
  const readAccount = useCallback(async (a: string) => {
    let last: unknown;
    for (let i = 0; i < 3; i++) {
      try { return await getJson<AccountData>(`/api/account?address=${a}`); }
      catch (e) { last = e; await new Promise((r) => setTimeout(r, 1500 * (i + 1))); }
    }
    throw new Error(`Could not read ${short(a, 10, 6)} from the chain (${(last as Error)?.message}). Try again shortly.`);
  }, []);
  const refreshSealer = useCallback(async (s: Sealer) => setSealerAcct(await readAccount(s.address)), [readAccount]);

  useEffect(() => {
    if (!sealer || sealerAcct) return;
    refreshSealer(sealer).catch((e) => setError((e as Error).message));
  }, [sealer, sealerAcct, refreshSealer]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setError(null);
    try { await fn(); } catch (e) { setError(explain(e)); } finally { setBusy(null); }
  };

  const myBinding = useMemo(() => (q && address ? [...q.bindings].reverse().find((b) => b.operator === address) ?? null : null), [q, address]);
  const myEpochs = useMemo(() => (q && address ? q.epochs.filter((e) => e.members.includes(address)).map((e) => e.epoch) : []), [q, address]);
  // Which epochs were sealed to the key this page holds: the member's sealer in that epoch's file, else its own account.
  const sealedToMe = useCallback((epochNo: number) => {
    const e = q?.epochs.find((x) => x.epoch === epochNo);
    return !!(e && address && sealer && (e.sealers?.[address] ?? address) === sealer.address);
  }, [q, address, sealer]);
  const openableEpochs = useMemo(() => myEpochs.filter(sealedToMe), [myEpochs, sealedToMe]);
  const myAdvisories = useMemo(() => (q && address ? q.advisories.filter((a) => a.roster.some((m) => m.address === address)).reverse() : []), [q, address]);

  const sealerKem = sealerAcct && sealerAcct.encryptionKey !== "unknown" ? sealerAcct.encryptionKey : null;
  const sealerHasSigningKey = !!(sealerAcct && sealerAcct.signingKey && sealerAcct.signingKey !== "unknown");
  const kemPublished = !!(sealer && sealerKem?.found && sealerKem.publicKeySha3 === keyFingerprint(sealer.sealKeys));
  const balance = Number(sealerAcct?.balanceUqor ?? 0);
  const boundHere = !!(sealer && myBinding?.sealer === sealer.address);

  const freshView = !!q && Date.parse(q.readAt) >= connectedAt;
  const step = !hasWallet ? "install" : !address ? "connect" : !q || (!sealer && !freshView) ? "loading"
    : !sealer ? (myBinding && !replacing ? "import" : "create")
    : myBinding && !boundHere && kemPublished && !replacing ? "mismatch"
    : !sealerAcct ? "loading"
    : !sealerHasSigningKey && balance < SEALER_FEES_UQOR ? "fund"
    : !sealerHasSigningKey ? "register"
    : !kemPublished ? "publish"
    : !boundHere ? (bindSentFor === sealer.address ? "confirming" : "bind")
    : !myBinding?.mutual ? "confirming"
    : myEpochs.length === 0 ? "waiting"
    : openableEpochs.length === 0 ? "rekeyed" : "member";

  const after = async (what: string, r: { txHash: string; height?: number; shield?: string }) => {
    setDone({ ...r, what });
    if (sealer) await refreshSealer(sealer);
    reloadQuorum();
  };

  return (
    <>
      <header className="pagehead">
        <h1>Operate as a validator</h1>
        <p>
          Connect QoreX to receive sealed advisories. Your ML-KEM-1024 key lives on a sealing account this page runs for you,
          bound to your QoreX account on chain; acknowledgements come from QoreX, signed with secp256k1 and ML-DSA-87 together.
        </p>
      </header>

      {isMock() && (
        <div className="note" style={{ marginBottom: 16 }}><span><strong>Test wallet</strong> · This page is driven by the official QoreX wallet mock, a test double that signs for real on testnet</span></div>
      )}

      <div className="grid2">
        <section className="card card-pad" aria-labelledby="op-steps">
          <h2 id="op-steps" style={{ margin: "0 0 12px", font: "500 18px/28px var(--sans)" }}>Your setup</h2>
          <ol className="steps">
            <Step n="01" done={!!address} current={step === "install" || step === "connect"}>Connect QoreX on Testnet{address && <span className="mono faint"> · {short(address, 10, 6)}</span>}</Step>
            <Step n="02" done={!!sealer} current={step === "create" || step === "import" || step === "mismatch"}>Sealing key in this browser{sealer && <span className="mono faint"> · account {short(sealer.address, 8, 4)}</span>}</Step>
            <Step n="03" done={sealerHasSigningKey} current={step === "fund" || step === "register"}>Sealing account funded and its signing key registered</Step>
            <Step n="04" done={kemPublished} current={step === "publish"}>Encryption key published on chain</Step>
            <Step n="05" done={!!myBinding?.mutual && boundHere} current={step === "bind" || step === "confirming"}>Bound to your QoreX account, both ways</Step>
            <Step n="06" done={myEpochs.length > 0} current={step === "waiting"}>Added to the set by the coordinator{myEpochs.length > 0 && <span className="faint"> · epoch {myEpochs.join(", ")}</span>}</Step>
            <Step n="07" done={false} current={step === "member"}>Open advisories and acknowledge</Step>
          </ol>
          {sealerAcct && (
            <dl className="facts" style={{ marginTop: 16 }}>
              <dt>Sealing account</dt><dd className="mono">{short(sealerAcct.address, 10, 6)}</dd>
              <dt>Its balance</dt><dd className="mono">{(balance / 1e6).toFixed(3)} QOR</dd>
            </dl>
          )}
        </section>

        <section className="card card-pad" aria-live="polite">
          {error && <div style={{ marginBottom: 16 }}><ErrorBox message={error} /></div>}

          {step === "install" && (
            <Panel title="QoreX was not found">
              <p className="muted">Install the QoreX browser extension and switch it to Testnet. On a phone, open this page in the QoreX app's browser. This page notices QoreX as soon as it appears.</p>
              <button className="btn" onClick={() => setHasWallet(!!qorex())}>Check again</button>
            </Panel>
          )}

          {step === "connect" && (
            <Panel title="Connect your QoreX account">
              <p className="muted">QoreX asks you to connect this site. The page learns your qor1 address and nothing else. If QoreX is locked, unlock it from your browser's toolbar first.</p>
              <button className="btn primary" disabled={!!busy} onClick={() => run("connect", async () => { const a = await connect(); setConnectedAt(Date.now() - 1000); setAddress(a.address); reloadQuorum(); })}>
                {busy ? "Waiting for QoreX…" : "Connect QoreX"}
              </button>
            </Panel>
          )}

          {step === "loading" && (
            <Panel title="Reading the chain">
              <p className="muted">Checking whether this account already has a sealing key bound to it.</p>
              <AutoRefresh every={5000} onTick={reloadQuorum} />
            </Panel>
          )}

          {step === "create" && address && <CreateKey operator={address} onReady={(s) => { setSealer(s); setSealerAcct(null); setError(null); }} onError={setError} />}

          {step === "import" && address && myBinding && (
            <>
              <ImportKey operator={address} expectSealer={myBinding.sealer} onReady={(s) => { setSealer(s); setSealerAcct(null); setError(null); }} onError={setError} />
              <div style={{ marginTop: 24, paddingTop: 16, borderTop: "1px solid var(--line)" }}>
                <p className="meta" style={{ margin: "0 0 8px" }}>Lost the backup or the passphrase? Advisories already sealed to the old key cannot be recovered, but you can make a new key and bind it instead; the coordinator then adds it in its next epoch.</p>
                <button className="btn" onClick={() => { setReplacing(true); setError(null); }}>I lost it: create a new key</button>
              </div>
            </>
          )}

          {step === "mismatch" && myBinding && sealer && (
            <Panel title="This is not your bound sealing key">
              <p className="muted">Your QoreX account is bound to the sealing account {short(myBinding.sealer, 10, 6)}, but this key belongs to {short(sealer.address, 10, 6)}. Load the backup of the bound key. Binding a new one would stop advisories sealed to the old key from opening here.</p>
              <button className="btn" onClick={() => { setSealer(null); setSealerAcct(null); }}>Load a different backup</button>
            </Panel>
          )}

          {step === "fund" && address && sealer && (
            <Panel title="Fund your sealing account">
              <p className="muted">It pays for its own two transactions. QoreX sends it {(SEALER_FUNDING_UQOR / 1e6).toFixed(1)} test QOR from your account; you approve it in QoreX.</p>
              <button className="btn primary" disabled={!!busy} onClick={() => run("fund", async () => {
                const r = await fundSealer(address, sealer.address, SEALER_FUNDING_UQOR);
                await after("Sealing account funded", r);
              })}>{busy ? "Waiting for QoreX…" : `Send ${(SEALER_FUNDING_UQOR / 1e6).toFixed(1)} QOR with QoreX`}</button>
            </Panel>
          )}

          {step === "register" && sealer && sealerAcct && (
            <Panel title="Register the sealing account's signing key">
              <p className="muted">Its ML-DSA-87 key, with a proof of possession. Signed in this browser and sent through Quorate's relay, which forwards only sealing-account transactions. No QoreX prompt.</p>
              <button className="btn primary" disabled={!!busy || sealerAcct.accountNumber == null} onClick={() => run("register", async () => {
                const tx = await buildKeyRegistration(sealer, sealerAcct.accountNumber!, sealerAcct.sequence ?? 0);
                await after("Signing key registered", await relay(tx));
              })}>{busy ? "Sending…" : sealerAcct.accountNumber == null ? "Waiting for the funding to land…" : "Register signing key"}</button>
              {sealerAcct.accountNumber == null && <button className="btn" onClick={() => refreshSealer(sealer).catch((e) => setError(e.message))}>Check again</button>}
            </Panel>
          )}

          {step === "publish" && address && sealer && sealerAcct && q && (
            <Panel title="Publish your encryption key">
              <p className="muted">One hybrid-signed transaction from the sealing account: its ML-KEM-1024 key, and its half of the binding ("I hold the key for {short(address, 10, 6)}"). Sent through the relay.</p>
              <button className="btn primary" disabled={!!busy} onClick={() => run("publish", async () => {
                const tx = await buildKeyAndBinding(sealer, sealerAcct.accountNumber!, sealerAcct.sequence ?? 0, address, q.coordinator);
                await after("Encryption key published", await relay(tx));
              })}>{busy ? "Sending…" : "Publish encryption key"}</button>
            </Panel>
          )}

          {step === "bind" && address && sealer && q && (
            <Panel title="Bind it to your QoreX account">
              <p className="muted">Your half of the binding: QoreX sends 1 uqor to the coordinator with the record "bind {short(sealer.address, 10, 6)}". You approve it in QoreX.</p>
              <button className="btn primary" disabled={!!busy} onClick={() => run("bind", async () => {
                const r = await bindSealer(address, q.coordinator, sealer.address);
                setBindSentFor(sealer.address);
                await after("Binding sent", r);
              })}>{busy ? "Waiting for QoreX…" : "Bind with QoreX"}</button>
            </Panel>
          )}

          {step === "confirming" && (
            <Panel title="Confirming the binding">
              <p className="muted">Both halves are sent. The page reads the chain again every 15 seconds until it sees them.</p>
              <AutoRefresh every={15000} onTick={reloadQuorum} />
              <button className="btn" onClick={reloadQuorum}>Check now</button>
            </Panel>
          )}

          {step === "waiting" && address && (
            <Panel title="Waiting for the coordinator">
              <p className="muted">Your key is on chain and bound. The coordinator adds you when it starts the next epoch; advisories sealed from then on open here. Send the coordinator this address:</p>
              <pre className="code">{address}</pre>
              <AutoRefresh every={20000} onTick={reloadQuorum} />
              <button className="btn" onClick={reloadQuorum}>Check now</button>
            </Panel>
          )}

          {step === "rekeyed" && address && (
            <Panel title="Waiting for the coordinator to use your new key">
              <p className="muted">You are in epoch {myEpochs.join(", ")}, but it was sealed to your previous sealing key. Advisories sealed from the coordinator's next epoch will open with this one. Tell the coordinator you rebound:</p>
              <pre className="code">{address}</pre>
              <AutoRefresh every={20000} onTick={reloadQuorum} />
              <button className="btn" onClick={reloadQuorum}>Check now</button>
            </Panel>
          )}

          {step === "member" && address && sealer && q && (
            <div className="stack">
              <h2 style={{ margin: 0, font: "500 18px/28px var(--sans)" }}>Advisories for you</h2>
              {myAdvisories.length === 0 && <p className="muted" style={{ margin: 0 }}>You are in epoch {myEpochs.join(", ")}. No advisory has been sealed to it yet.</p>}
              {myAdvisories.map((a) => (
                <AdvisoryForMe key={a.id} a={a} q={q} address={address} sealer={sealer} busy={busy} run={run} sealedToThisKey={sealedToMe(a.epoch)}
                  onAck={(r) => { setDone({ ...r, what: `${a.id} acknowledged` }); reloadQuorum(); }} />
              ))}
            </div>
          )}

          {done && (
            <div className="note" style={{ marginTop: 16 }}>
              <span><strong>{done.what}</strong> · <TxLinks hash={done.txHash} /> {done.height ? <span className="meta">block {fmt(done.height)}</span> : null}{" "}
                {done.shield ? (done.shield === "shielded" ? <Tag tone="ok">ML-DSA-87 layer on chain</Tag> : <Tag tone="neutral">Shield: {done.shield}</Tag>) : null}</span>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

function AutoRefresh({ every, onTick }: { every: number; onTick: () => void }) {
  useEffect(() => { const t = setInterval(onTick, every); return () => clearInterval(t); }, [every, onTick]);
  return null;
}

function Step({ n, done, current, children }: { n: string; done: boolean; current: boolean; children: React.ReactNode }) {
  return <li className={done ? "done" : current ? "current" : ""}><span className="mark">{done ? "✓" : n}</span><span>{children}</span></li>;
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return <div style={{ display: "grid", gap: 16, justifyItems: "start" }}><h2 style={{ margin: 0, font: "500 18px/28px var(--sans)" }}>{title}</h2>{children}</div>;
}

function CreateKey({ operator, onReady, onError }: { operator: string; onReady: (s: Sealer) => void; onError: (m: string) => void }) {
  const [p1, setP1] = useState("");
  const [p2, setP2] = useState("");
  const [working, setWorking] = useState(false);
  const problem = p1.length < MIN_PASSPHRASE ? `At least ${MIN_PASSPHRASE} characters` : p1 !== p2 ? "The passphrases do not match" : null;
  return (
    <Panel title="Create your sealing key">
      <p className="muted" style={{ margin: 0 }}>The page makes one secret in this browser and keeps it in memory. From it come your sealing account and its ML-KEM-1024 key. You get a backup encrypted with your passphrase; you need it to open advisories after you close this tab. Without the file and the passphrase, nobody can recover the key.</p>
      <form style={{ display: "grid", gap: 16, width: "100%" }} onSubmit={async (e) => {
        e.preventDefault();
        if (problem) return;
        setWorking(true);
        try {
          const secret = createSecret();
          const s = await deriveSealer(secret);
          const backup = await exportBackup(secret, { operator, chainId: CHAIN_ID, keyId: `${s.address}:${keyFingerprint(s.sealKeys)}` }, p1);
          secret.fill(0);
          downloadJson(`quorate-sealing-key-${operator.slice(-6)}.json`, backup);
          onReady(s);
        } catch (err) { onError((err as Error).message); } finally { setWorking(false); }
      }}>
        <div className="row2">
          <div className="field"><label htmlFor="pp1">Backup passphrase</label><input id="pp1" className="input" type="password" autoComplete="new-password" value={p1} onChange={(e) => setP1(e.target.value)} /></div>
          <div className="field"><label htmlFor="pp2">Repeat it</label><input id="pp2" className="input" type="password" autoComplete="new-password" value={p2} onChange={(e) => setP2(e.target.value)} /></div>
        </div>
        {p1 && problem && <p className="meta" style={{ margin: 0 }}>{problem}</p>}
        <div><button className="btn primary" type="submit" disabled={!!problem || working}>{working ? "Encrypting the backup…" : "Create key and download backup"}</button></div>
      </form>
    </Panel>
  );
}

function ImportKey({ operator, expectSealer, onReady, onError }: { operator: string; expectSealer: string; onReady: (s: Sealer) => void; onError: (m: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [pass, setPass] = useState("");
  const [working, setWorking] = useState(false);
  return (
    <Panel title="Load your sealing key">
      <p className="muted" style={{ margin: 0 }}>Your QoreX account is already bound to the sealing account {short(expectSealer, 10, 6)}. Load the backup file you saved when you created it.</p>
      <form style={{ display: "grid", gap: 16, width: "100%" }} onSubmit={async (e) => {
        e.preventDefault();
        if (!file) return;
        setWorking(true);
        try {
          const { secret, keyId } = await importBackup(await file.text(), pass, { operator, chainId: CHAIN_ID });
          const s = await deriveSealer(secret);
          secret.fill(0);
          if (keyId !== `${s.address}:${keyFingerprint(s.sealKeys)}`) throw new Error("The backup does not match its own key");
          if (s.address !== expectSealer) throw new Error(`This backup is for the sealing account ${short(s.address, 10, 6)}, not the one bound on chain`);
          onReady(s);
        } catch (err) { onError((err as Error).message); } finally { setWorking(false); }
      }}>
        <div className="field"><label htmlFor="bk">Backup file</label><input id="bk" className="input" type="file" accept="application/json,.json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></div>
        <div className="field"><label htmlFor="bkp">Passphrase</label><input id="bkp" className="input" type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} /></div>
        <div><button className="btn primary" type="submit" disabled={!file || !pass || working}>{working ? "Decrypting…" : "Load key"}</button></div>
      </form>
    </Panel>
  );
}

function AdvisoryForMe({ a, q, address, sealer, busy, run, onAck, sealedToThisKey }: {
  a: Advisory; q: QuorumData; address: string; sealer: Sealer; busy: string | null; sealedToThisKey: boolean;
  run: (label: string, fn: () => Promise<void>) => Promise<void>; onAck: (r: Omit<Done, "what">) => void;
}) {
  const [opened, setOpened] = useState<Opened | null>(null);
  const [sentTx, setSentTx] = useState<string | null>(null); // hides the button the moment the ack confirms, before the quorum cache refreshes
  const mine = a.roster.find((m) => m.address === address);
  const epoch = q.epochs.find((e) => e.epoch === a.epoch);
  const label = `ack:${a.id}`;

  const open = () => run(`open:${a.id}`, async () => {
    const [mBytes, blob] = await Promise.all([fetchBytes(`/advisories/epoch-${a.epoch}.json`), fetchBytes(`/advisories/${a.id}.blob`)]);
    // Check both files against the hashes the coordinator anchored on chain before trusting them.
    if (!epoch || toHex(sha3_256(mBytes)) !== epoch.envHash) throw new Error(`epoch-${a.epoch}.json does not match its anchor; not opening it`);
    if (toHex(sha3_256(blob)) !== a.blobHash) throw new Error(`${a.id}.blob does not match its anchor; not opening it`);
    const manifest = JSON.parse(new TextDecoder().decode(mBytes));
    const ek = openEpochKey({ chainId: CHAIN_ID, purpose: EPOCH_PURPOSE, envelope: fromBase64(manifest.envelope), keys: sealer.sealKeys });
    setOpened(JSON.parse(new TextDecoder().decode(openBatch({ blob, keys: [ek] }).data)));
  });

  return (
    <article className="card" style={{ background: "var(--bg)" }}>
      <div className="card-pad" style={{ display: "grid", gap: 12 }}>
        <div className="who" style={{ justifyContent: "space-between" }}>
          <span className="who"><Lamp state={mine?.ack ? "lit" : "unlit"} label={mine?.ack ? "Acknowledged" : "Not acknowledged"} /><span className="name">{a.id}</span><span className="meta">epoch {a.epoch} · halt <span className="height">{fmt(a.targetHeight)}</span></span></span>
          <span className="meta">{a.ready} of {a.members} ready</span>
        </div>
        {!sealedToThisKey && !mine?.ack && <p className="meta" style={{ margin: 0 }}>Sealed to your previous sealing key, so it cannot be opened here</p>}
        {sealedToThisKey && !opened && !mine?.ack && !sentTx && <div><button className="btn" disabled={!!busy} onClick={open}>{busy === `open:${a.id}` ? "Decrypting…" : "Open with my key"}</button></div>}
        {opened && (
          <div style={{ display: "grid", gap: 8 }}>
            <div className="name">{opened.title}</div>
            {opened.details && <p className="muted" style={{ margin: 0 }}>{opened.details}</p>}
            {opened.patch && <div className="mono faint" style={{ fontSize: 12 }}>patch {opened.patch.version} · sha256 {short(opened.patch.sha256, 12, 8)}</div>}
          </div>
        )}
        {mine?.ack || sentTx ? (
          <span className="who" style={{ gap: 12 }}><Tag tone="ok">Acknowledged</Tag><TxLinks hash={mine?.ack?.tx ?? sentTx!} label="Acknowledgement" />{!mine?.ack && <span className="meta">counted on the next read</span>}</span>
        ) : opened ? (
          <div><button className="btn primary" disabled={!!busy} onClick={() => run(label, async () => {
            const tx = await acknowledge(address, q.coordinator, `quorate/1 ack ${a.id} epoch ${a.epoch} blob ${a.blobHash}`);
            setSentTx(tx.txHash);
            onAck(tx);
          })}>{busy === label ? "Waiting for QoreX…" : "Acknowledge with QoreX"}</button></div>
        ) : null}
      </div>
    </article>
  );
}

async function fetchBytes(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download ${url.split("/").pop()}`);
  return new Uint8Array(await res.arrayBuffer());
}
