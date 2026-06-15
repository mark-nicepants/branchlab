import { defineConfig } from "vitest/config";
import path from "node:path";

// Unit tests run in plain Node (no Tauri runtime); we exercise the pure
// frontend logic in src/lib. The `@` alias mirrors vite.config.ts.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
