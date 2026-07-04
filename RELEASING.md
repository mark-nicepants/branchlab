# Releasing BranchLab

Distribution is a signed + notarized DMG hosted on the website; updates go
through `tauri-plugin-updater`, which polls `latest.json`, shows an in-app
toast, and swaps the `.app` in place on click ("Update & restart").

Cutting a release (tag-triggered, built in CI):

1. Make sure `CHANGELOG.md` has the release's changes under `## [Unreleased]`
   (the prepare step aborts if it's empty).
2. `./scripts/release.sh <version>` — **prepare only**: rolls the changelog
   over (`[Unreleased]` → `[<version>] - <date>`) and bumps the version in
   `package.json` / `tauri.conf.json` / `Cargo.toml`. Pass `--notes "..."`
   to use custom notes as the changelog section instead.
3. Commit, tag, push:

   ```bash
   git add -A && git commit -m "release: v<version>"
   git tag v<version> && git push && git push --tags
   ```

   The `v<version>` tag triggers `.github/workflows/release.yml`, which
   builds the universal DMG + signed updater artifacts
   (`./scripts/release.sh --build`), uploads them to the VPS releases dir
   (binaries first, `latest.json` last — the manifest is the go-live
   trigger), and attaches everything to a GitHub release. The workflow
   fails fast if the tag doesn't match the committed version.

`./scripts/release.sh --build` also works locally (artifacts land in
`dist-release/`, gitignored) — useful for testing the build or a manual
upload. Known local quirk: on some macOS setups `hdiutil convert` fails with
"Resource temporarily unavailable" during DMG compression; the script
detects this and rebuilds the DMG via `hdiutil create` automatically.

Required GitHub secrets:

- `TAURI_SIGNING_PRIVATE_KEY` — the **content** of `~/.tauri/branchlab.key`
  (Tauri v2 takes content or a path in this one variable; there is no
  `_PATH` variant).
- `VPS_HOST` / `VPS_USER` / `VPS_PASSWORD` — shared with the website deploy.

## Hosting

`https://branchlab.dev/releases/` is served by the website's nginx container
(`.github/workflows/deploy-site.yml`): the host directory
`~/apps/branchlab-releases` is bind-mounted read-only into the container, so
release artifacts survive site redeploys. `latest.json` is served with
`no-cache`; the versioned artifacts are cached as immutable.

## Open TODOs (as of 2026-07-04)

### 1. Back up the updater signing key

The keypair lives at `~/.tauri/branchlab.key` (+ `.key.pub`), generated with an
empty password. Store the private key in a password manager / CI secret.
**If it is lost, shipped apps can never receive updates again** — the public
key baked into every installed app must match.

### 2. Apple Developer credentials (enrollment pending)

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

### 3. End-to-end update test (not yet run)

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

### 4. Later / optional

- CI signing/notarization: once the Apple Developer account exists, add the
  certificate + API-key secrets to the Release workflow so tagged builds
  come out notarized (the local-machine setup in TODO 2 is the manual path).
