# Run & Preview — design

Status: Phase 1 shipped (incl. local redroid) · Research date: July 2026

Goal: run the app inside a workspace's worktree and _see it_ from BranchLab —
like t3code's run/preview — locally first, later on a VPS, including Flutter
apps previewed via headless Android streamed over HTTP.

## Research summary

Three tracks were researched (t3code source, remote/VPS prior art, headless
Android streaming). Full agent reports live in the session transcript; the
durable conclusions:

### t3code (verified from source: github.com/pingdotgg/t3code)

- Node WS server + React web app; Electron is just a shell. Its "backend as a
  server" split is why remote comes cheap for them.
- Run commands are **user-authored** in a checked-in `t3.json`
  (`scripts[].command`, `runOnWorktreeCreate`, `previewUrl`). No framework
  detection — nobody in the field does detection (Conductor and Vibe Kanban
  also use user scripts).
- **Port discovery**: no PORT injection, no stdout parsing. Poll
  `lsof -iTCP -sTCP:LISTEN -P -n -F pcn` every 3 s, walk each run process's
  descendant PID tree, join listener PID → task. ~150 lines, framework-agnostic.
- Preview = Electron `<webview>` per tab. No proxy; their remote preview
  gateway is planned, not built.
- Gaps worth not copying: no idle cleanup, no port allocation.

### Remote/VPS (Coder, Gitpod, Conductor, Sculptor, cmux, Vibe Kanban)

- Every serious remote tool converged on **wildcard-subdomain proxying with
  auth-by-default** (`{port}-{workspace}.preview.domain`). **Path-prefix
  proxying is a dead end** (absolute asset URLs, SPA routing, HMR websockets,
  shared-origin XSS) — Coder documents the failures explicitly. Never build it.
- For BranchLab the split is: extract a transport-agnostic `branchlab-core`
  crate (command bodies as plain async fns, events on a `tokio::broadcast`),
  then two thin adapters — Tauri IPC and an axum daemon (`POST /api/{command}`
  mirroring `invoke` shapes + one WS for events, serving the built React app).
  `src/lib/api.ts` / `src/lib/events.ts` pick the transport at startup.
  This is the only step whose cost grows with time.
- Remote v1 = **Tailscale only** (no proxy, no TLS, no auth code; previews at
  `http://vps:port` on the tailnet). Remote v2 (shareable links) = Caddy +
  DNS-01 wildcard cert + `forward_auth` against the daemon, default-private.
- Isolation: `systemd-run --scope -p MemoryMax=2G -p CPUQuota=200%` per
  workspace. Skip Docker-per-workspace and microVMs (multi-tenant tech; the
  agent already runs code as the user).
- Sizing: 16 GB VPS ≈ 6–10 Vite-class or 4–5 Next-class dev servers. Next dev
  leaks to 1–2 GB+; cgroup caps are not optional there.

### Flutter / headless Android

- **redroid** (AOSP as a Docker container — no emulator, **no KVM**) is the
  only option that runs on a commodity KVM VPS. Google's emulator containers
  need KVM (bare metal); Waydroid is desktop-oriented; noVNC options are laggy.
- Per worktree: `docker run --privileged redroid:15_64only
androidboot.use_memfd=1 androidboot.redroid_gpu_mode=guest` →
  `adb connect 127.0.0.1:55xx` → `flutter run -d 127.0.0.1:55xx --machine`.
  `--machine` is JSON-RPC on stdio: `app.restart` = hot reload,
  `app.debugPort` = DevTools URI. No PTY parsing.
- Streaming: push current `scrcpy-server.jar` over adb, bridge its
  video/control sockets to a WebSocket in the Rust backend (~few hundred
  lines; ws-scrcpy original is abandoned, `ws-scrcpy-web` is the successor),
  decode in the browser with WebCodecs → `<canvas>`. Sub-100 ms input.
- ~1–1.5 GB RAM per redroid instance → 6–10 per 16 GB VPS. Boot 30–60 s cold;
  keep 1–2 pre-booted spares.
- Sharp edges: kernels ≥5.18 dropped ashmem → `use_memfd=1` + Android 12+
  images; AOSP has no Play Services; `abiFilters arm64-v8a` won't install on
  x86_64 — or rent an arm64 VPS (Hetzner CAX) and the ABI issue vanishes.
