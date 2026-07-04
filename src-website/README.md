# BranchLab website

The one-page marketing site for BranchLab (branchlab.dev). Plain static
HTML/CSS/JS; a small build pipeline minifies everything for production.

## Preview locally

```bash
cd src-website && npm run dev     # serves the source at http://localhost:8899
```

## Build & deploy

```bash
npm install
npm run build      # → dist/ (minified HTML/CSS/JS, screenshots as WebP)
npm run preview    # serve dist/ locally
```

Deploys are automated: pushing changes under `src-website/` to `main` runs
`.github/workflows/deploy-site.yml`, which builds `dist/`, uploads it to the
VPS, and (re)builds a slim nginx:alpine container (`deploy/Dockerfile` +
`deploy/nginx.conf`) named `branchlab-site` on the shared `npm` docker
network — nginx-proxy-manager terminates TLS and proxies the public hostname
to it on :80. Required repo secrets: `VPS_HOST`, `VPS_USER`, `VPS_PASSWORD`.

The og:image stays PNG for social-card crawlers; everything else ships WebP.
The auto-updater expects `https://branchlab.dev/releases/latest.json`, so
`/releases/` (the `dist-release/` updater artifacts) still needs a home —
either baked into this container later or proxied separately.

## Updating screenshots

```bash
npm run shots      # regenerates every image in assets/, both themes
npm run build      # then rebuild dist/
```

`screenshots.mjs` starts the browser dev harness (mocked backend) itself,
drives the UI with Playwright (system Chrome, no browser download), and
captures each shot in `github-copilot-dark` and `light`:

- `home-*` / `session-changes-*` — full 1440×900 windows (@2x) with macOS
  traffic lights injected where the real overlay titlebar draws them.
- `pr-comment-*` / `pr-response-*` — equal 720×560 cutouts (@2x) of the inline
  review-comment composer and the "Review feedback" card + agent reply.

After visual changes to the app, rerun the two commands above — no manual
Playwright driving needed. If a flow changes (selectors, mock data), adjust
the constants at the top of `screenshots.mjs`.
