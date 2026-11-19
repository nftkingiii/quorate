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
    },
  },
});
