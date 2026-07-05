# Changelog

All notable changes to BranchLab are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Quick chats: context-free conversations with the agent — no project, no
  worktree, no git. Each quick chat gets an app-managed scratch directory
  with its own OpenCode server, full tool access, and an AI-generated title
  from the first message. They persist across restarts (chat history
  included) until deleted; deleting one also removes its scratch directory.
  Start one from the sidebar's Quick chats group.

- Update availability now shows everywhere it matters: a badge on the
  settings gear, and an update banner with an "Update & restart" button at
  the top of Settings → General.
- The "Automatically check for updates" toggle is now functional — switch it
  off to stop the app from polling the release feed.

### Changed

- Quick chat rows in the sidebar now use the same design and menus as
  workspace rows, including right-click actions and "Open in
  terminal/Finder/IDE" (quick chats live in a real directory on disk).

- The update toast is now compact: a one-line notice instead of the full
  release notes (read them anytime in Settings → General or the changelog).

- New macOS app icon (rounded-square glyph artwork) across the bundle, dock,
  in-app favicon, and the website.

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
