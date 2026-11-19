// Quorate read-only server. It holds no keys and signs nothing.
// QoreChain's public REST endpoints send no CORS headers, so the browser
// cannot read them directly; this server reads the chain, applies the quorum
// rules (lib/quorum-core.mjs) and serves the built app.
//
//   GET /api/quorum                      anchors, advisories, acks, rejections
//   GET /api/roster?set=demo|testnet|mainnet
//   GET /api/epoch/current               members of the latest epoch + their ML-KEM keys
//   GET /advisories/<file>               the public ciphertext files
//   everything else                      web/dist (single-page app)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_COORDINATOR, readQuorum } from "../lib/quorum-core.mjs";
import { chainClock } from "../lib/protocol.mjs";
import { toAccount } from "../lib/bech32.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "web", "dist");
const ADVISORIES = join(ROOT, "advisories");
const PORT = Number(process.env.PORT ?? 8787);
const NETWORKS = {
  testnet: { rest: "https://api-testnet.qore.host", chainId: "qorechain-diana" },
  mainnet: { rest: "https://api.qore.host", chainId: "qorechain-vladi" },
};
const ROLES = {
  qor1f78j6m6wfvpn5468tpznhcs7p4lm30hejv3zj0: "Coordinator",
  qor1gxxaq0vznphf4jmhgkyhg8af0nzkqwfrl6a6qd: "Operator 1",
  qor1nugsk7fcvcufx5ad4y82zfjwn3kyrn85e3d6cx: "Operator 2",
  qor1aq8tx4y2jke8snqgu6ajdav23nyyw7cznt9c4q: "Operator 3",
  qor17p9ekrjnwcd5qmwjhz4g5dc38w6f9dx9f2anxt: "Operator 4",
};
const ADVISORY_FILE = /^(epoch-\d{1,6}\.json|[A-Za-z0-9-]{1,32}\.blob)$/;

// Small TTL cache so a busy page does not hammer the public endpoints.
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  if (hit?.pending) return hit.pending;
  const pending = fn().then(
    (value) => { cache.set(key, { at: Date.now(), value }); return value; },
    (err) => { cache.delete(key); throw err; },
  );
  cache.set(key, { ...(hit ?? {}), pending });
  return pending;
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.json();
}

const readAdvisory = async (name) => {
  if (!ADVISORY_FILE.test(name)) return null;
  const p = join(ADVISORIES, name);
  return existsSync(p) ? new Uint8Array(await readFile(p)) : null;
};

async function keyStatus(rest, address) {
  const [pqc, kem] = await Promise.all([
    getJson(`${rest}/qorechain/pqc/v1/account/${address}`).catch(() => null),
    getJson(`${rest}/qorechain/pqc/v1/kem/${address}`).catch(() => null),
  ]);
  return {
    signingKey: pqc ? (pqc.found ? { type: pqc.account?.key_type ?? null, possessionProven: pqc.account?.possession_proven === true } : null) : "unknown",
    encryptionKey: kem ? kem.found === true : "unknown",
  };
}

async function quorum() {
  const [q, clock] = await Promise.all([readQuorum({ coordinator: DEFAULT_COORDINATOR, readFile: readAdvisory }), chainClock()]);
  return { ...q, network: "testnet", chainId: NETWORKS.testnet.chainId, ...clock, readAt: new Date().toISOString() };
}

async function roster(set) {
  if (set === "demo") {
    const q = await cached("quorum", 15000, quorum);
    const all = [...new Set(q.epochs.flatMap((e) => e.members))];
    const latest = q.epochs.at(-1);
    const rows = await Promise.all(all.map(async (address) => ({
      address, name: ROLES[address] ?? address.slice(0, 12), simulated: true,
      epochs: q.epochs.filter((e) => e.members.includes(address)).map((e) => e.epoch),
      inCurrentEpoch: latest?.members.includes(address) ?? false,
      ...(await keyStatus(NETWORKS.testnet.rest, address)),
    })));
    return { set, network: "testnet", chainId: NETWORKS.testnet.chainId, currentEpoch: latest?.epoch ?? null, rows, readAt: new Date().toISOString() };
  }
  const net = NETWORKS[set];
  const d = await getJson(`${net.rest}/cosmos/staking/v1beta1/validators?status=BOND_STATUS_BONDED&pagination.limit=200`);
  const total = d.validators.reduce((s, v) => s + BigInt(v.tokens), 0n) || 1n;
  const rows = await Promise.all(d.validators.map(async (v) => {
    const address = toAccount(v.operator_address);
    return {
      address, name: v.description?.moniker || v.operator_address.slice(0, 16), simulated: false,
      votingPowerBps: Number((BigInt(v.tokens) * 10000n) / total),
      ...(await keyStatus(net.rest, address)),
    };
  }));
  rows.sort((a, b) => b.votingPowerBps - a.votingPowerBps);
  return { set, network: set, chainId: net.chainId, rows, readAt: new Date().toISOString() };
}

async function currentEpoch() {
  const q = await cached("quorum", 15000, quorum);
  const latest = q.epochs.at(-1);
  if (!latest) return { epoch: null, members: [] };
  const members = await Promise.all(latest.members.map(async (address) => {
    const k = await getJson(`${NETWORKS.testnet.rest}/qorechain/pqc/v1/kem/${address}`);
    return { address, name: ROLES[address] ?? null, simulated: true, mlkemPublicKey: k.key?.public_key ?? null };
  }));
  return { epoch: latest.epoch, anchor: latest.anchor, chainId: NETWORKS.testnet.chainId, members };
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2" };
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
};

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type, ...SECURITY_HEADERS, "Cache-Control": type.startsWith("application/json") ? "no-store" : "public, max-age=300" });
  res.end(typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "read-only" });
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/api/quorum") return send(res, 200, await cached("quorum", 15000, quorum));
    if (url.pathname === "/api/roster") {
      const set = url.searchParams.get("set") ?? "demo";
      if (!["demo", "testnet", "mainnet"].includes(set)) return send(res, 400, { error: "set must be demo, testnet or mainnet" });
      return send(res, 200, await cached(`roster:${set}`, 30000, () => roster(set)));
    }
    if (url.pathname === "/api/epoch/current") return send(res, 200, await cached("epoch", 15000, currentEpoch));
    if (url.pathname === "/api/health") return send(res, 200, { ok: true });
    if (url.pathname.startsWith("/advisories/")) {
      const bytes = await readAdvisory(url.pathname.slice("/advisories/".length));
      return bytes ? send(res, 200, bytes, url.pathname.endsWith(".json") ? "application/json" : "application/octet-stream") : send(res, 404, { error: "not found" });
    }
    if (url.pathname.startsWith("/api/")) return send(res, 404, { error: "not found" });

    // Static app with single-page fallback.
    const safe = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
    let file = join(DIST, safe);
    if (!file.startsWith(DIST) || !existsSync(file) || safe === "") file = join(DIST, "index.html");
    if (!existsSync(file)) return send(res, 503, "The app is not built yet: run npm run build.", "text/plain; charset=utf-8");
    return send(res, 200, await readFile(file), TYPES[extname(file)] ?? "application/octet-stream");
  } catch (err) {
    console.error(url.pathname, err.message);
    return send(res, 502, { error: "Could not read the chain right now. Try again shortly.", detail: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Quorate read-only server on http://localhost:${PORT}`);
  // Warm the cache so the first visitor does not wait for a cold chain read.
  cached("quorum", 15000, quorum).catch((e) => console.error("warm-up failed:", e.message));
});
