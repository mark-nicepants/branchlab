# Changelog

All notable changes to BranchLab are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Run & preview (phase 1, local): run your app inside a workspace's worktree
  and see it without leaving BranchLab. Projects get a type (**web** or
  **flutter**) plus user-defined **run / setup / teardown** scripts
  (Project Settings → Run & preview) — setup fires once per fresh worktree,
  teardown runs (30s cap) before a worktree is removed. A new panel in the
  session view starts/stops the dev server, streams its output, discovers
  the ports it binds (`lsof` + process-tree attribution — works even when
  the script ignores `$BL_PORT`), and for web projects embeds a live
  preview of the running app with an address bar (Enter navigates; paths
  stay on the discovered port, full URLs pass through), a configurable
  start path for apps whose homepage redirects, and reload /
  open-in-browser. Scripts also receive `$BL_WORKSPACE_ID`, a stable key
  for per-worktree resources such as database names. Flutter
  projects run on the local device/emulator. Run processes are killed as a
  process group with the workspace and on app exit. Architecture and the
  VPS/remote + headless-Android roadmap: docs/design/run-preview.md.

- Flutter on redroid (**flutter-redroid** project type): BranchLab boots an
  Android-in-container (redroid) instance per workspace — Docker preferred,
  Apple's `container` CLI as fallback — waits for boot over adb, hands the
  run script `$ANDROID_SERIAL`, and previews the Android screen in-app
  (screencap stream, click-to-tap). Containers stay warm across run
  stop/start, stop on app exit, and are removed with the workspace. This is
  the local half of the planned VPS preview stack. Note: on macOS this
  currently requires Docker in a Linux VM — Docker Desktop kernels lack
  binder, and Apple `container` is blocked by an upstream bug
  (apple/container#1737); details in docs/design/run-preview.md.

## [0.2.0] - 2026-07-05

### Added

- Quick chats: context-free conversations with the agent — no project, no
  worktree, no git. Each quick chat gets an app-managed scratch directory
  with its own OpenCode server, full tool access, and an AI-generated title
  from the first message. They persist across restarts (chat history
  included) until deleted; deleting one also removes its scratch directory.
  Start one from the sidebar's Quick chats group.

- Redesigned Home composer: the destination now lives inside the message box
  — a project · branch chip pair, plus an always-visible "Quick chat" toggle
  (⌘K flips it) that fades the project out and routes the prompt to a fresh
  quick chat. The prompt typed on Home is delivered to the agent as the
  session's first message.

- AI branch naming: a new session's codename branch (e.g. `bubbly-cheetah`)
  is renamed to a conventional name proposed by the model from your first
  message (e.g. `feature/dark-mode-toggle`) — skipped for PR checkouts,
  branches already pushed to origin, and name collisions.

- Live branch tracking: when the agent renames or switches the branch inside
  a workspace, the sidebar and session header update within a second, the
  registry stays in sync, and merge/push/PR operate on the real branch.

- Redesigned AI chat transcript: every agent step collapses to one line with
  a fixed grammar (status · icon · verb · object · outcome) and expands in
  place to a custom view per kind — terminal output for commands, diffs for
  edits, results for searches, markdown for thoughts and subagents — with
  per-step and per-turn durations. The work section is open by default and
  carries a summary header (commands run, +added −removed, duration).
- Permission requests now appear inline under the tool call that asked,
  as a highlighted card, instead of floating at the bottom of the chat.

- Update availability now shows everywhere it matters: a badge on the
  settings gear, and an update banner with an "Update & restart" button at
  the top of Settings → General.
- The "Automatically check for updates" toggle is now functional — switch it
  off to stop the app from polling the release feed.

### Changed

- Quick chat rows in the sidebar now use the same design and menus as
  workspace rows, including right-click actions and "Open in
  terminal/Finder/IDE" (quick chats live in a real directory on disk).

- Uniform message design: user messages sit right, agent turns left (both
  capped at 80% width), system notices are centered pills, and structured
  cards (review feedback, the agent's work section) share one base component
  with matching header/body/footer bands.
- Thoughts render as markdown, and todo-list updates no longer appear in the
  transcript (they live in the strip above the composer).

- The update toast is now compact: a one-line notice instead of the full
  release notes (read them anytime in Settings → General or the changelog).

- New macOS app icon (rounded-square glyph artwork) across the bundle, dock,
  in-app favicon, and the website.

### Fixed

- The init prompt entered when creating a workspace (New Workspace modal, and
  now the Home composer) was stored but never sent to the agent; it is now
  delivered as the first message once the chat is ready, exactly once — an
  undelivered prompt survives for the next open instead of being lost.
- Auto-sent first messages could leave the transcript blank until the session
  was reopened (the send raced the chat event listeners still attaching);
  programmatic sends now wait for the listeners.

### Security

- Patched `quinn-proto` (QUIC, via the HTTP client stack) to 0.11.16 for
  RUSTSEC-2026-0185 — remote memory exhaustion through unbounded out-of-order
  stream reassembly.

## [0.1.1] - 2026-07-04

### Added

- Anonymous usage telemetry (self-hosted Umami): screen views and coarse
  feature counts (session created, PR created, autofix runs) — never code,
  paths, prompts, or anything identifying. Opt out anytime in
  Settings → General → "Share anonymous usage data".
- Centralized in-app routing: every screen change flows through one router,
  which also powers the telemetry pageviews.

### Fixed

- Review comments could be sent to the agent twice; batched review feedback
  now sends exactly once.

## [0.1.0] - 2026-07-04

### Added

- Auto-update support: the app checks the release endpoint on launch (and every
  4 hours) and shows a toast with release notes and a one-click
  "Update & restart" action.
- DMG bundle target for macOS distribution, plus a release script
  (`scripts/release.sh`) that builds a signed universal DMG + updater artifacts
  and generates `latest.json`.

### Changed

- New app icon and logo glyph across the macOS bundle, the in-app sidebar, and
  the favicon.
