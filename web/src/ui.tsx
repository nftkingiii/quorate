import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { explorerTx, restTx, short } from "./api";

export function TxLinks({ hash, label = "Transaction" }: { hash: string; label?: string }) {
  return (
    <span className="txlinks">
      <a href={restTx(hash)} target="_blank" rel="noreferrer" title={`${label} ${hash} as raw chain data`}>
        <span className="mono">{short(hash, 8, 6)}</span>
      </a>
      <a href={explorerTx(hash)} target="_blank" rel="noreferrer" title="Opens the QoreChain explorer; switch it to Testnet">
        Explorer
      </a>
    </span>
  );
}

/** Copies text to the clipboard and says so for two seconds. */
export function CopyButton({ text, label = "Copy", small = false }: { text: string; label?: string; small?: boolean }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      // Older path for browsers or embedded views that block the async clipboard.
      const ta = Object.assign(document.createElement("textarea"), { value: text });
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;opacity:0;pointer-events:none";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      setState(ok ? "copied" : "failed"); // failed: the text is on screen to select by hand
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 2000);
  };
  return (
    <button type="button" className={`btn${small ? " small" : ""}`} onClick={copy} aria-live="polite">
      <CopyIcon /> {state === "copied" ? "Copied" : state === "failed" ? "Select and copy" : label}
    </button>
  );
}

function CopyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function Tag({ tone, children }: { tone: "ok" | "warn" | "bad" | "neutral"; children: ReactNode }) {
  return <span className={`tag ${tone}`}>{children}</span>;
}

/** Marks an operator this project runs on testnet, so it is never mistaken for a real validator. */
export function Simulated() {
  return <span className="tag sim">simulated</span>;
}

/** The signature detail: an operator's lamp, lit when its acknowledgement counts. */
export function Lamp({ state, label }: { state: "lit" | "unlit" | "off"; label: string }) {
  return <span className={`lamp${state === "unlit" ? "" : ` ${state}`}`} role="img" aria-label={label} />;
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error" role="alert">
      {message}{" "}
      {onRetry && <button className="linkbtn" onClick={onRetry}>Try again</button>}
    </div>
  );
}

export function Placeholder({ height, label = "Reading the chain" }: { height: number; label?: string }) {
  return <div className="placeholder" style={{ height }} role="status" aria-label={label} />;
}

export function Chevron() {
  return (
    <svg className="chev" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg className={spinning ? "spin" : undefined} width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M13.5 8a5.5 5.5 0 1 1-1.8-4.07M13.5 2.5v3h-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The moment: one lamp segment per operator around the ring, lit when its
 * acknowledgement counts. An orange tick marks how many are needed for a
 * quorum (more than two thirds).
 */
export function QuorumRing({ lit, total, needed, quorate }: { lit: boolean[]; total: number; needed: number; quorate: boolean }) {
  const size = 216, c = size / 2, r = 84, w = 14;
  const gap = total > 1 ? 6 : 0; // degrees between segments
  const seg = 360 / total;
  const point = (deg: number, radius: number) => {
    const a = ((deg - 90) * Math.PI) / 180;
    return [c + radius * Math.cos(a), c + radius * Math.sin(a)];
  };
  const arc = (from: number, to: number) => {
    const [x1, y1] = point(from, r);
    const [x2, y2] = point(to, r);
    return `M ${x1} ${y1} A ${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x2} ${y2}`;
  };
  const tickDeg = needed * seg; // the gap after the last segment a quorum needs
  const [tx1, ty1] = point(tickDeg, r + w / 2 + 4);
  const [tx2, ty2] = point(tickDeg, r + w / 2 + 14);
  const ready = lit.filter(Boolean).length;
  return (
    <svg className="ring" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${ready} of ${total} operators ready, ${needed} needed`}>
      {lit.map((on, i) => (
        <path
          key={i}
          className="seg"
          d={total === 1 ? `M ${c} ${c - r} A ${r} ${r} 0 1 1 ${c - 0.01} ${c - r}` : arc(i * seg + gap / 2, (i + 1) * seg - gap / 2)}
          fill="none"
          stroke={on ? "var(--ready)" : "var(--unlit)"}
          strokeWidth={w}
          strokeLinecap="butt"
        />
      ))}
      {needed < total && <line x1={tx1} y1={ty1} x2={tx2} y2={ty2} stroke="var(--accent)" strokeWidth={2} strokeLinecap="round" />}
      <text className="ring-n" x={c} y={c + 6} textAnchor="middle">{ready}</text>
      <text className="ring-of" x={c} y={c + 30} textAnchor="middle">of {total} ready</text>
      <text className="ring-state" x={c} y={c - 30} textAnchor="middle" fill={quorate ? "var(--ready)" : "var(--accent)"}>
        {quorate ? "Quorate" : `Short by ${Math.max(0, needed - ready)}`}
      </text>
    </svg>
  );
}
