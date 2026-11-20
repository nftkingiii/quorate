// The QoreX control in the top bar: connect, or show the connected account with
// a menu (full address with copy, go to the Operator tab, disconnect).
import { useEffect, useRef, useState } from "react";
import { short } from "./api";
import { useWallet } from "./WalletContext";
import { explain } from "./wallet";
import { CopyButton } from "./ui";

export function WalletButton({ goOperator }: { goOperator: () => void }) {
  const { hasWallet, mock, address, connecting, connect, disconnect } = useWallet();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  if (!address) {
    return (
      <div className="walletbox" ref={box}>
        <button
          className="btn primary small"
          disabled={connecting || !hasWallet}
          title={hasWallet ? "Connect your QoreX account on Testnet" : "QoreX was not found in this browser"}
          onClick={async () => {
            setError(null);
            try { await connect(); } catch (e) { setError(explain(e)); setOpen(true); }
          }}
        >
          {connecting ? "Waiting for QoreX…" : hasWallet ? "Connect QoreX" : "QoreX not found"}
        </button>
        {open && error && (
          <div className="walletmenu" role="dialog" aria-label="QoreX">
            <p className="meta" style={{ margin: 0 }}>{error}</p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="walletbox" ref={box}>
      <button className="walletchip" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} title={address}>
        <span className="lamp lit" aria-hidden="true" />
        <span className="mono">{short(address, 8, 4)}</span>
        {mock && <span className="tag sim">test wallet</span>}
      </button>
      {open && (
        <div className="walletmenu" role="menu" aria-label="QoreX account">
          <div className="meta">Connected with QoreX{mock ? " (mock)" : ""} · Testnet</div>
          <code className="code">{address}</code>
          <CopyButton text={address} label="Copy address" small />
          <button className="btn small" role="menuitem" onClick={() => { setOpen(false); goOperator(); }}>Operator tab</button>
          <button className="btn small" role="menuitem" onClick={() => { setOpen(false); disconnect(); }}>Disconnect</button>
          <p className="meta" style={{ margin: 0 }}>Disconnecting forgets this account on this page and clears the sealing key from memory. QoreX keeps its own permission for the site until you remove it there.</p>
        </div>
      )}
    </div>
  );
}
