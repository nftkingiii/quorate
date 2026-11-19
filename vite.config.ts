import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// The app lives in web/; the read-only server (server/index.mjs) answers /api
// and /advisories. In development Vite proxies those to it.
//
// The project folder also holds testnet keys (.keys/), receipts and internal
// notes. The dev server may only read web/ and node_modules/, refuses those
// paths outright, listens on this machine only, and rejects cross-site
// requests (Vite 6.4.4 or later; see the Dependabot alerts of 19 November 2026).
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  server: {
    host: "localhost",
    port: 5173,
    strictPort: true,
    cors: false,
    fs: {
      strict: true,
      allow: [here("./web"), here("./node_modules")],
      deny: [".env", ".env.*", "*.{crt,pem,key}", "**/.keys/**", "**/.git/**", "**/receipts/**", "**/PROJECT_STATE.md", "**/HACK_EVENT_GATE.json"],
    },
    proxy: {
      "/api": "http://localhost:8787",
      "/advisories": "http://localhost:8787",
      // Development only, for the QoreX wallet mock: the mock runs inside the
      // page, so its testnet REST calls need a same-origin path. The real QoreX
      // extension calls the chain itself. Never part of the production server.
      "/qore-rest": {
        target: "https://api-testnet.qore.host",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/qore-rest/, ""),
      },
    },
  },
  preview: { host: "localhost", cors: false },
});
