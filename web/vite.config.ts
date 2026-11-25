import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, the API runs on :8000 (uvicorn) and Vite proxies /api to it.
export default defineConfig({
  plugins: [react()],
  // fs.allow: the documentation page imports ../docs/METHODOLOGIE.md
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:8000" }, fs: { allow: [".."] } },
  build: { outDir: "dist", chunkSizeWarningLimit: 1500 },
});
