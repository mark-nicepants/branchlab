import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => ({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // In browser debug mode, swap the Tauri IPC API and the OpenCode HTTP
      // client for their mock implementations. Aliases match the exact import
      // specifier, so every relative form used across the tree is listed.
      ...(mode === "browser" && {
        "./lib/api": path.resolve(__dirname, "./src/lib/api.mock.ts"),
        "../lib/api": path.resolve(__dirname, "./src/lib/api.mock.ts"),
        "../../lib/api": path.resolve(__dirname, "./src/lib/api.mock.ts"),
        "../lib/opencode": path.resolve(__dirname, "./src/lib/opencode.mock.ts"),
        "../../lib/opencode": path.resolve(__dirname, "./src/lib/opencode.mock.ts"),
      }),
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    // Bind IPv4 explicitly. With `false`, Node >=17 resolves `localhost` to
    // `::1` and Vite listens IPv6-only, but macOS WKWebView loads devUrl over
    // IPv4 (127.0.0.1) first -> connection refused -> blank/hanging window.
    host: host || "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