- **Locally**: no streaming — `flutter run -d <local device>` shows the native
  emulator/simulator window. The streaming machinery is purely the VPS path.
- iOS: no legal self-hosted path (macOS EULA binds Simulators to Apple
  hardware). Mac mini + own bridge, or skip.

## Phases

1. **Local run + preview** (this phase) — RunManager in Rust, per-project run
   config with project types, iframe preview for web, native device for
   Flutter. No architecture change.
2. **VPS** — `branchlab-core` extraction + axum daemon, Tailscale-first,
   wildcard proxy only when public links are needed.
3. **Flutter remote preview** — redroid + scrcpy→WS→WebCodecs canvas per
   workspace, driven by `flutter run --machine`.

## Phase 1 spec

### Project run config (registry)

Projects gain a `run` settings block, editable in Project Settings → Run:

- `project_type`: `"web" | "flutter"` — decides the preview surface
  (iframe vs device status) and, later, the VPS preview strategy
  (proxy vs Android stream).
- `run_script`: dev-server command (e.g. `npm run dev -- --port $BL_PORT`,
  `flutter run -d macos`). Manual start from the session view.
- `setup_script`: runs once in a fresh worktree right after creation
  (installs, `.env` symlinks — t3code's proven pattern).
- `teardown_script`: best-effort, with timeout, before worktree removal.

All commands run as `sh -lc` (login shell → user PATH), cwd = worktree, with
env: `BL_PORT` (allocated free port), `BL_PROJECT_ROOT`, `BL_WORKTREE_PATH`,
and `BL_WORKSPACE_ID` — a stable unique key for per-worktree resources
(database names, cache prefixes). Per-worktree data isolation is deliberately
a _project concern_ solved in setup/teardown scripts: SQLite projects get it
for free (the DB file lives in the worktree); MySQL/Postgres projects create
`app_${BL_WORKSPACE_ID}`-style databases in setup and drop them in teardown.

### RunManager (`src-tauri/src/run.rs`)

Sibling of `ServerManager`, same shape:

- One run process per workspace, spawned in its own **process group**
  (`setsid`); stop/cleanup kills the group, never a lone PID.
- stdout/stderr streamed line-wise to the UI as `workspace:run_log` events;
  status transitions (`idle → running → exited(code)`) as `workspace:run`.
- **Port discovery**, t3code recipe: while any run process lives, poll
  `lsof -iTCP -sTCP:LISTEN -P -n -F pcn` every 3 s, attribute listeners to
  workspaces via the run child's descendant PID tree, emit discovered ports on
  `workspace:run`. `BL_PORT` is a hint, discovery is the truth (tools that
  ignore the env var and pick their own port still get found).
- Kill on workspace removal and app exit. No idle reaper for run processes in
  phase 1 (unlike opencode servers, the user started these explicitly).

### Frontend

- **Session header**: Run/Stop control (visible when the project has a
  `run_script`).
- **RunPanel** (slides in like ChangesPanel): log stream + status; for
  `web` a preview iframe pointed at the first discovered port (with refresh /
  open-in-browser); for `flutter` a device status card (the app renders on
  the native local emulator — nothing to embed locally).
- All data arrives via `events.ts` pushes; a `run_state` snapshot command
  seeds remounts (same pattern as `chat_open`).

### Explicit non-goals (phase 1)

- No framework detection, no auto-start on workspace create (only
  `setup_script` runs automatically).
- No idle reaping of run processes, no port _reservation_ across restarts.
- No remote/proxy anything.

## Phase 1.5 — local redroid (`flutter-redroid` project type)

The local half of the phase-3 VPS stack, so the container → adb →
`flutter run` wiring can be exercised before any server exists.

- **AndroidManager** (`src-tauri/src/android.rs`): one redroid container per
  workspace (`bl-redroid-<ws>`, deterministic adb port from the workspace id).
  Runtime abstraction: **Docker preferred, Apple `container` fallback**
  (`--privileged` vs `--cap-add ALL`; `pull` vs `image pull` — everything else
  is flag-compatible). No inspect/schema parsing: `run`, fall back to `start`,
  and let the adb `sys.boot_completed` wait be the readiness gate.
- Run flow: `run_start` boots the container off-thread (progress streams into
  the run log + `workspace:android` events), then starts the run script with
  `ANDROID_SERIAL`/`BL_ANDROID_SERIAL` pointing at it — so the script is just
  `flutter run -d $ANDROID_SERIAL`.
- **Preview (interim)**: backend-pushed `screencap -p` frames
  (`workspace:android_frame`, ~1.4 fps) + `input tap` at normalized
  coordinates. Deliberately version-proof; the scrcpy→WebSocket→WebCodecs
  stream planned for the VPS phase replaces this transport wholesale.
- Lifecycle: container is kept warm across run stop/start; **stopped** on app
  exit; **removed** on workspace deletion.

### Runtime feasibility (researched July 2026, verified sources)

| Host                                                  | redroid works?                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux (VPS/desktop), Docker + `modprobe binder_linux` | **Yes** — the target path                                                                                                                                                                                                                                                                                                                                               |
| macOS, Docker Desktop / OrbStack                      | **No** — LinuxKit/custom kernels ship `CONFIG_ANDROID_BINDER_IPC` disabled, no module loading                                                                                                                                                                                                                                                                           |
| macOS, Apple `container`                              | **Blocked upstream** — a custom binder-enabled kernel verifiably works (`-k vmlinux-arm64 --cap-add ALL`, kata config + `CONFIG_ANDROID_BINDER_IPC=y` etc.), but redroid's rootfs trips apple/container's `configureDns`/`configureHosts` bootstrap ([apple/container#1737](https://github.com/apple/container/issues/1737), open; fix PR closed unmerged as of v1.1.0) |
| macOS, Ubuntu VM (UTM/Parallels) + docker inside      | Yes — maintainer-endorsed recipe                                                                                                                                                                                                                                                                                                                                        |

`BRANCHLAB_REDROID_KERNEL=<path>` passes `--kernel` to Apple `container` runs,
so the day #1737 is fixed a binder-enabled kernel makes this work as-is.
Error signatures: missing binder → boot loop (`Binder driver '/dev/binder'
could not be opened`) → our boot timeout; apple/container today → immediate
`configureDns` bootstrap failure in the streamed `run` output.

## Circle back: apple/container#1737 (redroid on Apple `container`)

**Tracking:** <https://github.com/apple/container/issues/1737> — "unable to
run redroid: bootstrap fails at configureDns/configureHosts". Open as of
July 2026; fix PR [#1822](https://github.com/apple/container/pull/1822) was
closed unmerged; not in v1.1.0. Root causes (confirmed by a maintainer, in
the `containerization` lib): vminitd always writes `/etc/hostname`, and
`configureHosts` always runs — both fail on redroid's rootfs, which has no
writable standard `/etc`. `--no-dns` does not help (it fails at
`configureHosts` next).

**How to check if it's fixed:** on a new `container` release, run
`container run --rm --cap-add ALL docker.io/redroid/redroid:15.0.0_64only-latest`
— if it gets past bootstrap (fails later, or boots with a binder kernel),
the blocker is gone.

**When fixed, to make flutter-redroid work on this Mac:**

1. Build a binder-enabled kernel per
   [apple/containerization `kernel/`](https://github.com/apple/containerization/tree/main/kernel):
   take `config-arm64`, add
   `CONFIG_ANDROID_BINDER_IPC=y`, `CONFIG_ANDROID_BINDERFS=y`,
   `CONFIG_ANDROID_BINDER_DEVICES="binder,hwbinder,vndbinder"`, then `make`
   (builds in a container; output is an uncompressed arm64 `Image`,
   conventionally named `vmlinux-arm64`). Verified working in #1737's thread —
   binder mounts fine under `--cap-add ALL`; no other BranchLab change needed.
2. Launch BranchLab with `BRANCHLAB_REDROID_KERNEL=/path/to/vmlinux-arm64`
   (or set it system-wide via `container system kernel set` — note it rejects
   `.zst` archives and relative paths, apple/container #767/#573).
3. Press Run on a flutter-redroid workspace; the boot log streams into the
   run panel.

**Until then on macOS:** Docker in an Ubuntu VM (UTM/Parallels) +
`modprobe binder_linux devices="binder,hwbinder,vndbinder"` is the
maintainer-endorsed path, or point a docker context at a Linux box — the
docker code path is exactly what the VPS will run. Interesting alternative
seen in #1737: `cuttlefish/cuttlefish-orchestration` boots cleanly under
apple/container today (heavier than redroid; would need adb wiring changes).
