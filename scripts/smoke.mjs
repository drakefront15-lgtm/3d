/**
 * Smoke check for index.html.
 *
 *   node scripts/smoke.mjs
 *
 * Verifies the things that were broken: that the page scrolls natively past
 * the hero, that every section heading is genuinely visible while scrolling
 * top to bottom, that the page is keyboard navigable with a visible focus
 * ring, that it holds up with reduced motion, and that it still reads with
 * JavaScript switched off.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";

/* Playwright may be installed globally in this environment; createRequire
   honours NODE_PATH, which bare ESM specifiers do not. */
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  console.error("playwright not found. Try: NODE_PATH=$(npm root -g) node scripts/smoke.mjs");
  process.exit(2);
}

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WIDTHS = [1440, 1024, 390];
const STOPS = [0, 0.25, 0.5, 0.75, 1];   // the sweep starts at the top, then 25/50/75/100%

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const bad = (m) => { failures++; console.log(`  FAIL ${m}`); };
const check = (cond, m) => (cond ? ok(m) : bad(m));

const server = createServer(async (req, res) => {
  const file = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  try {
    const body = await readFile(path.join(ROOT, file));
    res.writeHead(200, { "content-type": file.endsWith(".html") ? "text/html" : "text/plain" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();

/* ---------------------------------------------- 1. scroll sweep per width */
for (const width of WIDTHS) {
  console.log(`\n[${width}px] scroll sweep`);
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(base, { waitUntil: "load" });
  await page.waitForTimeout(400);

  const docH = await page.evaluate(() => document.documentElement.scrollHeight);
  const vh = await page.evaluate(() => innerHeight);
  check(docH > vh * 2.5, `document is ${docH}px tall, more than 2.5 viewports (${vh}px)`);

  const headingSel = "h1, h2";
  const total = await page.locator(headingSel).count();
  const seen = new Set();

  for (const stop of STOPS) {
    await page.evaluate((s) => scrollTo({ top: (document.documentElement.scrollHeight - innerHeight) * s, behavior: "instant" }), stop);
    await page.waitForTimeout(500);

    const state = await page.evaluate((sel) => {
      return [...document.querySelectorAll(sel)].map((el, i) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          i,
          text: el.textContent.trim().slice(0, 40),
          opacity: Number(cs.opacity),
          inView: r.top < innerHeight && r.bottom > 0 && r.height > 0,
          visibility: cs.visibility,
        };
      });
    }, headingSel);

    const bust = state.filter((h) => h.inView && (h.opacity === 0 || h.visibility === "hidden"));
    check(bust.length === 0, `at ${stop * 100}% — ${state.filter((h) => h.inView).length} heading(s) in viewport, all with non-zero opacity`);
    if (bust.length) console.log("       hidden:", bust.map((b) => b.text));
    state.filter((h) => h.inView && h.opacity > 0).forEach((h) => seen.add(h.i));

    const painted = await page.evaluate(() => {
      // is anything at all rendered in the current viewport?
      let n = 0;
      for (const el of document.querySelectorAll("main *")) {
        const r = el.getBoundingClientRect();
        if (r.top < innerHeight && r.bottom > 0 && r.height > 4 && getComputedStyle(el).opacity > 0) n++;
      }
      return n;
    });
    check(painted > 3, `at ${stop * 100}% — ${painted} visible elements in viewport (not a void)`);
  }

  check(seen.size === total, `all ${total} section headings were seen visible during the sweep (${seen.size}/${total})`);
  await ctx.close();
}

/* --------------------------------------------------------- 2. keyboard nav */
{
  console.log("\n[1440px] keyboard");
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(base, { waitUntil: "load" });

  const order = [];
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      return {
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || "").trim().slice(0, 28),
        outline: `${cs.outlineStyle} ${cs.outlineWidth}`,
      };
    });
    if (!info) break;
    order.push(info);
  }
  check(order.length >= 8, `${order.length} elements reachable by Tab`);
  const noRing = order.filter((o) => o.outline.startsWith("none") || o.outline.endsWith("0px"));
  check(noRing.length === 0, "every focused element paints a focus ring");
  if (noRing.length) console.log("       no ring:", noRing);
  console.log("       order:", order.map((o) => `${o.tag}:${o.text}`).join(" → "));

  // keyboard scrolling works (no hijack)
  await page.evaluate(() => scrollTo(0, 0));
  await page.locator("body").press("End");
  await page.waitForTimeout(600);
  const atEnd = await page.evaluate(() => scrollY > (document.documentElement.scrollHeight - innerHeight) * 0.9);
  check(atEnd, "End key reaches the bottom of the document");

  await page.keyboard.press("Home");
  await page.waitForTimeout(600);
  const atTop = await page.evaluate(() => scrollY < 10);
  check(atTop, "Home key returns to the top");
  await ctx.close();
}

