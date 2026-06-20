// vite.config.ts — dev/build config for the control-tower frontend (SADD §2.1).
// Single responsibility: configure Vite for both browser dev (mock mode) and the
// Tauri webview build. Relative base so the bundle loads from Tauri's asset
// protocol; fixed port 1420 per Tauri convention; clearScreen off so Cargo/Tauri
// logs remain visible when run under `tauri dev`.
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  clearScreen: false,
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2021",
  },
  server: {
    port: 1420,
    strictPort: true,
  },
});
