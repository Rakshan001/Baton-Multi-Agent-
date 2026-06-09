import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dashboard dev server. `/api` is proxied to the local `baton serve` daemon
// (default 127.0.0.1:7077) so the app is same-origin in dev — no CORS needed.
// In production the built static assets are served by `baton serve` itself,
// so VITE_BATON_API is empty (same-origin) there too.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.VITE_BATON_API || "http://localhost:7077",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  test: {
    environment: "jsdom",
    globals: true,
  },
});
