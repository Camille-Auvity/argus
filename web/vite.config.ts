import { copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages serves 404.html for unknown paths: make it the app so deep links work.
const spaFallback = (): Plugin => ({
  name: "spa-404-fallback",
  closeBundle() {
    const dist = resolve(__dirname, "dist");
    copyFileSync(resolve(dist, "index.html"), resolve(dist, "404.html"));
  },
});

// Two builds:
// * default: served by FastAPI (python run.py), API on the same origin;
// * static (VITE_STATIC=1, VITE_BASE=/argus/): GitHub Pages, the API runs in the browser (Pyodide).
export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
  plugins: [react(), ...(process.env.VITE_STATIC === "1" ? [spaFallback()] : [])],
  // In dev, the API runs on :8000 (uvicorn) and Vite proxies /api to it.
  // fs.allow: the documentation page imports ../docs/METHODOLOGIE.md
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:8000" }, fs: { allow: [".."] } },
  worker: { format: "es" },
  build: { outDir: "dist", chunkSizeWarningLimit: 1500 },
});
