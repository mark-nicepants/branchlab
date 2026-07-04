#!/usr/bin/env bash
# Build a signed, notarized, universal macOS release and stage everything the
# website needs (DMG for new users, .app.tar.gz + latest.json for the
# auto-updater) into dist-release/.
#
# Usage: ./scripts/release.sh 0.2.0 [--notes "What changed"]
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
