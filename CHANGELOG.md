# Changelog

All notable changes to BranchLab are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
