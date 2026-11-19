import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The app lives in web/; the read-only server (server/index.mjs) answers /api
// and /advisories. In development Vite proxies those to it.
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  server: {
    port: 5173,
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
});
