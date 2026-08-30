import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vitest/config";

const src = path.resolve(__dirname, "./src");

// Two projects:
//
//   unit    — `src/**/*.test.ts` in plain Node (no Tauri runtime, no DOM).
//             This is where nearly everything lives: pure logic in src/lib.
//   harness — `src/**/*.test.tsx` in jsdom against the browser dev harness
//             (`dev:browser`). It mirrors vite.config.ts's `mode === "browser"`
//             aliasing so components run on api.mock/events.mock and a test can
//             drive a real backend event timeline with `mockEmit`.
//
// The harness project is deliberately tiny. The mocks are a debugging aid, not
// a contract — growing a broad component suite on them would turn their canned
// timelines into a second thing to keep in sync.
export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias: { "@": src } },
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        plugins: [react()],
        resolve: {
          alias: [
            { find: "@", replacement: src },
            {
              find: /^(\.\.\/)*(\.\/)?lib\/api$/,
              replacement: path.resolve(src, "./lib/api.mock.ts"),
            },
            {
              find: /^(\.\.\/)*(\.\/)?lib\/events$/,
              replacement: path.resolve(src, "./lib/events.mock.ts"),
            },
          ],
        },
        test: {
          name: "harness",
          environment: "jsdom",
          include: ["src/**/*.test.tsx"],
        },
      },
    ],
  },
});
