// Regenerates every screenshot the marketing site uses, in both themes,
// against the browser dev harness (mocked backend). Run with `npm run shots`
// after visual changes to the app, then `npm run build` to rebuild the site.
//
// Outputs to assets/ (all retina @2x):
//   home-{dark,light}.png              full window · Home screen
//   session-changes-{dark,light}.png   full window · session + changes panel
//   pr-comment-{dark,light}.png        720×560 cutout · inline review comment
//   pr-response-{dark,light}.png       720×560 cutout · feedback card + agent reply
import { spawn } from "node:child_process";
import path from "node:path";
import { chromium } from "playwright";

const SITE = import.meta.dirname;
const REPO = path.join(SITE, "..");
const OUT = path.join(SITE, "assets");
const PORT = 5199;
const URL = `http://localhost:${PORT}/index.browser.html`;

const VIEWPORT = { width: 1440, height: 900 };
// Two staged changes-panel widths: a comfortable one for the full-window
// session shot (the default pref is wider than half the window — too big),
// and the cutout width for the PR flows, where the panel must exactly fill
// the 720px clip.
const SESSION_PANEL_PX = 520;
const CUTOUT_PANEL_PX = 720;
const CUTOUT = { width: 720, height: 560 }; // both PR cutouts share this size

const THEMES = [
  { id: "nord", suffix: "dark" },
  { id: "light", suffix: "light" },
];
const PROMPT =
  "The project settings dialog no longer closes on Escape — fix the regression and add a test";
const COMMENT =
  "Only close on Escape when no other overlay is open — the command palette should win if it's on top.";
const DIFF_LINE = 'if (e.key === "Escape" && settingsOpen) {';
// The mock streams one scripted "showcase" turn for every send: steps, then a
// permission-gated `git push`, then the final prose after the gate is allowed.
const FINAL_PROSE = "Fixed. The config parser";

/** Drive the mock turn to completion: allow the permission gate, then wait
 *  for the final prose. */
async function completeTurn(page) {
  await page.getByRole("button", { name: "Allow once" }).click();
  await page.getByText(FINAL_PROSE).first().waitFor();
  await page.waitForTimeout(500); // summary header settles
}

// ── helpers ──────────────────────────────────────────────────────────────

async function waitForServer(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`dev server never came up at ${url}`);
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(`✓ ${name}.png`);
}

/** Screenshot a CUTOUT-sized region centered on `locator` (clamped to the
 *  viewport). `anchor: "top"` aligns the region's top near the element instead
 *  of centering, so taller content below it stays in frame. */
async function cutout(page, locator, name, anchor = "center") {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`no bounding box for cutout ${name}`);
  const vp = page.viewportSize();
  const cx = box.x + box.width / 2;
  const x = Math.min(Math.max(cx - CUTOUT.width / 2, 0), vp.width - CUTOUT.width);
  const rawY =
    anchor === "top" ? box.y - 56 : box.y + box.height / 2 - CUTOUT.height / 2;
  const y = Math.min(Math.max(rawY, 0), vp.height - CUTOUT.height);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), clip: { x, y, ...CUTOUT } });
  console.log(`✓ ${name}.png (cutout)`);
}

// ── flows ────────────────────────────────────────────────────────────────

/** A fresh context with the theme + a pinned changes-panel width applied. */
async function newThemedContext(browser, theme, panelPx) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
  await context.addInitScript(
    ({ themeId, px }) => {
      localStorage.setItem("branchlab.theme", themeId);
      localStorage.removeItem("branchlab.layout.v1");
      localStorage.setItem("branchlab.prefs", JSON.stringify({ changesPanelWidthPx: px }));
      // The real app draws macOS traffic lights via the overlay titlebar; the
      // browser harness has none, so fake them where macOS would put them.
      addEventListener("DOMContentLoaded", () => {
        const d = document.createElement("div");
        d.style.cssText =
          "position:fixed;top:16px;left:18px;display:flex;gap:8px;z-index:2147483647;pointer-events:none";
        for (const c of ["#ff5f57", "#febc2e", "#28c840"]) {
          const s = document.createElement("span");
          s.style.cssText = `width:12px;height:12px;border-radius:50%;background:${c}`;
          d.appendChild(s);
        }
        document.body.appendChild(d);
      });
    },
    { themeId: theme.id, px: panelPx },
  );
  const page = await context.newPage();
  await page.goto(URL);
  await page.getByRole("button", { name: "Home" }).waitFor();
  await page.waitForTimeout(500); // fonts + sidebar snapshot settle
  return { context, page };
}

