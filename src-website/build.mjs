// Build pipeline: minifies HTML/CSS/JS and recompresses images into dist/.
// Screenshots are emitted as WebP (with the HTML rewritten to match); the
// favicon/app icon stays PNG for compatibility. Run with `npm run build`.
import { mkdir, readFile, writeFile, rm, readdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { transform } from "esbuild";
import { minify as minifyHtml } from "html-minifier-terser";
import sharp from "sharp";

const SRC = import.meta.dirname;
const OUT = path.join(SRC, "dist");
const kb = (n) => `${(n / 1024).toFixed(1)} kB`;

await rm(OUT, { recursive: true, force: true });
await mkdir(path.join(OUT, "assets"), { recursive: true });

// ── Images: screenshots → WebP, icon → PNG passthrough ──
const images = (await readdir(path.join(SRC, "assets"))).filter((f) => f.endsWith(".png"));
for (const file of images) {
  const src = path.join(SRC, "assets", file);
  const input = await readFile(src);
  if (file === "app-icon.png") {
    await copyFile(src, path.join(OUT, "assets", file));
    continue;
  }
  const out = path.join(OUT, "assets", file.replace(/\.png$/, ".webp"));
  const webp = await sharp(input).webp({ quality: 88 }).toBuffer();
  await writeFile(out, webp);
  console.log(`${file} → webp  ${kb(input.length)} → ${kb(webp.length)}`);
}

// The og:image must stay PNG for social-card crawlers; emit a recompressed copy.
const og = "session-changes-dark.png";
const ogPng = await sharp(path.join(SRC, "assets", og)).png({ compressionLevel: 9, palette: true }).toBuffer();
await writeFile(path.join(OUT, "assets", og), ogPng);

// ── CSS / JS via esbuild ──
for (const [file, loader] of [
  ["styles.css", "css"],
  ["main.js", "js"],
]) {
  const source = await readFile(path.join(SRC, file), "utf8");
  const { code } = await transform(source, { loader, minify: true });
  await writeFile(path.join(OUT, file), code);
  console.log(`${file}  ${kb(source.length)} → ${kb(code.length)}`);
}

// ── HTML: rewrite screenshot refs to .webp, then minify ──
let html = await readFile(path.join(SRC, "index.html"), "utf8");
// Rewrite local src/href references only — og:image keeps its .png URL.
html = html.replaceAll(/(src|href)="assets\/(?!app-icon)([\w-]+)\.png"/g, '$1="assets/$2.webp"');
const minified = await minifyHtml(html, {
  collapseWhitespace: true,
  removeComments: true,
  minifyCSS: true,
  minifyJS: true,
});
await writeFile(path.join(OUT, "index.html"), minified);
console.log(`index.html  ${kb(html.length)} → ${kb(minified.length)}`);

console.log(`\nDone → ${OUT}`);