/* ---------------------------------------------------- 3. reduced motion run */
{
  console.log("\n[1440px] prefers-reduced-motion: reduce");
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.goto(base, { waitUntil: "load" });
  await page.waitForTimeout(300);
  const hidden = await page.evaluate(() =>
    [...document.querySelectorAll(".reveal")].filter((el) => Number(getComputedStyle(el).opacity) === 0).length);
  check(hidden === 0, "no .reveal element is hidden under reduced motion");
  const jsReady = await page.evaluate(() => document.documentElement.classList.contains("js-ready"));
  check(!jsReady, "reveal animation is not armed under reduced motion");
  await ctx.close();
}

/* ------------------------------------------------------ 4. JavaScript off */
{
  console.log("\n[1440px] JavaScript disabled");
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, javaScriptEnabled: false });
  const page = await ctx.newPage();
  await page.goto(base, { waitUntil: "load" });
  const headings = await page.locator("h1, h2").allTextContents();
  check(headings.length >= 5, `${headings.length} headings present without JS`);
  for (const sel of ["h1", "#services h2", "#work h2", "#process h2", "#contact h2"]) {
    const vis = await page.locator(sel).first().isVisible();
    check(vis, `${sel} is visible without JS`);
  }
  const h1Box = await page.locator("h1").boundingBox();
  check(h1Box && h1Box.height > 40, "headline has real layout height without JS");
  await ctx.close();
}

/* -------------------------------------------- 5. contrast + cheap tells */
{
  console.log("\n[1440px] contrast and finish");
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(base, { waitUntil: "load" });
  await page.waitForTimeout(400);

  const report = await page.evaluate(() => {
    const parse = (c) => c.match(/[\d.]+/g).map(Number);
    const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    const bgOf = (el) => {
      let n = el;
      while (n && n !== document.documentElement) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c.length < 4 || c[3] > 0.95) return c.slice(0, 3);
        n = n.parentElement;
      }
      return [6, 9, 15];
    };
    const out = [];
    for (const el of document.querySelectorAll("p, li, h1, h2, h3, a, span, b")) {
      if (!el.textContent.trim()) continue;
      if (el.getBoundingClientRect().height === 0) continue;
      if ([...el.children].some((c) => c.textContent.trim().length > 4)) continue; // leaf text only
      const cs = getComputedStyle(el);
      const fg = parse(cs.color).slice(0, 3);
      const L1 = lum(fg), L2 = lum(bgOf(el));
      const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const px = parseFloat(cs.fontSize);
      const large = px >= 24 || (px >= 18.66 && Number(cs.fontWeight) >= 700);
      out.push({
        text: el.textContent.trim().slice(0, 30),
        ratio: Math.round(ratio * 100) / 100,
        min: large ? 3 : 4.5,
        px: Math.round(px),
      });
    }
    return {
      items: out,
      shadows: [...document.querySelectorAll("*")].filter((e) => getComputedStyle(e).textShadow !== "none").length,
      // distinct letterspaced-uppercase treatments: ignore children that merely
      // inherit the same values from the element that declares them
      tracked: [...new Set([...document.querySelectorAll("*")].filter((e) => {
        const cs = getComputedStyle(e);
        if (!e.textContent.trim() || e.getBoundingClientRect().height === 0) return false;
        if (cs.textTransform !== "uppercase" || parseFloat(cs.letterSpacing) <= 0.5) return false;
        const p = e.parentElement;
        if (p) {
          const ps = getComputedStyle(p);
          if (ps.textTransform === cs.textTransform && ps.letterSpacing === cs.letterSpacing) return false;
        }
        return true;
      }).map((e) => `${e.tagName.toLowerCase()}.${(e.className || "").split(" ")[0]} ${getComputedStyle(e).letterSpacing}`))],
      idleAnimations: [...document.querySelectorAll("*")]
        .filter((e) => getComputedStyle(e).animationName !== "none").length,
    };
  });

  const low = report.items.filter((i) => i.ratio < i.min);
  check(low.length === 0, `all ${report.items.length} text nodes meet WCAG AA contrast (min seen ${Math.min(...report.items.map((i) => i.ratio))}:1)`);
  if (low.length) console.log("       low:", low.slice(0, 8));
  check(report.shadows === 0, "no text-shadow anywhere on the page");
  const distinctTracked = report.tracked;
  check(distinctTracked.length <= 1, `letterspaced uppercase used in ${distinctTracked.length} place(s): ${distinctTracked.join(", ") || "none"}`);
  check(report.idleAnimations === 0, `${report.idleAnimations} CSS keyframe animations running (canvas is the single idle motion)`);
  await ctx.close();
}

await browser.close();
server.close();

console.log(failures === 0 ? "\nAll smoke checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
