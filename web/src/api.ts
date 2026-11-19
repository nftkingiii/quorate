import { useCallback, useEffect, useRef, useState } from "react";

export type Ack = { tx: string; height: number } | null;
export type Advisory = {
  id: string; epoch: number; targetHeight: number; anchor: string; anchorHeight: number;
  blobHash: string; blobBytes: number | null; blobMatches: boolean;
  ready: number; members: number; needed: number; quorate: boolean;
  roster: { address: string; ack: Ack }[];
};
export type Epoch = { epoch: number; members: string[]; anchor: string; height: number; envHash: string };
export type Rejected = { tx: string; height: number; from: string | null; kind: string; advisory?: string; reason: string };
export type QuorumData = {
  coordinator: string; network: string; chainId: string; height: number; blockSeconds: number | null; readAt: string;
  epochs: Epoch[]; advisories: Advisory[]; rejected: Rejected[];
};
export type KeyState = { type: string | null; possessionProven: boolean } | null | "unknown";
export type RosterRow = {
  address: string; name: string; simulated: boolean; votingPowerBps?: number;
  epochs?: number[]; inCurrentEpoch?: boolean;
  signingKey: KeyState; encryptionKey: boolean | "unknown";
};
export type RosterData = { set: string; network: string; chainId: string; currentEpoch?: number | null; rows: RosterRow[]; readAt: string };
export type CurrentEpoch = {
  epoch: number | null; anchor?: string; chainId: string;
  members: { address: string; name: string | null; simulated: boolean; mlkemPublicKey: string | null }[];
};

export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as T;
}

export function useResource<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    setLoading(true);
    try {
      const d = await getJson<T>(url);
      if (n === seq.current) { setData(d); setError(null); }
    } catch (e) {
      if (n === seq.current) setError((e as Error).message);
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [url]);
  useEffect(() => { load(); }, [load]);
  return { data, error, loading, reload: load };
}

export const ROLES: Record<string, string> = {
  qor1f78j6m6wfvpn5468tpznhcs7p4lm30hejv3zj0: "Coordinator",
  qor1gxxaq0vznphf4jmhgkyhg8af0nzkqwfrl6a6qd: "Operator 1",
  qor1nugsk7fcvcufx5ad4y82zfjwn3kyrn85e3d6cx: "Operator 2",
  qor1aq8tx4y2jke8snqgu6ajdav23nyyw7cznt9c4q: "Operator 3",
  qor17p9ekrjnwcd5qmwjhz4g5dc38w6f9dx9f2anxt: "Operator 4",
};
export const short = (s: string, a = 10, b = 6) => (s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s);
export const fmt = (n: number) => n.toLocaleString("en-US");
export const restTx = (hash: string) => `https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/${hash}`;
export const explorerTx = (hash: string) => `https://explore.qore.network/tx/${hash}`;
export const ago = (iso: string, now = Date.now()) => {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
};
// A rough time hint from the block time the server measured over the last 1,000 blocks.
export const blocksToTime = (blocks: number, blockSeconds: number | null) => {
  if (!blockSeconds) return null;
  const mins = Math.round((blocks * blockSeconds) / 60);
  if (mins < 90) return `about ${Math.max(1, mins)} min`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `about ${hours} h` : `about ${Math.round(hours / 24)} days`;
};
