# Redesign — open ends

The GitHub Copilot–style redesign wires up every feature BranchLab already has and
renders the rest as **disabled / stubbed** controls (greyed, with tooltips) so the
layout stays faithful to the reference. This file tracks what still needs backend or
follow-up work. Nothing here blocks the current UI from shipping.

## New backend dependency

- **Quick chat scratch dir** — `createQuickChat()` in `src/lib/api.ts` invokes the Rust
  command `create_quick_chat`, which **does not exist yet**. It should create/serve an
  app-managed _empty_ directory (no git repo, no worktree) and return a `Workspace` with
  `kind: "QuickChat"`, analogous to `create_workspace` in `src-tauri/src/project.rs`.
  The frontend + browser mock (`src/lib/api.mock.ts`) already implement the flow, and the
  session view hides all git affordances for quick chats. Quick chats are currently held
  in memory only (`App.tsx` `quickChats` state) — persistence is a follow-up.

## Disabled nav / sidebar entries (no backend)

- **My work** and **Automations** nav-rail items — greyed, "coming soon".
- **New session ▸ From pull request** (per-project menu) — needs PR checkout.
- **Add project from ▸ GitHub repository…** and **Repository URL…** — need a clone step
  before `add_project`.
- **Resume remote session…** — no remote-session concept exists.

## Home screen

- **"Up next" feed** — renders the empty "You're all caught up" state. A real feed needs a
  GitHub PR/issue integration (auth + API); no backend today.
- **Composer mode/model pills ("Interactive" / "Auto")** — display-only on Home. The live
  mode (`build`/`plan`) and model selectors run _inside_ the session composer. If exact
  "Interactive/Autopilot" wording is wanted, decide how it maps to opencode agents and
  thread an initial agent through `createWorkspace` → `Chat`.
- **Attach (+) button** — disabled on Home; image attach lives in the session composer.

## Settings screen

Functional today: **General** (Open-in terminal/editor pickers), **Themes**, **Projects**.

Per-session concerns are **not** in global settings — they belong to a workspace's server:

- **MCP servers / LSP / plugins** live in the **Config** tab of the session's side panel
  (`session/ServerToolsPanel.tsx`), with a Restart-server action. MCP servers toggle
  connect/disconnect live.
- The **opencode config editor** (`center/ConfigView.tsx` — edit project/global `opencode.json`,
  effective config, agents, commands) lives **only** in Project Settings ▸ OpenCode config.

A _global_ MCP/model registry (managing servers without an open session) does not exist yet.

Stubbed / disabled in global settings:

- **General**: "Automatically check for updates", "Show in menu bar",
  "Delete chats without confirmation" toggles are inert (no updater / menu-bar / delete-chat
  backend). Storage location is a read-only display — there is no `get/set_storage_location`
  command yet (the real dir is chosen in `src-tauri`).
- **Accounts, Sessions, Accessibility, Skills, Experimental** — placeholder panes.
- **Model providers** tab was removed from global settings (it required an active server and
  duplicated the in-composer model selector). Effective config / agents / commands are viewable
  per session in the Config tab. `prefs.disabledModels` (`PreferencesProvider`) could drive
  per-model enable/disable toggles somewhere later.

## Session view

- Server restart lives in the Config tab's tools panel ("Restart server") — the standalone
  "Run" button was removed, and the header no longer carries a server-status popover.
- Git actions (Commit / Merge / Push / Open PR) remain **AI-prompt-driven** via `CommitButton`
  → `Chat` (the live path). The direct Rust commands (`commit_workspace`, `merge_workspace`,
  `push_workspace`, `create_workspace_pr`) are still available if a deterministic path is
  preferred later.
- **Extend with MCP servers** card on Home is informational now (button disabled, "managed per
  session") since MCP is per-workspace.

## Browser harness note

`npm run dev:browser` now mocks **both** the Tauri IPC layer (`api.mock.ts`) and the OpenCode
HTTP client (`opencode.mock.ts`, aliased in `vite.config.ts`) so the full session/chat view
renders without a live server. The mock conversation is static (no live SSE stream).

## Branding

The Home brand mark is now an inline, theme-aware SVG (`src/components/Logo.tsx`, stroke
`currentColor` → white on dark themes, near-black on light). The raster `public/app-icon.png`
is still used for the window/account icon.

## Retired components

`Titlebar`, `StatusBar`, `FleetDashboard`, `SettingsDialog`, `Sidebar`, `WorkspaceView`, and
`OpencodeStatus` were removed; their behavior now lives in `shell/`, `home/`, `session/`, and
`settings/`. `ChangesPanel`, `center/*`, `Chat`, `CommitButton`, `NewWorkspaceModal`,
`ProjectSettingsDialog`, and the composer selectors are reused as-is.
