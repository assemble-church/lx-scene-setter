import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// In dev the Vite server proxies API + WebSocket calls to the engine (port 8080).
// In production the engine serves the built static files from ui/dist directly.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    proxy: {
      "/api": "http://localhost:8080",
      "/ws": { target: "ws://localhost:8080", ws: true },
    },
  },
  build: { outDir: "dist" },
});
