#!/usr/bin/env bash
# Build a signed, notarized, universal macOS release and stage everything the
# website needs (DMG for new users, .app.tar.gz + latest.json for the
# auto-updater) into dist-release/.
#
# Usage: ./scripts/release.sh 0.2.0 [--notes "Override release notes"]
#
# Release notes come from CHANGELOG.md: the `## [Unreleased]` section is
# renamed to `## [<version>] - <date>` (a fresh empty [Unreleased] is inserted
# above it) and its content becomes the `notes` field in latest.json — shown in
# the in-app update toast. `--notes` skips the changelog and uses the given
# text instead.
#
# Required env:
#   TAURI_SIGNING_PRIVATE_KEY_PATH  (or TAURI_SIGNING_PRIVATE_KEY)
#     Updater signing key, e.g. ~/.tauri/branchlab.key
# Required for notarization (Gatekeeper) once the Apple Developer ID exists:
#   APPLE_SIGNING_IDENTITY   e.g. "Developer ID Application: Name (TEAMID)"
#   APPLE_API_ISSUER / APPLE_API_KEY / APPLE_API_KEY_PATH
#     (or APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID)
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="${1:?usage: release.sh <version> [--notes \"...\"]}"
NOTES=""
if [[ "${2:-}" == "--notes" ]]; then
  NOTES="${3:?--notes requires a value}"
fi

# Where the updater fetches releases from. Must match plugins.updater.endpoints
# in src-tauri/tauri.conf.json.
BASE_URL="${RELEASE_BASE_URL:-https://branchlab.dev/releases}"

if [[ -z "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" && -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  export TAURI_SIGNING_PRIVATE_KEY_PATH="$HOME/.tauri/branchlab.key"
  echo "==> Using default updater key: $TAURI_SIGNING_PRIVATE_KEY_PATH"
fi
if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  echo "WARNING: APPLE_SIGNING_IDENTITY not set — build will be unsigned/un-notarized."
  echo "         Fine for local testing; downloads will hit Gatekeeper for real users."
fi

if [[ -z "$NOTES" ]]; then
  echo "==> Rolling over CHANGELOG.md [Unreleased] -> [$VERSION]"
  NOTES=$(VERSION="$VERSION" DATE="$(date -u +%Y-%m-%d)" node -e '
    const fs = require("fs");
    const { VERSION, DATE } = process.env;
    const path = "CHANGELOG.md";
    let text = fs.readFileSync(path, "utf8");

    // Body of a "## [heading]" section = everything up to the next "## [".
    const section = (heading) => {
      const m = text.match(new RegExp(`^## \\[${heading}\\][^\n]*\n([\\s\\S]*?)(?=^## \\[|(?![\\s\\S]))`, "m"));
      return m && m[1].trim();
    };

    // Idempotent re-run: this version was already rolled over.
    let notes = section(VERSION.replace(/\./g, "\\."));
    if (notes == null) {
      notes = section("Unreleased");
      if (!notes) {
        console.error("CHANGELOG.md: [Unreleased] is empty — document the release or pass --notes.");
        process.exit(1);
      }
      text = text.replace(/^## \[Unreleased\][^\n]*$/m, `## [Unreleased]\n\n## [${VERSION}] - ${DATE}`);
      fs.writeFileSync(path, text);
    }
    process.stdout.write(notes);
  ')
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

echo "==> Ensuring both mac targets are installed (universal build)"
rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null

echo "==> Building universal app + DMG (this takes a while)"
npm run tauri build -- --target universal-apple-darwin

BUNDLE_DIR="src-tauri/target/universal-apple-darwin/release/bundle"
DMG=$(ls "$BUNDLE_DIR"/dmg/*.dmg)
TARBALL=$(ls "$BUNDLE_DIR"/macos/*.app.tar.gz)
SIG=$(ls "$BUNDLE_DIR"/macos/*.app.tar.gz.sig)

OUT="dist-release"
rm -rf "$OUT" && mkdir -p "$OUT"
DMG_NAME="BranchLab_${VERSION}_universal.dmg"
TAR_NAME="BranchLab_${VERSION}_universal.app.tar.gz"
cp "$DMG" "$OUT/$DMG_NAME"
cp "$TARBALL" "$OUT/$TAR_NAME"

echo "==> Writing latest.json"
SIGNATURE=$(cat "$SIG") VERSION="$VERSION" NOTES="$NOTES" BASE_URL="$BASE_URL" TAR_NAME="$TAR_NAME" \
node -e '
  const { SIGNATURE, VERSION, NOTES, BASE_URL, TAR_NAME } = process.env;
  const entry = { signature: SIGNATURE, url: `${BASE_URL}/${TAR_NAME}` };
  const manifest = {
    version: VERSION,
    notes: NOTES,
    pub_date: new Date().toISOString(),
    platforms: {
      "darwin-aarch64": entry,
      "darwin-x86_64": entry,
    },
  };
  require("fs").writeFileSync("dist-release/latest.json", JSON.stringify(manifest, null, 2) + "\n");
'

echo
echo "Done. Upload the contents of $OUT/ to $BASE_URL/:"
ls -lh "$OUT"
echo
echo "Then tag the release: git commit -am \"release: v$VERSION\" && git tag v$VERSION"
