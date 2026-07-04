#!/usr/bin/env bash
# BranchLab release tooling. Two modes:
#
#   release.sh <version> [--notes "..."]   PREPARE (run locally)
#     Rolls CHANGELOG.md ([Unreleased] -> [<version>] - <date>) and bumps the
#     version in package.json / tauri.conf.json / Cargo.toml. Commit, tag
#     v<version>, and push — the tag triggers .github/workflows/release.yml,
#     which runs the build and deploys to branchlab.dev/releases/.
#
#   release.sh --build                      BUILD (run by CI, or locally)
#     Builds the universal .app + DMG + signed updater artifacts for the
#     version already in tauri.conf.json, and stages everything the website
#     serves into dist-release/ (DMG, latest-DMG alias, .app.tar.gz,
#     latest.json, notes.md).
#
# Build env:
#   TAURI_SIGNING_PRIVATE_KEY  Updater signing key: key content or a path to
#     it (Tauri v2 has no _PATH variant). Defaults to ~/.tauri/branchlab.key.
#   APPLE_SIGNING_IDENTITY + APPLE_API_* for signing/notarization (optional;
#     without them the build is unsigned — Gatekeeper warns real users).
set -euo pipefail

cd "$(dirname "$0")/.."

BASE_URL="${RELEASE_BASE_URL:-https://branchlab.dev/releases}"

# ── helpers ──────────────────────────────────────────────────────────────

# Print the body of a "## [<heading>]" CHANGELOG section.
changelog_section() {
  HEADING="$1" node -e '
    const text = require("fs").readFileSync("CHANGELOG.md", "utf8");
    const h = process.env.HEADING.replace(/\./g, "\\.");
    const m = text.match(new RegExp(`^## \\[${h}\\][^\n]*\n([\\s\\S]*?)(?=^## \\[|(?![\\s\\S]))`, "m"));
    if (m) process.stdout.write(m[1].trim());
  '
}

# ── BUILD mode (CI) ──────────────────────────────────────────────────────

if [[ "${1:-}" == "--build" ]]; then
  VERSION=$(node -p 'require("./src-tauri/tauri.conf.json").version')
  NOTES=$(changelog_section "$VERSION")
  if [[ -z "$NOTES" ]]; then
    echo "ERROR: CHANGELOG.md has no [$VERSION] section — run 'release.sh $VERSION' (prepare) first." >&2
    exit 1
  fi

  if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
    export TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/branchlab.key"
    echo "==> Using default updater key: $TAURI_SIGNING_PRIVATE_KEY"
  fi
  # Key was generated with an empty password; the variable must still exist
  # or the CLI prompts interactively.
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
  if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
    echo "WARNING: APPLE_SIGNING_IDENTITY not set — build will be unsigned/un-notarized."
  fi

  echo "==> Ensuring both mac targets are installed (universal build)"
  rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null

  BUNDLE_DIR="src-tauri/target/universal-apple-darwin/release/bundle"
  DMG_NAME="BranchLab_${VERSION}_universal.dmg"
  TAR_NAME="BranchLab_${VERSION}_universal.app.tar.gz"

  echo "==> Building universal app + DMG ($VERSION, this takes a while)"
  # `|| true`: on some macOS setups `hdiutil convert` inside bundle_dmg.sh
  # fails with "Resource temporarily unavailable" AFTER the .app and updater
  # artifacts are done; the fallback below rebuilds the DMG another way.
  npm run tauri build -- --target universal-apple-darwin || true

  TARBALL="$BUNDLE_DIR/macos/BranchLab.app.tar.gz"
  [[ -f "$TARBALL" && -f "$TARBALL.sig" ]] || {
    echo "ERROR: updater artifacts missing — the build itself failed." >&2
    exit 1
  }

  if [[ ! -f "$BUNDLE_DIR/dmg/$DMG_NAME" ]]; then
    echo "==> DMG bundling failed (hdiutil convert quirk) — building DMG via hdiutil create"
    STAGE=$(mktemp -d)
    # Prefer the styled rw image create-dmg left behind (Finder layout, volume
    # icon); fall back to a plain staging folder.
    RW=$(ls "$BUNDLE_DIR"/macos/rw.*.dmg 2>/dev/null | tail -1 || true)
    if [[ -n "$RW" ]]; then
      MNT=$(mktemp -d)
      hdiutil attach "$RW" -nobrowse -noautoopen -mountpoint "$MNT" >/dev/null
      rm -rf "$MNT/BranchLab.app"
      ditto "$BUNDLE_DIR/macos/BranchLab.app" "$MNT/BranchLab.app"
      hdiutil create -volname BranchLab -srcfolder "$MNT" -format UDZO -fs HFS+ -ov \
        "$BUNDLE_DIR/dmg/$DMG_NAME" >/dev/null
      hdiutil detach "$MNT" >/dev/null
    else
      ditto "$BUNDLE_DIR/macos/BranchLab.app" "$STAGE/BranchLab.app"
      ln -s /Applications "$STAGE/Applications"
      hdiutil create -volname BranchLab -srcfolder "$STAGE" -format UDZO -fs HFS+ -ov \
        "$BUNDLE_DIR/dmg/$DMG_NAME" >/dev/null
    fi
    rm -rf "$STAGE"
    rm -f "$BUNDLE_DIR"/macos/rw.*.dmg
  fi

  echo "==> Staging dist-release/"
  OUT="dist-release"
  rm -rf "$OUT" && mkdir -p "$OUT"
  cp "$BUNDLE_DIR/dmg/$DMG_NAME" "$OUT/$DMG_NAME"
  # Stable name the website's Download button links to.
  cp "$BUNDLE_DIR/dmg/$DMG_NAME" "$OUT/BranchLab_latest_universal.dmg"
  cp "$TARBALL" "$OUT/$TAR_NAME"
  printf '%s\n' "$NOTES" > "$OUT/notes.md"

  echo "==> Writing latest.json"
  SIGNATURE=$(cat "$TARBALL.sig") VERSION="$VERSION" NOTES="$NOTES" BASE_URL="$BASE_URL" TAR_NAME="$TAR_NAME" \
  node -e '
    const { SIGNATURE, VERSION, NOTES, BASE_URL, TAR_NAME } = process.env;
    const entry = { signature: SIGNATURE, url: `${BASE_URL}/${TAR_NAME}` };
    const manifest = {
      version: VERSION,
      notes: NOTES,
      pub_date: new Date().toISOString(),
      platforms: { "darwin-aarch64": entry, "darwin-x86_64": entry },
    };
    require("fs").writeFileSync("dist-release/latest.json", JSON.stringify(manifest, null, 2) + "\n");
  '

  echo && echo "Done:" && ls -lh "$OUT"
  exit 0
