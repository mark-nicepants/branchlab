# Releasing BranchLab

Distribution is a signed + notarized DMG hosted on the website; updates go
through `tauri-plugin-updater`, which polls `latest.json`, shows an in-app
toast, and swaps the `.app` in place on click ("Update & restart").

Cutting a release:

1. Make sure `CHANGELOG.md` has the release's changes under `## [Unreleased]`
   (the script aborts if it's empty).
2. `./scripts/release.sh <version>` — rolls the changelog over
   (`[Unreleased]` → `[<version>] - <date>`, fresh empty `[Unreleased]` on
   top), bumps versions, builds, and uses the changelog section as the
   `notes` in `latest.json` — shown in the in-app update toast.
   Pass `--notes "..."` to override the notes text.
3. Upload the contents of `dist-release/` to the website's releases path,
   commit + tag (`git commit -am "release: v<version>" && git tag v<version>`).

## Open TODOs (as of 2026-07-04)

### 1. Set the real update endpoint URL

`https://branchlab.dev/releases/latest.json` is a **placeholder**. Replace it
in two places once the website path is decided:

- `src-tauri/tauri.conf.json` → `plugins.updater.endpoints`
- `scripts/release.sh` → `BASE_URL` default (or set `RELEASE_BASE_URL` when running)

### 2. Back up the updater signing key

The keypair lives at `~/.tauri/branchlab.key` (+ `.key.pub`), generated with an
empty password. Store the private key in a password manager / CI secret.
**If it is lost, shipped apps can never receive updates again** — the public
key baked into every installed app must match.

### 3. Apple Developer credentials (enrollment pending)

Once the Apple Developer Program enrollment is approved:

1. Create a **Developer ID Application** certificate and install it in the
   login keychain.
2. Create an **App Store Connect API key** (for notarization).
3. Export before running the release script:
   - `APPLE_SIGNING_IDENTITY="Developer ID Application: <Name> (<TEAMID>)"`
   - `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH`

Without these the script still builds (it warns), but downloads hit
Gatekeeper's "app is damaged" block for real users. Local testing on this
machine is fine unsigned.

### 4. End-to-end update test (not yet run)

1. Build at the current version and install the app to `/Applications`
   (updating an app running from a read-only DMG mount fails).
2. Bump the version, run `./scripts/release.sh <next-version>`.
3. Serve `dist-release/` locally: `npx serve dist-release`.
4. Temporarily point `plugins.updater.endpoints` at
   `http://localhost:3000/latest.json` in the *installed* build (i.e. build
   step 1 with the localhost endpoint).
5. Launch the installed app → expect the update toast → click
   **Update & restart** → app relaunches on the new version.
6. Revert the endpoint to the real URL.

### 5. Later / optional

- Move the release build to CI (GitHub Actions `tauri-action` builds, signs,
  notarizes, and generates `latest.json`); upload step pushes to the website.
- Website download page linking the latest DMG.
