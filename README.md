# BranchLab

A desktop app for driving [OpenCode](https://opencode.ai) across many isolated
workspaces at once. BranchLab creates a git **worktree** per task, runs an
OpenCode server in each, and gives you one window to chat with the agent,
review its diffs, browse files, and manage config — without juggling terminals
or stepping on your main checkout.

> Status: early MVP. macOS-only for now (the "open in editor/terminal/Finder"
> integrations shell out to `open`). Windows/Linux support is a planned
> portability pass.

## How it works

```
┌──────────┐      Tauri IPC       ┌─────────────────────┐     spawns      ┌──────────────┐
│  React   │ ───────────────────► │   Rust backend      │ ──────────────► │  opencode    │
│  (UI)    │ ◄─────────────────── │ (registry, git,     │                 │  server(s)   │
└──────────┘                      │  servers, config)   │ ◄───────────────┴──────────────┘
     │                            └─────────────────────┘   HTTP + SSE (from the UI directly)
     └── talks to each workspace's opencode server over HTTP/SSE for chat
```

- The **Rust backend** owns all filesystem, git, and process work, and persists
  a project/workspace registry. Every operation is a typed Tauri command.
- The **React frontend** renders the UI and talks to each workspace's OpenCode
  server directly over HTTP + Server-Sent Events for chat and live updates.
- Each **workspace** is a git worktree stored under the app data dir, with its
  own on-demand OpenCode server (idle servers are reaped automatically).

## Features

- **Projects & workspaces** — add a git repo, spin up worktree-backed
  workspaces off any branch.
- **Agent chat** — streaming OpenCode chat per workspace, with model selection
  and context-window tracking.
- **Changes view** — live unified/split diffs of the working tree, with
  per-file discard and "mark viewed".
- **File browser & viewer** — a file tree per workspace plus a read-only,
  line-numbered in-app file viewer (handles binary and oversized files).
- **Config panel** — view and edit global/project OpenCode config and restart
  the server to apply it.
- **Fleet dashboard** — an overview of every workspace and its diff stats.

## Prerequisites

BranchLab drives tools you install yourself (it does not bundle them):

- [`opencode`](https://opencode.ai) on your `PATH`
- `git`
- [Node.js](https://nodejs.org) 20.19+ (or 22.12+) and [Rust](https://rustup.rs)
  for development

On launch BranchLab probes for `opencode` and `git`; if either is missing it
shows an onboarding screen instead of the app.

## Development

```bash
npm install          # install frontend deps
npm run tauri dev    # run the desktop app with hot reload
```

Other commands:

```bash
npm run build        # type-check (tsc) + production frontend build
npm test             # run frontend unit tests (Vitest)
npm run test:watch   # Vitest in watch mode

cd src-tauri && cargo test    # run Rust unit tests
cd src-tauri && cargo build   # build the backend
```

## Project layout

```
src/                     React frontend
  components/            UI (Chat, Sidebar, WorkspaceView, center/, layout/, ui/)
  hooks/                 keyboard shortcuts, native desktop behaviors
  lib/                   api.ts (IPC wrappers), opencode.ts (HTTP client),
                         types.ts, diff.ts, themes.ts
src-tauri/src/           Rust backend
  commands.rs            Tauri IPC command surface
  project.rs             project/workspace registry (JSON persisted)
  server.rs              OpenCode server lifecycle + idle reaper
  git.rs                 git CLI wrappers (worktrees, diff, file read)
  config.rs              OpenCode config read/write
  env.rs                 PATH probe for opencode/git
```

See [AGENTS.md](AGENTS.md) for conventions and a guide to extending the
codebase.
