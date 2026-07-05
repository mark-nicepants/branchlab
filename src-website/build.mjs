// Build pipeline: minifies HTML/CSS/JS and recompresses images into dist/.
// Screenshots are emitted as WebP (with the HTML rewritten to match); the
// favicon/app icon stays PNG for compatibility. Every emitted asset gets a
// content hash in its filename (cache busting: nginx serves /assets/ as
// immutable for 30 days, so names MUST change when content does — index.html
// is no-cache and always references the fresh names). Run with `npm run build`.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import path from "node:path";
import { transform } from "esbuild";
import { minify as minifyHtml } from "html-minifier-terser";
import sharp from "sharp";

const SRC = import.meta.dirname;
const OUT = path.join(SRC, "dist");
const kb = (n) => `${(n / 1024).toFixed(1)} kB`;
const hash8 = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 8);

await rm(OUT, { recursive: true, force: true });
await mkdir(path.join(OUT, "assets"), { recursive: true });

// ── Images: screenshots → WebP, icon → PNG passthrough (all content-hashed) ──
/** original ref name ("home-dark.png") → hashed emitted filename */
const hashedName = {};
const images = (await readdir(path.join(SRC, "assets"))).filter((f) => f.endsWith(".png"));
for (const file of images) {
  const src = path.join(SRC, "assets", file);
  const input = await readFile(src);
  if (file === "app-icon.png") {
    const name = `app-icon.${hash8(input)}.png`;
    await writeFile(path.join(OUT, "assets", name), input);
    hashedName[file] = name;
    continue;
  }
  const webp = await sharp(input).webp({ quality: 88 }).toBuffer();
  const name = file.replace(/\.png$/, `.${hash8(webp)}.webp`);
  await writeFile(path.join(OUT, "assets", name), webp);
  hashedName[file] = name;
  console.log(`${file} → ${name}  ${kb(input.length)} → ${kb(webp.length)}`);
}

// The og:image must stay PNG for social-card crawlers; emit a recompressed,
// hashed copy (the meta tag is rewritten below).
const og = "session-changes-dark.png";
const ogPng = await sharp(path.join(SRC, "assets", og)).png({ compressionLevel: 9, palette: true }).toBuffer();
const ogName = `session-changes-dark.${hash8(ogPng)}.png`;
await writeFile(path.join(OUT, "assets", ogName), ogPng);

// ── CSS / JS: minify with esbuild, then INLINE into the HTML ──
// Both are small (≈10 kB CSS, <1 kB JS); inlining removes the render-blocking
// stylesheet request from the critical path (Lighthouse: "avoid chaining
// critical requests") — the page renders from the single HTML response.
const minified = {};
for (const [file, loader] of [
  ["styles.css", "css"],
  ["main.js", "js"],
]) {
  const source = await readFile(path.join(SRC, file), "utf8");
  const { code } = await transform(source, { loader, minify: true });
  minified[file] = code.trim();
  console.log(`${file}  ${kb(source.length)} → ${kb(code.length)} (inlined)`);
}

// ── HTML: rewrite asset refs to hashed names, inline CSS/JS, then minify ──
let html = await readFile(path.join(SRC, "index.html"), "utf8");
// og:image is an absolute URL in a meta content attribute — rewrite it to the
// hashed PNG before the generic src/href pass.
html = html.replace(
  /content="https:\/\/branchlab\.dev\/assets\/session-changes-dark\.png"/,
  () => `content="https://branchlab.dev/assets/${ogName}"`,
);
// Every local src/href asset reference gets its hashed name (webp for
// screenshots, png for the icon). Unknown references fail the build rather
// than shipping a 404.
html = html.replaceAll(/(src|href)="assets\/([\w-]+\.png)"/g, (_m, attr, file) => {
  const name = hashedName[file];
  if (!name) throw new Error(`no hashed asset emitted for ${file}`);
  return `${attr}="assets/${name}"`;
});
html = html.replace(
  /<link rel="stylesheet" href="styles.css"\s*\/?>/,
  () => `<style>${minified["styles.css"]}</style>`,
);
// The script sits at the end of <body>, so the DOM above it is already
// parsed — `defer` is unnecessary once inlined.
html = html.replace(
  /<script src="main.js" defer><\/script>/,
  () => `<script>${minified["main.js"]}</script>`,
);
if (html.includes("styles.css") || html.includes("main.js")) {
  throw new Error("inlining failed — stylesheet/script tag not replaced");
}
const outHtml = await minifyHtml(html, {
  collapseWhitespace: true,
  removeComments: true,
  minifyCSS: true,
  minifyJS: true,
});
await writeFile(path.join(OUT, "index.html"), outHtml);
console.log(`index.html  ${kb(html.length)} → ${kb(outHtml.length)}`);

console.log(`\nDone → ${OUT}`);
