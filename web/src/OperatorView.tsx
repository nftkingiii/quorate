import { useCallback, useEffect, useMemo, useState } from "react";
import type { SealKeyPair } from "@qorechain/qoreseal";
import { openBatch, openEpochKey } from "@qorechain/qoreseal";
import { sha3_256 } from "@noble/hashes/sha3.js";
import type { AccountData, Advisory, QuorumData } from "./api";
import { fmt, getJson, short } from "./api";
import { CHAIN_ID, acknowledge, connect, explain, isMock, qorex, registerSealingKey } from "./wallet";
import type { TxOutcome } from "./wallet";
import { MIN_PASSPHRASE, createSealKey, downloadJson, exportBackup, fromBase64, importBackup, keyFingerprint, toHex } from "./sealkey";
import { ErrorBox, Lamp, Tag, TxLinks } from "./ui";

const EPOCH_PURPOSE = "epoch-key:quorate-advisories";

type Opened = { title?: string; details?: string; severity?: string; simulated?: boolean; patch?: { version: string; sha256: string } | null; upgradeHeight?: number };

export function OperatorView({ q, reloadQuorum }: { q: QuorumData | null; reloadQuorum: () => void }) {
  const [address, setAddress] = useState<string | null>(null);
  const [account, setAccount] = useState<AccountData | null>(null);
  const [keys, setKeys] = useState<SealKeyPair | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<{ what: string; tx: TxOutcome } | null>(null);
  const [hasWallet, setHasWallet] = useState(() => !!qorex());

  // QoreX can inject itself after the page loads; keep looking until it does.
  useEffect(() => {
    if (hasWallet) return;
    const t = setInterval(() => { if (qorex()) setHasWallet(true); }, 1000);
    return () => clearInterval(t);
  }, [hasWallet]);

  // Keeps the last good reading if the chain cannot be read; retries a few times.
  const refreshAccount = useCallback(async (a: string) => {
    let last: unknown;
    for (let i = 0; i < 3; i++) {
      try { setAccount(await getJson<AccountData>(`/api/account?address=${a}`)); return; }
      catch (e) { last = e; await new Promise((r) => setTimeout(r, 1500 * (i + 1))); }
    }
    throw new Error(`Could not read your account from the chain (${(last as Error)?.message}). Try again shortly.`);
  }, []);

  // While the account has not been read cleanly, keep trying in the background.
  useEffect(() => {
    if (!address || (account && account.encryptionKey !== "unknown")) return;
    let alive = true;
    const go = () => refreshAccount(address).catch((e) => alive && setError((e as Error).message));
    go();
    const t = setInterval(go, 10000);
    return () => { alive = false; clearInterval(t); };
  }, [address, account, refreshAccount]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setError(null);
    try { await fn(); } catch (e) { setError(explain(e)); } finally { setBusy(null); }
  };

  const chainKey = account && account.encryptionKey !== "unknown" ? account.encryptionKey : null;
  const keyMatches = !!(keys && chainKey?.found && chainKey.publicKeySha3 === keyFingerprint(keys));
  const myEpochs = useMemo(() => (q && address ? q.epochs.filter((e) => e.members.includes(address)).map((e) => e.epoch) : []), [q, address]);
  const myAdvisories = useMemo(() => (q && address ? q.advisories.filter((a) => a.roster.some((m) => m.address === address)).reverse() : []), [q, address]);

  // Which single step is next.
  const step = !hasWallet ? "install" : !address ? "connect" : !account || account.encryptionKey === "unknown" ? "loading"
    : !chainKey?.found && !keys ? "create"
    : !chainKey?.found && keys ? "register"
    : chainKey?.found && !keys ? "import"
    : !keyMatches ? "mismatch"
    : myEpochs.length === 0 ? "waiting" : "member";

  return (
    <>
      <header className="pagehead">
        <h1>Operate as a validator</h1>
        <p>
          Connect your QoreX account to receive sealed advisories. Your ML-KEM-1024 sealing key is created and used in this
          browser only; QoreX signs every on-chain step with secp256k1 and ML-DSA-87 together.
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
            <Step n="02" done={!!keys} current={step === "create" || step === "import" || step === "mismatch"}>Sealing key in this browser{keys && <span className="mono faint"> · {short(keyFingerprint(keys), 8, 4)}</span>}</Step>
            <Step n="03" done={keyMatches} current={step === "register"}>Encryption key registered on chain</Step>
            <Step n="04" done={myEpochs.length > 0} current={step === "waiting"}>Added to the set by the coordinator{myEpochs.length > 0 && <span className="faint"> · epoch {myEpochs.join(", ")}</span>}</Step>
            <Step n="05" done={false} current={step === "member"}>Open advisories and acknowledge</Step>
          </ol>
          {account && (
            <dl className="facts" style={{ marginTop: 16 }}>
              <dt>Signing key</dt><dd>{account.signingKey && account.signingKey !== "unknown" ? `Hybrid${account.signingKey.possessionProven ? ", possession proven" : ""}` : account.signingKey === "unknown" ? "Could not read" : "None yet; QoreX registers it with your first transaction"}</dd>
              <dt>Balance</dt><dd className="mono">{account.balanceUqor == null ? "—" : `${(Number(account.balanceUqor) / 1e6).toFixed(2)} QOR`}</dd>
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
              <p className="muted">QoreX asks you to connect this site. The page learns your qor1 address and nothing else.</p>
              <button className="btn primary" disabled={!!busy} onClick={() => run("connect", async () => {
                const a = await connect(); setAddress(a.address); await refreshAccount(a.address);
              })}>{busy ? "Waiting for QoreX…" : "Connect QoreX"}</button>
            </Panel>
          )}

          {step === "loading" && <p className="muted">Reading your account…</p>}

          {step === "create" && address && (
            <CreateKey address={address} busy={!!busy} onCreated={(k) => { setKeys(k); setError(null); }} onError={setError} />
          )}

          {step === "register" && address && keys && (
            <Panel title="Publish your encryption key">
              <p className="muted">One transaction, <span className="mono">MsgRegisterKEMKey</span>, publishes the public half of your sealing key so the coordinator can seal advisories to you. QoreX shows it and asks you to approve.</p>
              <button className="btn primary" disabled={!!busy} onClick={() => run("register", async () => {
                const tx = await registerSealingKey(address, keys.mlkemPublicKey);
                setLastTx({ what: "Encryption key registered", tx });
                await refreshAccount(address);
              })}>{busy ? "Waiting for QoreX…" : "Register with QoreX"}</button>
            </Panel>
          )}

          {step === "import" && address && (
            <ImportKey address={address} expectFp={chainKey?.publicKeySha3 ?? null} onLoaded={(k) => { setKeys(k); setError(null); }} onError={setError} />
          )}

          {step === "mismatch" && (
            <Panel title="This key is not the one on chain">
              <p className="muted">The sealing key in this browser does not match the encryption key registered for {short(address ?? "", 10, 6)}. Load the backup of the registered key instead. Registering this one would replace it, and you could no longer open advisories sealed to the old one.</p>
              <button className="btn" onClick={() => setKeys(null)}>Load a different backup</button>
            </Panel>
          )}

          {step === "waiting" && address && (
            <Panel title="Waiting for the coordinator">
              <p className="muted">Your key is on chain. The coordinator adds you when it starts the next epoch; advisories sealed from then on open here. Send the coordinator this address:</p>
              <pre className="code">{address}</pre>
              <button className="btn" disabled={!!busy} onClick={() => run("check", async () => { reloadQuorum(); await refreshAccount(address); })}>{busy === "check" ? "Checking…" : "Check again"}</button>
            </Panel>
          )}

          {step === "member" && address && keys && q && (
            <div className="stack">
              <h2 style={{ margin: 0, font: "500 18px/28px var(--sans)" }}>Advisories for you</h2>
              {myAdvisories.length === 0 && <p className="muted" style={{ margin: 0 }}>You are in epoch {myEpochs.join(", ")}. No advisory has been sealed to it yet.</p>}
              {myAdvisories.map((a) => (
                <AdvisoryForMe key={a.id} a={a} q={q} address={address} keys={keys} busy={busy} run={run}
                  onAck={(tx) => { setLastTx({ what: `${a.id} acknowledged`, tx }); reloadQuorum(); }} />
              ))}
            </div>
          )}

          {lastTx && (
            <div className="note" style={{ marginTop: 16 }}>
              <span><strong>{lastTx.what}</strong> · <TxLinks hash={lastTx.tx.txHash} /> {lastTx.tx.height ? <span className="meta">block {fmt(lastTx.tx.height)}</span> : null}{" "}
                {lastTx.tx.shield === "shielded" ? <Tag tone="ok">ML-DSA-87 layer on chain</Tag> : <Tag tone="neutral">Shield: {lastTx.tx.shield}</Tag>}</span>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

function Step({ n, done, current, children }: { n: string; done: boolean; current: boolean; children: React.ReactNode }) {
  return <li className={done ? "done" : current ? "current" : ""}><span className="mark">{done ? "✓" : n}</span><span>{children}</span></li>;
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return <div style={{ display: "grid", gap: 16, justifyItems: "start" }}><h2 style={{ margin: 0, font: "500 18px/28px var(--sans)" }}>{title}</h2>{children}</div>;
}

function CreateKey({ address, busy, onCreated, onError }: { address: string; busy: boolean; onCreated: (k: SealKeyPair) => void; onError: (m: string) => void }) {
  const [p1, setP1] = useState("");
  const [p2, setP2] = useState("");
  const [working, setWorking] = useState(false);
  const problem = p1.length < MIN_PASSPHRASE ? `At least ${MIN_PASSPHRASE} characters` : p1 !== p2 ? "The passphrases do not match" : null;
  return (
    <Panel title="Create your sealing key">
      <p className="muted" style={{ margin: 0 }}>The key is made in this browser and stays in memory. You get a backup file encrypted with your passphrase; you need it to open advisories after you close this tab. Without the file and passphrase, nobody can recover the key.</p>
      <form style={{ display: "grid", gap: 16, width: "100%" }} onSubmit={async (e) => {
        e.preventDefault();
        if (problem) return;
        setWorking(true);
        try {
          const k = createSealKey();
          const backup = await exportBackup(k, address, CHAIN_ID, p1);
          downloadJson(`quorate-sealing-key-${address.slice(-6)}.json`, backup);
          onCreated(k);
        } catch (err) { onError((err as Error).message); } finally { setWorking(false); }
      }}>
        <div className="row2">
          <div className="field"><label htmlFor="pp1">Backup passphrase</label><input id="pp1" className="input" type="password" autoComplete="new-password" value={p1} onChange={(e) => setP1(e.target.value)} /></div>
          <div className="field"><label htmlFor="pp2">Repeat it</label><input id="pp2" className="input" type="password" autoComplete="new-password" value={p2} onChange={(e) => setP2(e.target.value)} /></div>
        </div>
        {p1 && problem && <p className="meta" style={{ margin: 0 }}>{problem}</p>}
        <div><button className="btn primary" type="submit" disabled={!!problem || busy || working}>{working ? "Encrypting the backup…" : "Create key and download backup"}</button></div>
      </form>
    </Panel>
  );
}

function ImportKey({ address, expectFp, onLoaded, onError }: { address: string; expectFp: string | null; onLoaded: (k: SealKeyPair) => void; onError: (m: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [pass, setPass] = useState("");
  const [working, setWorking] = useState(false);
  return (
    <Panel title="Load your sealing key">
      <p className="muted" style={{ margin: 0 }}>This account already has an encryption key on chain. Load the backup file you saved when you created it.</p>
      <form style={{ display: "grid", gap: 16, width: "100%" }} onSubmit={async (e) => {
        e.preventDefault();
        if (!file) return;
        setWorking(true);
        try {
          const k = await importBackup(await file.text(), pass, { address, chainId: CHAIN_ID });
          if (expectFp && keyFingerprint(k) !== expectFp) throw new Error("This backup is a different key from the one registered on chain");
          onLoaded(k);
        } catch (err) { onError((err as Error).message); } finally { setWorking(false); }
      }}>
        <div className="field"><label htmlFor="bk">Backup file</label><input id="bk" className="input" type="file" accept="application/json,.json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></div>
        <div className="field"><label htmlFor="bkp">Passphrase</label><input id="bkp" className="input" type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} /></div>
        <div><button className="btn primary" type="submit" disabled={!file || !pass || working}>{working ? "Decrypting…" : "Load key"}</button></div>
      </form>
    </Panel>
  );
}

function AdvisoryForMe({ a, q, address, keys, busy, run, onAck }: {
  a: Advisory; q: QuorumData; address: string; keys: SealKeyPair; busy: string | null;
  run: (label: string, fn: () => Promise<void>) => Promise<void>; onAck: (tx: TxOutcome) => void;
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
    const ek = openEpochKey({ chainId: CHAIN_ID, purpose: EPOCH_PURPOSE, envelope: fromBase64(manifest.envelope), keys });
    const body = JSON.parse(new TextDecoder().decode(openBatch({ blob, keys: [ek] }).data));
    setOpened(body);
  });

  return (
    <article className="card" style={{ background: "var(--bg)" }}>
      <div className="card-pad" style={{ display: "grid", gap: 12 }}>
        <div className="who" style={{ justifyContent: "space-between" }}>
          <span className="who"><Lamp state={mine?.ack ? "lit" : "unlit"} label={mine?.ack ? "Acknowledged" : "Not acknowledged"} /><span className="name">{a.id}</span><span className="meta">epoch {a.epoch} · halt <span className="height">{fmt(a.targetHeight)}</span></span></span>
          <span className="meta">{a.ready} of {a.members} ready</span>
        </div>
        {!opened && !mine?.ack && !sentTx && <div><button className="btn" disabled={!!busy} onClick={open}>{busy === `open:${a.id}` ? "Decrypting…" : "Open with my key"}</button></div>}
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
            const memo = `quorate/1 ack ${a.id} epoch ${a.epoch} blob ${a.blobHash}`;
            const tx = await acknowledge(address, q.coordinator, memo);
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