fi

# ── PREPARE mode (local) ─────────────────────────────────────────────────

VERSION="${1:?usage: release.sh <version> [--notes \"...\"] | release.sh --build}"
NOTES=""
if [[ "${2:-}" == "--notes" ]]; then
  NOTES="${3:?--notes requires a value}"
fi

if [[ -z "$NOTES" ]]; then
  echo "==> Rolling over CHANGELOG.md [Unreleased] -> [$VERSION]"
  # Idempotent: skip if this version's section already exists.
  if [[ -z "$(changelog_section "$VERSION")" ]]; then
    if [[ -z "$(changelog_section "Unreleased")" ]]; then
      echo "ERROR: CHANGELOG.md [Unreleased] is empty — document the release first." >&2
      exit 1
    fi
    VERSION="$VERSION" DATE="$(date -u +%Y-%m-%d)" node -e '
      const fs = require("fs");
      const { VERSION, DATE } = process.env;
      let text = fs.readFileSync("CHANGELOG.md", "utf8");
      text = text.replace(/^## \[Unreleased\][^\n]*$/m, `## [Unreleased]\n\n## [${VERSION}] - ${DATE}`);
      fs.writeFileSync("CHANGELOG.md", text);
    '
  fi
else
  echo "==> Inserting provided notes as the [$VERSION] changelog section"
  VERSION="$VERSION" DATE="$(date -u +%Y-%m-%d)" NOTES="$NOTES" node -e '
    const fs = require("fs");
    const { VERSION, DATE, NOTES } = process.env;
    let text = fs.readFileSync("CHANGELOG.md", "utf8");
    if (!text.includes(`## [${VERSION}]`)) {
      text = text.replace(/^## \[Unreleased\][^\n]*$/m, `## [Unreleased]\n\n## [${VERSION}] - ${DATE}\n\n${NOTES}`);
      fs.writeFileSync("CHANGELOG.md", text);
    }
  '
fi

echo "==> Bumping version to $VERSION"
npm pkg set version="$VERSION"
node -e '
  const fs = require("fs");
  const p = "src-tauri/tauri.conf.json";
  const c = JSON.parse(fs.readFileSync(p, "utf8"));
  c.version = process.argv[1];
  fs.writeFileSync(p, JSON.stringify(c, null, 2) + "\n");
' "$VERSION"
perl -0pi -e "s/^version = \"[^\"]+\"/version = \"$VERSION\"/m" src-tauri/Cargo.toml
# Keep Cargo.lock's own entry in sync so CI's --locked builds don't drift.
(cd src-tauri && cargo update -p branchlab --precise "$VERSION" 2>/dev/null || cargo generate-lockfile >/dev/null 2>&1 || true)

echo
echo "Prepared. Now ship it:"
echo "  git add -A && git commit -m \"release: v$VERSION\""
echo "  git tag v$VERSION && git push && git push --tags"
echo "The v$VERSION tag triggers the Release workflow (build + deploy)."
