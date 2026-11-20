import { useState } from "react";
import type { RosterData, RosterRow } from "./api";
import { ago, short, useResource } from "./api";
import { ErrorBox, Lamp, Placeholder, Simulated, Tag } from "./ui";

type SetName = "demo" | "testnet" | "mainnet";
const SETS: { id: SetName; label: string; blurb: string }[] = [
  { id: "demo", label: "Demo set", blurb: "The operators this demo seals to on qorechain-diana, testnet accounts run by this project" },
  { id: "testnet", label: "Testnet validators", blurb: "The bonded validator set of qorechain-diana, read live. Their operator accounts are what Quorate would seal to" },
  { id: "mainnet", label: "Mainnet validators", blurb: "The bonded validator set of qorechain-vladi, read live. Quorate can seal only to operators with a registered encryption key" },
];

export function RosterView() {
  const [set, setSet] = useState<SetName>("demo");
  const meta = SETS.find((s) => s.id === set)!;
  return (
    <>
      <header className="pagehead">
        <h1>Who can receive an advisory</h1>
        <p>
          Quorate seals only to operators with an ML-KEM-1024 key in QoreChain's encryption key registry, and counts only
          acknowledgements signed with a registered ML-DSA-87 key. Both registries are read live.
        </p>
      </header>
      <div className="seg-ctl" role="group" aria-label="Validator set" style={{ marginBottom: 16 }}>
        {SETS.map((s) => (
          <button key={s.id} aria-pressed={set === s.id} onClick={() => setSet(s.id)}>{s.label}</button>
        ))}
      </div>
      <p className="muted" style={{ margin: "0 0 16px" }}>{meta.blurb}</p>
      <RosterTable key={set} set={set} />
    </>
  );
}

const signingTag = (r: RosterRow) => {
  if (r.signingKey === "unknown") return <Tag tone="neutral">Could not read</Tag>;
  if (!r.signingKey) return <Tag tone="bad">None</Tag>;
  return r.signingKey.possessionProven
    ? <Tag tone="ok">Hybrid, possession proven</Tag>
    : <Tag tone="neutral">Hybrid, possession not proven</Tag>;
};
const encTag = (r: RosterRow) =>
  r.encryptionKey === "unknown" ? <Tag tone="neutral">Could not read</Tag>
  : r.encryptionKey ? <Tag tone="ok">{r.sealer ? "Registered, on its sealing account" : "Registered"}</Tag> : <Tag tone="neutral">Not registered</Tag>;

function RosterTable({ set }: { set: SetName }) {
  const { data, error, loading, reload } = useResource<RosterData>(`/api/roster?set=${set}`);
  if (error && !data) return <ErrorBox message={error} onRetry={reload} />;
  if (!data) return <div className="stack"><Placeholder height={84} /><Placeholder height={280} /></div>;

  const n = data.rows.length;
  const enc = data.rows.filter((r) => r.encryptionKey === true).length;
  const proven = data.rows.filter((r) => r.signingKey && r.signingKey !== "unknown" && r.signingKey.possessionProven).length;
  const real = set !== "demo";
  const powerReady = real ? data.rows.filter((r) => r.encryptionKey === true).reduce((s, r) => s + (r.votingPowerBps ?? 0), 0) / 100 : null;

  return (
    <div className="stack">
      <div className="card kpis">
        <div className="kpi">
          <div className="meta">{real ? "Voting power Quorate can reach today" : "Current epoch"}</div>
          <div className={`kpi-n${real ? " lead" : ""}`}>{real ? <>{powerReady!.toFixed(1)}<small>%</small></> : (data.currentEpoch ?? "—")}</div>
        </div>
        <div className="kpi">
          <div className="meta">Encryption keys registered</div>
          <div className="kpi-n">{enc}<small>of {n}</small></div>
        </div>
        <div className="kpi">
          <div className="meta">Signing keys with proof of possession</div>
          <div className="kpi-n">{proven}<small>of {n}</small></div>
        </div>
      </div>

      {real && enc === 0 && (
        <div className="note">
          <span><strong>No validator here can receive a sealed advisory yet</strong> · Each operator registers an ML-KEM-1024 key once, one <span className="mono">MsgRegisterKEMKey</span> transaction, as the demo operators did</span>
        </div>
      )}

      <div className="card tablewrap">
        <table className="table">
          <thead>
            <tr>
              <th>{real ? "Validator" : "Operator"}</th>
              <th>Operator account</th>
              {real ? <th style={{ textAlign: "right" }}>Voting power</th> : <th>Epochs</th>}
              <th>Signing key</th>
              <th>Encryption key</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.address}>
                <td>
                  <span className="who">
                    <Lamp state={r.encryptionKey === true ? "lit" : "unlit"} label={r.encryptionKey === true ? "Can receive" : "Cannot receive"} />
                    <span>
                      <span className="name">{r.name}</span> {r.simulated && <Simulated />}
                      {!real && r.inCurrentEpoch === false && <span className="meta"> · left the set, locked out of later epochs</span>}
                    </span>
                  </span>
                </td>
                <td className="mono faint" title={r.address}>{short(r.address, 12, 6)}</td>
                {real ? <td className="mono" style={{ textAlign: "right" }}>{((r.votingPowerBps ?? 0) / 100).toFixed(1)}%</td> : <td className="mono">{r.epochs?.join(", ") || "—"}</td>}
                <td>{signingTag(r)}</td>
                <td>{encTag(r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="meta mono" style={{ margin: 0 }}>{data.chainId} · read {ago(data.readAt)}{loading ? " · refreshing" : ""}</p>
    </div>
  );
}
