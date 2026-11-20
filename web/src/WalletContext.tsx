// App-wide wallet state, so switching tabs never drops the QoreX connection or
// the sealing key. What lives here:
//  - the connected QoreX address (and, in localStorage, only the fact that this
//    browser connected before, so a reload reconnects without a prompt);
//  - the sealing account derived from the operator's secret, in memory only.
// Nothing secret is ever written to storage.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { Sealer } from "./sealer";
import { CHAIN_ID, connect as qorexConnect, isMock, qorex } from "./wallet";

const REMEMBER = "quorate.qorex.connected";
const store = {
  get: () => { try { return localStorage.getItem(REMEMBER) === "1"; } catch { return false; } },
  set: (on: boolean) => { try { on ? localStorage.setItem(REMEMBER, "1") : localStorage.removeItem(REMEMBER); } catch { /* storage blocked: just no auto-reconnect */ } },
};

type WalletState = {
  hasWallet: boolean;
  mock: boolean;
  address: string | null;
  connecting: boolean;
  /** When the current connection was made; the Operator tab waits for a chain read newer than this. */
  connectedAt: number;
  connect: () => Promise<string>;
  /** Forgets the connection on this page. QoreX keeps its own site permission until you remove it there. */
  disconnect: () => void;
  sealer: Sealer | null;
  setSealer: (s: Sealer | null) => void;
};

const Ctx = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [hasWallet, setHasWallet] = useState(() => !!qorex());
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectedAt, setConnectedAt] = useState(0);
  const [sealer, setSealerState] = useState<Sealer | null>(null);

  // QoreX can inject itself after the page loads; keep looking until it does.
  useEffect(() => {
    if (hasWallet) return;
    const t = setInterval(() => { if (qorex()) setHasWallet(true); }, 1000);
    return () => clearInterval(t);
  }, [hasWallet]);

  const connect = useCallback(async () => {
    setConnecting(true);
    try {
      const a = await qorexConnect();
      setConnectedAt(Date.now() - 1000);
      setAddress((prev) => {
        if (prev && prev !== a.address) setSealerState(null); // a different account never inherits the previous key
        return a.address;
      });
      store.set(true);
      return a.address;
    } finally {
      setConnecting(false);
    }
  }, []);

  // Reconnect quietly after a reload if this browser connected before. If QoreX
  // is locked or the site was removed there, stay disconnected and say nothing.
  useEffect(() => {
    if (!hasWallet || address || !store.get()) return;
    qorex()?.getKey(CHAIN_ID)
      .then((k) => { setConnectedAt(Date.now() - 1000); setAddress(k.bech32Address); })
      .catch(() => {});
  }, [hasWallet, address]);

  const disconnect = useCallback(() => {
    store.set(false);
    setAddress(null);
    setSealerState(null);
  }, []);

  const value = useMemo<WalletState>(() => ({
    hasWallet, mock: isMock(), address, connecting, connectedAt, connect, disconnect,
    sealer, setSealer: setSealerState,
  }), [hasWallet, address, connecting, connectedAt, connect, disconnect, sealer]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallet outside WalletProvider");
  return v;
}
