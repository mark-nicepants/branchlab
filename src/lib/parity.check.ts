// Compile-time mock-parity guard (no runtime — nothing imports this module;
// it exists to be type-checked by `tsc` in `npm run build`).
//
// The browser harness swaps `./api` → `./api.mock` and `./events` →
// `./events.mock` (vite.config.ts), so each mock must keep at least the real
// module's export surface. Assigning the mock's module type to the real one
// fails tsc the moment a mock export goes missing or its signature drifts;
// extra mock-only exports (events.mock's `mockEmit`) are allowed.

export const apiParity: typeof import("./api") =
  null as unknown as typeof import("./api.mock");

export const eventsParity: typeof import("./events") =
  null as unknown as typeof import("./events.mock");
