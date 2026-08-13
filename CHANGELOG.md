# Changelog

All notable changes to BranchLab are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Per-project setup and teardown scripts (Project settings → Scripts): the
  setup script runs once in every fresh workspace before the first prompt,
  with live progress shown as a step card in the chat (and a "Retry setup"
  button on failure); the teardown script runs before a workspace is deleted.
- New workspaces open instantly — provisioning continues in the background,
  with a spinner in the sidebar while a workspace is setting up or being
  deleted, and a warning icon when setup failed.

### Fixed

- Deleting a workspace whose worktree directory was removed or broken outside
  the app (git's "is not a working tree" error) now succeeds instead of
  failing — including via "Delete anyway".
- The delete-workspace error toast shows a short message instead of raw git
  output, and "Delete anyway" reports its own failures cleanly.

### Changed

- The app window now appears ~340ms after launch with the full UI (sidebar,
  home, review inbox) instead of ~5s of nothing. The login-shell PATH probe is
  cached between launches, the window is revealed on the first rendered frame
  rather than a stuck animation-frame wait, the environment check no longer
  blocks the shell, and startup git work moved off the UI thread.

### Removed

- The "Default model" field in project settings — it was never applied to new
  sessions. Model choice is remembered per workspace and via the global
  default, as before.

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
