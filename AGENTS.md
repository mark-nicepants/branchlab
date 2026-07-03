# AGENTS.md

Guidance for AI coding agents and human contributors working in this repo.
Keep changes small, typed, and consistent with what's already here.

## What this is

BranchLab is a Tauri 2 desktop app (React 19 + TypeScript frontend, Rust
backend) that drives the `opencode` CLI across git-worktree workspaces. See
[README.md](README.md) for the user-facing overview and architecture diagram.

## Browser-only visual debugging

When a change is purely visual (layout, colors, truncation, hover states,
etc.), you don't need a running Tauri backend. Use the browser dev harness:

```bash
npm run dev:browser
```

This serves the React frontend at `http://localhost:5173` with a mocked
Tauri backend (`src/lib/api.mock.ts`). The mock includes sample projects
with deliberately long names and realistic diff stats so truncation and
overflow bugs are easy to spot.

To inspect or validate the rendered UI, use the **Playwright MCP**
(`playwright-mcp`) pointed at `http://localhost:5173`. Take screenshots,
measure element boxes, and verify text-overflow behavior without launching
the desktop app.

How the harness works:

- `index.browser.html` loads `src/main.browser.tsx` instead of `src/main.tsx`.
- `main.browser.tsx` stubs `window.__TAURI_INTERNALS__` and renders `<App />`
  with the same providers.
- `vite.config.ts` aliases `./lib/api` to `./src/lib/api.mock.ts` when
  `mode === "browser"`, so every component uses mock data.

Limitations: filesystem/git/server lifecycle flows still require
`npm run tauri dev`. The browser harness is for UI/visual verification only.

## Commands

```bash
npm install                   # install frontend deps
npm run tauri dev             # run the app (hot reload)
npm run dev:browser           # run the frontend in a browser with mocked backend
npm run build                 # tsc type-check + vite production build
npm test                      # frontend unit tests (Vitest, run once)
npm run test:watch            # Vitest watch mode
cd src-tauri && cargo test --lib   # Rust unit tests
cd src-tauri && cargo build        # backend build
```

### Checks the CI runs

`.github/workflows/ci.yml` gates every push/PR. Run the same checks locally
before pushing — they must all pass:

```bash
# Frontend
npm run build                 # tsc strict type-check + vite build (our JS/TS lint gate)
npm test

# Rust (from src-tauri/)
cargo fmt --all --check       # formatting (config in src-tauri/rustfmt.toml)
cargo clippy --all-targets -- -D warnings
cargo test --lib

# Dependency security audits
npm audit --audit-level=high
cargo audit                   # from src-tauri/; needs `cargo install cargo-audit`
```

There is no ESLint/Prettier yet — TypeScript `strict` (incl.
`noUnusedLocals`/`noUnusedParameters`) is the frontend lint gate. Rust style is
enforced by `rustfmt` (`max_width = 120`, compact heuristics); run `cargo fmt`
before committing.

## Architecture & boundaries

- **All filesystem / git / process work lives in Rust.** The frontend never
  touches the disk directly; it goes through Tauri commands.
- **The frontend does NO polling and NO orchestration.** It is view logic only.
  Anything periodic, stateful, or cross-workspace (git status, PR/CI monitoring,
  autofix, session state, notifications) lives in the Rust backend, which
  **pushes** state to the UI via Tauri events. Never add a `setInterval` that
  polls a Tauri command — watch/observe in Rust and emit instead.
- **`src/lib/api.ts` is the only place that calls `invoke`.** Every backend
  command gets a typed wrapper here so no raw command-name strings leak into
  components. Add new wrappers there, not inline.
- **`src/lib/events.ts` is the only place that calls `listen`.** It is the event
  analogue of `api.ts`: every backend→frontend event gets a typed wrapper here.
  Components/hooks subscribe through it, never with a raw event-name string.
- **The backend owns OpenCode.** The supervisor (`supervisor.rs`) consumes each
  server's SSE for coarse state and sends prompts via `src-tauri/src/opencode.rs`.
  The one thing the frontend still does directly is keep a `src/lib/opencode.ts`
  SSE connection to render the **active chat's live stream** — never to derive
  app state or trigger actions. Tauri manages server lifecycle (`server.rs`).
- **Session-driving logic runs for all enabled workspaces regardless of what's
  on screen.** Monitoring, PR autofix/superfix, and notification signals are
  backend background work in `supervisor.rs`, not tied to a mounted component.
- **Backend modules** are single-purpose: `git.rs` (git CLI), `project.rs`
  (registry), `server.rs` (process lifecycle), `opencode.rs` (OpenCode HTTP/SSE
  client), `watcher.rs` (filesystem watch → `workspace:git` events),
  `supervisor.rs` (SSE ingest + autofix loop → `workspace:{pr,session,todos,notify}`
  events), `config.rs` (opencode config), `env.rs` (PATH probe), `commands.rs`
  (the IPC surface). Put new logic in the matching module.

## Adding a Tauri command (the common task)

A backend capability reaches the UI through five touch points. Follow the
existing `read_file` / `workspace_files` commands as the template:

