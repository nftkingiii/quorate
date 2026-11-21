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
import { existsSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { DEFAULT_COORDINATOR, readQuorum } from "../lib/quorum-core.mjs";
import { chainClock } from "../lib/protocol.mjs";
import { toAccount } from "../lib/bech32.mjs";
import { isQorAddress, keyStatus as keyStatusOf, readAccount } from "../lib/accounts.mjs";
import { MAX_TX_BYTES, checkRelayTx, rateLimiter } from "../lib/relay.mjs";

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
  qor1d29r40km6savysgcqm4zy6308ya2kljd8dcazm: "QoreX mock (test wallet)",
  qor1hhd5njxjwjp3hhmu675rjwqutehfwpyekqacay: "QoreX mock 2 (test wallet)",
};
const SIMULATED = new Set(Object.keys(ROLES).filter((a) => ROLES[a].startsWith("Operator")));
const ADVISORY_FILE = /^(epoch-\d{1,6}\.json|[A-Za-z0-9-]{1,32}\.blob)$/;

// Small TTL cache so a busy page does not hammer the public endpoints.
const cache = new Map();
const CACHE_MAX = 500; // bounds memory when many different accounts are looked up
async function cached(key, ttlMs, fn) {
  if (cache.size > CACHE_MAX) for (const k of [...cache.keys()].slice(0, 100)) cache.delete(k);
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

const keyStatus = (rest, address) => keyStatusOf(getJson, rest, address);

async function quorum() {
  const [q, clock] = await Promise.all([readQuorum({ coordinator: DEFAULT_COORDINATOR, readFile: readAdvisory }), chainClock()]);
  return { ...q, network: "testnet", chainId: NETWORKS.testnet.chainId, ...clock, readAt: new Date().toISOString() };
}

async function roster(set) {
  if (set === "demo") {
    const q = await cached("quorum", 15000, quorum);
    const all = [...new Set(q.epochs.flatMap((e) => e.members))];
    const latest = q.epochs.at(-1);
    const rows = await Promise.all(all.map(async (address) => {
      const own = await keyStatus(NETWORKS.testnet.rest, address);
      // An operator bound both ways to a sealing account receives through that account's key.
      const b = [...q.bindings].reverse().find((x) => x.operator === address && x.mutual);
      const viaSealer = b ? (await keyStatus(NETWORKS.testnet.rest, b.sealer)).encryptionKey : null;
      return {
        address, name: ROLES[address] ?? "QoreX operator", simulated: SIMULATED.has(address),
        epochs: q.epochs.filter((e) => e.members.includes(address)).map((e) => e.epoch),
        inCurrentEpoch: latest?.members.includes(address) ?? false,
        ...own,
        ...(b && viaSealer === true ? { encryptionKey: true, sealer: b.sealer } : {}),
      };
    }));
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
    return { address, name: ROLES[address] ?? "QoreX operator", simulated: SIMULATED.has(address), mlkemPublicKey: k.key?.public_key ?? null };
  }));
  return { epoch: latest.epoch, anchor: latest.anchor, chainId: NETWORKS.testnet.chainId, members };
}

const account = (address) => readAccount(getJson, NETWORKS.testnet.rest, address);