async function captureTheme(browser, theme) {
  // ── Context 1 (comfortable panel): Home + session-with-changes ──
  const a = await newThemedContext(browser, theme, SESSION_PANEL_PX);
  let page = a.page;
  await shot(page, `home-${theme.suffix}`);

  // Session: prompt → scripted mock turn (permission-gated).
  await page.getByRole("button", { name: /nimble-otter/ }).click();
  const composer = page.getByRole("textbox", { name: "Ask the agent…" });
  await composer.fill(PROMPT);
  await composer.press("Enter");
  await completeTurn(page);

  // The work section is open by default — no expand click needed.
  await page.getByRole("button", { name: "2", exact: true }).click(); // changes panel
  await page.waitForTimeout(700); // slide-in animation
  await shot(page, `session-changes-${theme.suffix}`);
  await a.context.close();

  // ── Context 2 (panel = cutout width): the PR comment/response flow ──
  const b = await newThemedContext(browser, theme, CUTOUT_PANEL_PX);
  page = b.page;
  await page.getByRole("button", { name: /nimble-otter/ }).click();
  await page.getByRole("button", { name: "2", exact: true }).click(); // changes panel
  await page.waitForTimeout(700); // slide-in animation

  // ── Change details → inline review comment ──
  // The file rows sit inside a sliding panel; plain locator clicks flake on
  // stability checks during the slide, so click through the DOM directly.
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('button[title="src/App.tsx"]')];
    rows[rows.length - 1].click();
  });
  await page.getByText(DIFF_LINE).first().waitFor();
  await page.waitForTimeout(400);
  await page.evaluate((lineText) => {
    const span = [...document.querySelectorAll("span")].find((s) =>
      s.textContent.includes(lineText),
    );
    span.closest(".group").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }, DIFF_LINE);
  const commentBox = page.getByRole("textbox", { name: "Leave a comment for the agent…" });
  await commentBox.fill(COMMENT);
  await cutout(page, commentBox, `pr-comment-${theme.suffix}`);

  // ── Send the comment → agent responds ──
  await commentBox.press("Enter"); // save the comment
  await page.getByRole("button", { name: "Send comment" }).click();
  await page.getByText("Review feedback").first().waitFor();
  await completeTurn(page); // reply is the same permission-gated mock turn
  // Hide the sidebar (⌘B): with the 720px panel still open, the chat column
  // spans exactly x 0–720 — the same width as the cutout. Clip that column,
  // top-aligned just above the feedback card, so the card and the agent's
  // reply below it fill the frame with no sliced neighbors.
  await page.keyboard.press("Meta+b");
  await page.waitForTimeout(700); // relayout
  const cardTop = await page.evaluate(() => {
    const label = [...document.querySelectorAll("*")].find(
      (e) => e.children.length === 0 && e.textContent.trim() === "Review feedback",
    );
    let node = label;
    while (node && node.getBoundingClientRect().width < 400) node = node.parentElement;
    return node.getBoundingClientRect().y;
  });
  const y = Math.min(Math.max(cardTop - 72, 0), VIEWPORT.height - CUTOUT.height);
  await page.screenshot({
    path: path.join(OUT, `pr-response-${theme.suffix}.png`),
    clip: { x: 0, y, ...CUTOUT },
  });
  console.log(`✓ pr-response-${theme.suffix}.png (cutout)`);

  await b.context.close();
}

// ── main ─────────────────────────────────────────────────────────────────

console.log("Starting dev harness…");
const server = spawn(
  "npm",
  ["run", "dev:browser", "--", "--port", String(PORT), "--strictPort", "--no-open"],
  { cwd: REPO, stdio: "ignore", detached: false },
);
try {
  await waitForServer(URL);
  // Prefer system Chrome (no browser download); fall back to bundled Chromium.
  const browser = await chromium
    .launch({ channel: "chrome" })
    .catch(() => chromium.launch());
  for (const theme of THEMES) {
    console.log(`\nTheme: ${theme.id}`);
    await captureTheme(browser, theme);
  }
  await browser.close();
  console.log(`\nDone → ${OUT}\nNow run \`npm run build\` to regenerate dist/.`);
} finally {
  server.kill("SIGTERM");
}