1. **Logic** in the relevant module (e.g. `git.rs`) — a plain function with a
   `Serialize` return type if it's structured.
2. **Command** in `src-tauri/src/commands.rs` — a thin `#[tauri::command]`
   wrapper that resolves the workspace/registry and calls the logic.
3. **Register** it in the `tauri::generate_handler![...]` list in
   `src-tauri/src/lib.rs`.
4. **Type** the return shape in `src/lib/types.ts` (mirror the Rust struct;
   field names are snake_case as serialized by serde).
5. **Wrapper** in `src/lib/api.ts` — a typed `invoke<T>(...)` function. Tauri
   converts camelCase JS args to snake_case Rust params automatically.

## Adding a backend→frontend event (pushing state)

Prefer this over any polling. State the backend computes/observes reaches the UI
as a Tauri event:

1. **Emit** in `watcher.rs` or `supervisor.rs`: `app.emit("workspace:foo", payload)`
   (needs `use tauri::Emitter;`). Emit **only on change** — compare against the
   last emitted payload to avoid flooding.
2. **Payload struct** in Rust: `#[derive(Serialize, Clone, PartialEq)]` with
   `#[serde(rename_all = "camelCase")]` so the TS side gets camelCase fields.
3. **Type** the payload in `src/lib/types.ts` (mirror the struct, camelCase).
4. **Wrapper** in `src/lib/events.ts` — an `onWorkspaceFoo(cb)` that calls
   `listen` and returns the unsubscribe function. Add a matching no-op/canned
   emitter to `src/lib/events.mock.ts` (and, if useful, drive it from
   `api.mock.ts`) so `dev:browser` still renders.
5. **Subscribe** in a hook/provider; call `resync()` once after attaching
   listeners if you need the current snapshot (events aren't buffered).

## Conventions

- **TypeScript:** function components with hooks; no class components, no global
  state library. Per-workspace UI state lives in `App.tsx` and is passed down.
  Use the `@/` import alias for `src/`. Use `cn()` (from `lib/utils`) for
  conditional classes.
- **Styling:** Tailwind v4 + shadcn/ui primitives in `components/ui/`. Match the
  existing token-based classes (`text-muted-foreground`, `border-border`,
  `bg-accent`, etc.) so theming works — don't hardcode colors.
- **Tab/panel pattern:** the center area (`WorkspaceView`) and right panel
  (`ChangesPanel`) are tab routers driven by a `CenterTab`/`Tab` union; extend
  the union and the render switch rather than adding parallel components.
- **Rust:** shell out to `git` (no libgit2). Use the `git()` helper for commands
  whose exit status matters, `git_out()` for ones where nonzero is normal
  (e.g. `diff --no-index`). Return `Result<_, String>` for fallible commands.
- **Comments** explain _why_, not _what_. Keep the existing density.

## Testing

- **Frontend:** Vitest. Tests are `src/**/*.test.ts`, colocated with the module.
  They run in plain Node (`environment: "node"`) with **no Tauri runtime** — so
  test pure logic (`lib/diff.ts`, `lib/types.ts`, parsers, formatters), not
  components that call `invoke`. Import `describe/it/expect` from `vitest`
  explicitly (no globals).
- **Rust:** `#[cfg(test)] mod tests` at the bottom of the module, using only
  `std` (no extra test crates). For filesystem tests, create a throwaway dir
  under `std::env::temp_dir()` and clean it up on `Drop` — see `git.rs` tests.

## Gotchas

- **macOS-only externals:** `open_external` in `commands.rs` shells out to
  `open`. Anything touching "open in editor/terminal/Finder" won't work on
  other platforms yet.
- **Path safety:** when reading workspace files, reject paths containing `..`
  (see `git::read_file`). Frontend-supplied paths come from `list_files` and are
  repo-relative, but validate defensively.
- **Registry & worktrees** live under the Tauri app data dir
  (`registry.json`, `worktrees/`), not in the project repo — deleting a project
  in the UI doesn't touch the user's actual repo beyond removing the worktree.
- **Servers are ephemeral:** spawned on demand and reaped after idle timeout;
  never assume a workspace's server is running — start/await health first
  (see `WorkspaceView`).
- **Node version:** Vite 8 / Vitest 4 require Node 20.19+ or 22.12+ (Node 18 is
  unsupported — the build/test commands will fail on it). If `node -v` shows 18,
  use a newer Node (e.g. Homebrew `node@22`) on your `PATH`.

## OpenCode API notes

- **Model reasoning effort** is exposed per-model in `/config/providers` as the
  `variants` object. Its keys (e.g. `low`, `medium`, `high`, `xhigh`, `max` for
  Claude Opus 4.8) are sent to `/session/{id}/prompt_async` as the top-level
  `variant` string. Omitting `variant` uses the model's default. Not all models
  expose variants; render the selector only when `variants.length > 0` and
  reset the selection when switching to a model that doesn't support it.
- **Agents / modes** are listed by `/agent` but are not the same as the model's
  reasoning effort. Avoid confusing the two in the UI.
- **Model keys** are stable as `${providerID}/${modelID}`; persist these, not
  display names, when remembering per-workspace settings.