// ---- The relay -------------------------------------------------------------
const allowRelay = rateLimiter({ perKey: 10, globalMax: 200, windowMs: 10 * 60 * 1000 });
// Behind a proxy that sets X-Real-IP (Railway does), set TRUST_PROXY=1 so the limit is per visitor.
const visitor = (req) => (process.env.TRUST_PROXY === "1" && req.headers["x-real-ip"]) || req.socket.remoteAddress || "unknown";

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error("too large"), { tooLarge: true })); req.pause(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function relayRoute(req, res) {
  if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return send(res, 415, { error: "send JSON" });
  if (!allowRelay(String(visitor(req)))) return send(res, 429, { error: "Too many transactions from here; wait a few minutes" });
  let txBytes, raw;
  try {
    raw = await readBody(req, MAX_TX_BYTES * 2);
  } catch (err) {
    // Answer first, then drop the connection so an oversized upload stops.
    res.on("finish", () => req.destroy());
    return send(res, err.tooLarge ? 413 : 400, { error: err.tooLarge ? "Transaction too large" : "Could not read the request" });
  }
  try {
    const body = JSON.parse(raw.toString("utf8"));
    if (typeof body.txBytes !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.txBytes)) throw new Error("bad");
    txBytes = new Uint8Array(Buffer.from(body.txBytes, "base64"));
  } catch {
    return send(res, 400, { error: "Expected {\"txBytes\": base64}" });
  }
  const verdict = checkRelayTx(txBytes, DEFAULT_COORDINATOR);
  if (!verdict.ok) return send(res, 400, { error: `Refused: ${verdict.reason}` });
  try {
    const r = await fetch(`${NETWORKS.testnet.rest}/cosmos/tx/v1beta1/txs`, {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(20000),
      body: JSON.stringify({ tx_bytes: Buffer.from(txBytes).toString("base64"), mode: "BROADCAST_MODE_SYNC" }),
    });
    const out = await r.json().catch(() => ({}));
    const tr = out.tx_response;
    if (!tr) return send(res, 502, { error: "The chain did not accept the broadcast. Try again shortly." });
    if (tr.code !== 0) return send(res, 400, { error: `The chain refused it (code ${tr.code}): ${String(tr.raw_log ?? "").slice(0, 300)}` });
    console.log(`relayed ${verdict.kind} ${tr.txhash}`);
    return send(res, 200, { txHash: tr.txhash, kind: verdict.kind });
  } catch (err) {
    console.error("relay", err.message);
    return send(res, 502, { error: "Could not reach the chain. Try again shortly." });
  }
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

// Built files never change while the server runs, so each one is read and gzipped once.
// Vite puts a content hash in every name under assets/, so those can be cached for a year.
const COMPRESSIBLE = new Set([".html", ".js", ".css", ".svg", ".json"]);
const staticCache = new Map();
async function sendStatic(req, res, file) {
  let entry = staticCache.get(file);
  if (!entry) {
    const raw = await readFile(file);
    entry = { raw, gz: COMPRESSIBLE.has(extname(file)) && raw.length > 1024 ? gzipSync(raw, { level: 9 }) : null };
    staticCache.set(file, entry);
  }
  const hashed = file.startsWith(join(DIST, "assets") + sep);
  const gzip = entry.gz && /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
  res.writeHead(200, {
    "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
    ...SECURITY_HEADERS,
    "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
    ...(entry.gz ? { Vary: "Accept-Encoding" } : {}),
    ...(gzip ? { "Content-Encoding": "gzip" } : {}),
    "Content-Length": (gzip ? entry.gz : entry.raw).length,
  });
  res.end(gzip ? entry.gz : entry.raw);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  // One write route: /api/relay forwards a sealing account's signed transaction (lib/relay.mjs).
  if (req.method === "POST" && url.pathname === "/api/relay") return relayRoute(req, res);
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "read-only, except POST /api/relay" });
  try {
    if (url.pathname === "/api/quorum") return send(res, 200, await cached("quorum", 15000, quorum));
    if (url.pathname === "/api/roster") {
      const set = url.searchParams.get("set") ?? "demo";
      if (!["demo", "testnet", "mainnet"].includes(set)) return send(res, 400, { error: "set must be demo, testnet or mainnet" });
      return send(res, 200, await cached(`roster:${set}`, 30000, () => roster(set)));
    }
    if (url.pathname === "/api/epoch/current") return send(res, 200, await cached("epoch", 15000, currentEpoch));
    if (url.pathname === "/api/account") {
      const address = url.searchParams.get("address") ?? "";
      if (!isQorAddress(address)) return send(res, 400, { error: "address must be a qor1 account address" });
      return send(res, 200, await cached(`account:${address}`, 2000, () => account(address))); // short: the page reads its own changes back
    }
    if (url.pathname === "/api/tx") {
      const hash = (url.searchParams.get("hash") ?? "").toUpperCase();
      if (!/^[0-9A-F]{64}$/.test(hash)) return send(res, 400, { error: "hash must be 64 hex characters" });
      const t = await getJson(`${NETWORKS.testnet.rest}/cosmos/tx/v1beta1/txs/${hash}`).catch(() => null);
      const r = t?.tx_response;
      return send(res, 200, r ? { found: true, hash, code: r.code, height: Number(r.height), rawLog: r.code ? String(r.raw_log ?? "").slice(0, 300) : undefined } : { found: false, hash });
    }
    if (url.pathname === "/api/health") return send(res, 200, { ok: true });
    if (url.pathname.startsWith("/advisories/")) {
      const bytes = await readAdvisory(url.pathname.slice("/advisories/".length));
      return bytes ? send(res, 200, bytes, url.pathname.endsWith(".json") ? "application/json" : "application/octet-stream") : send(res, 404, { error: "not found" });
    }
    if (url.pathname.startsWith("/api/")) return send(res, 404, { error: "not found" });

    // Static app with single-page fallback.
    const safe = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
    let file = join(DIST, safe);
    const isFile = (f) => { try { return statSync(f).isFile(); } catch { return false; } };
    // Anything that is not a real file inside the build (folders, missing paths, escapes) gets the app shell.
    if (!file.startsWith(DIST + sep) || !isFile(file)) file = join(DIST, "index.html");
    if (!existsSync(file)) return send(res, 503, "The app is not built yet: run npm run build.", "text/plain; charset=utf-8");
    return sendStatic(req, res, file);
  } catch (err) {
    console.error(url.pathname, err.message);
    // Internal details stay in the log; the page gets a plain message.
    return send(res, 502, { error: "Could not read the chain right now. Try again shortly." });
  }
});

server.listen(PORT, () => {
  console.log(`Quorate read-only server on http://localhost:${PORT}`);
  // Warm the cache so the first visitor does not wait for a cold chain read.
  cached("quorum", 15000, quorum).catch((e) => console.error("warm-up failed:", e.message));
});
