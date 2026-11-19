import { useEffect, useState } from "react";
import type { QuorumData } from "./api";
import { ago, fmt, useResource } from "./api";
import { QuorumView } from "./QuorumView";
import { AdvisoryView } from "./AdvisoryView";
import { RosterView } from "./RosterView";
import { OperatorView } from "./OperatorView";
import { RefreshIcon } from "./ui";

type Tab = "quorum" | "advisory" | "operator" | "roster";
const TABS: { id: Tab; label: string }[] = [
  { id: "quorum", label: "Quorum" },
  { id: "advisory", label: "Advisory" },
  { id: "operator", label: "Operator" },
  { id: "roster", label: "Roster" },
];
const fromHash = (): Tab => {
  const h = location.hash.slice(1);
  return (TABS.some((t) => t.id === h) ? h : "quorum") as Tab;
};

export function App() {
  const [tab, setTab] = useState<Tab>(fromHash);
  const q = useResource<QuorumData>("/api/quorum");
  const [, tick] = useState(0);

  useEffect(() => {
    const onHash = () => setTab(fromHash());
    window.addEventListener("hashchange", onHash);
    const t = setInterval(() => tick((n) => n + 1), 15000);
    return () => { window.removeEventListener("hashchange", onHash); clearInterval(t); };
  }, []);
  const go = (t: Tab) => { history.replaceState(null, "", `#${t}`); setTab(t); window.scrollTo({ top: 0 }); };

  return (
    <>
      <div className="topbar">
        <div className="topbar-inner">
          <a className="wordmark" href="#quorum" onClick={(e) => { e.preventDefault(); go("quorum"); }}>
            <img src="/seal.svg" alt="" /> Quorate
          </a>
          <nav className="tabs" role="tablist" aria-label="Sections">
            {TABS.map((t) => (
              <button key={t.id} className="tab" role="tab" aria-selected={tab === t.id} aria-controls="panel" onClick={() => go(t.id)}>{t.label}</button>
            ))}
          </nav>
          <div className="netchip">
            {q.data && (
              <span className="clock" title={`${q.data.chainId}, latest block`}>
                <span className="faint">Testnet block</span>
                <span className="height now">{fmt(q.data.height)}</span>
                <span className="faint read">· read {ago(q.data.readAt)}</span>
              </span>
            )}
            <button className="iconbtn" onClick={q.reload} disabled={q.loading} aria-label="Read the chain again"><RefreshIcon spinning={q.loading} /></button>
          </div>
        </div>
      </div>
      <main className="shell" id="panel" role="tabpanel">
        {tab === "quorum" && <QuorumView q={q.data} error={q.error} onRetry={q.reload} goRoster={() => go("roster")} />}
        {tab === "advisory" && <AdvisoryView q={q.data} />}
        {tab === "operator" && <OperatorView q={q.data} reloadQuorum={q.reload} />}
        {tab === "roster" && <RosterView />}
        <footer className="foot">
          <span>Quorate · built for Build Before Q-Day</span>
          <a href="https://github.com/nftkingiii/quorate" target="_blank" rel="noreferrer">Source and evidence</a>
          <span>The server holds no keys; your sealing key stays in this browser and QoreX does the signing</span>
          <span>Interface pass after <a href="https://github.com/heydamir/unslop" target="_blank" rel="noreferrer">unslop</a> by Damir Sokolovsky, CC BY 4.0</span>
        </footer>
      </main>
    </>
  );
}
