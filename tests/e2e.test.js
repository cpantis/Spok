// End-to-end checks in a real browser (Chromium via Playwright), at phone size.
// Run: npm test   (or: node tests/e2e.test.js)
const http = require("http");
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { chromium } = require("playwright");

const root = path.join(__dirname, "..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".mp3": "audio/mpeg" };

function serve() {
  const server = http.createServer((req, res) => {
    const p = path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] || "application/octet-stream" });
    fs.createReadStream(p).pipe(res);
  });
  return new Promise(r => server.listen(0, "127.0.0.1", () => r(server)));
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

let base, browser;
async function open(hash = "", { state, voices, width = 390, clock = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 800 }, serviceWorkers: "block", acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource|fonts\.g/.test(m.text())) errors.push(m.text()); });
  page.on("dialog", d => d.accept());
  await page.addInitScript(([st, vs]) => {
    if (st !== undefined) localStorage.setItem("spok-v2", typeof st === "string" ? st : JSON.stringify(st));
    window.__spoken = [];
    speechSynthesis.speak = u => { window.__spoken.push(u.text); setTimeout(() => u.onend && u.onend(), 20); };
    if (vs) speechSynthesis.getVoices = () => vs;
  }, [state, voices]);
  if (clock) await page.clock.install();
  await page.goto(`${base}/index.html${hash ? "#" + hash : ""}`);
  page.errors = errors;
  return page;
}
const go = (page, hash) => page.evaluate(h => { location.hash = h; }, hash);
const stored = page => page.evaluate(() => JSON.parse(localStorage.getItem("spok-v2") || "{}"));
const text = (page, sel) => page.textContent(sel);

/* ---------- every page ---------- */
test("every page renders with a heading, a title and no errors, without sideways scrolling at 360px", async () => {
  const page = await open("", { width: 360 });
  const routes = ["home", "warmup", "warmup-express", "kids", "about"];
  for (let i = 1; i <= 29; i++) routes.push("lesson-" + i);
  for (let i = 1; i <= 12; i++) routes.push("kids-" + i);
  for (let i = 1; i <= 10; i++) routes.push("sound-" + i);
  for (const r of routes) {
    await go(page, r);
    const info = await page.evaluate(() => ({ h1: document.querySelector("#app h1")?.textContent, w: document.documentElement.scrollWidth, title: document.title }));
    assert.ok(info.h1, `${r}: no heading`);
    assert.ok(info.w <= 360, `${r}: page is ${info.w}px wide`);
    assert.ok(info.title.includes("Spok"), `${r}: title "${info.title}"`);
  }
  await go(page, "lesson-99");
  assert.ok(await page.$("#cont"), "an unknown address shows the home page");
  assert.deepStrictEqual(page.errors, []);
});

test("broken saved data does not break the app", async () => {
  for (const st of ["{not json", JSON.stringify({ done: "x", days: "y", checks: null }), "[]"]) {
    const page = await open("", { state: st });
    assert.ok(await page.$("#cont"), "home renders");
    await go(page, "lesson-1");
    await page.click("#done");
    assert.strictEqual((await stored(page)).done[0], true);
    assert.deepStrictEqual(page.errors, []);
  }
});

/* ---------- home ---------- */
test("home: 'Start here' opens lesson 1, then 'Continue' points to the first unfinished lesson", async () => {
  const page = await open();
  assert.match(await text(page, ".next .eyebrow"), /Start here/);
  await page.click("#cont");
  await page.waitForFunction(() => location.hash === "#lesson-1");
  await page.click("#done");
  await go(page, "home");
  assert.match(await text(page, ".next .eyebrow"), /Continue/);
  assert.match(await text(page, ".next .t"), /Crisp Consonants/);
  assert.match(await text(page, ".ring .num"), /^1/);
});

test("home: when every lesson is done, the continue card gives way to a 'complete' message", async () => {
  const done = Object.fromEntries([...Array(29)].map((_, i) => [i, true]));
  const page = await open("", { state: { done, days: [] } });
  assert.strictEqual(await page.$("#cont"), null);
  assert.match(await text(page, ".complete"), /All 29 lessons complete/);
});

test("home: modules open and close", async () => {
  const page = await open();
  const btn = page.locator(".mtop[data-m='hard']");
  assert.strictEqual(await btn.getAttribute("aria-expanded"), "false");
  await btn.click();
  assert.strictEqual(await btn.getAttribute("aria-expanded"), "true");
  assert.ok(await page.locator(".mod.expanded .lrow").count() > 0);
});

/* ---------- lesson ---------- */
test("lesson: 5 drill lines, each plays its Heart clip", async () => {
  const page = await open("lesson-4");
  const reqs = [];
  page.on("request", r => { if (r.url().includes("/audio/")) reqs.push(r.url().split("/audio/")[1]); });
  assert.strictEqual(await page.locator(".line").count(), 5);
  for (let k = 0; k < 5; k++) { await page.click(`.line[data-k="${k}"]`); await page.waitForTimeout(150); }
  for (let k = 1; k <= 5; k++) assert.ok(reqs.includes(`l4-${k}.mp3`), `l4-${k} not requested`);
});

test("lesson: marking complete keeps your place and makes 'Next lesson' the main button", async () => {
  const page = await open("lesson-3");
  await page.evaluate(() => window.scrollTo(0, 99999));
  const y = await page.evaluate(() => scrollY);
  await page.click("#done");
  assert.strictEqual(await page.evaluate(() => scrollY), y);
  assert.match(await page.getAttribute("#nextL", "class"), /primary/);
  await page.click("#nextL");
  await page.waitForFunction(() => location.hash === "#lesson-4");
  await go(page, "lesson-29");
  await page.click("#nextL");
  await page.waitForFunction(() => location.hash === "#home");
});

test("lesson: self-check answers are saved", async () => {
  const page = await open("lesson-2");
  await page.check("#c1-1");
  await go(page, "home");
  await go(page, "lesson-2");
  assert.ok(await page.isChecked("#c1-1"));
});

test("lesson timer counts down, beeps into overtime, pauses and resets", async () => {
  const page = await open("lesson-8", { clock: true }); // 20 s task
  await page.click("#tgo");
  await page.clock.runFor(5000);
  assert.strictEqual(await text(page, "#clock"), "0:15");
  await page.click("#tgo"); // pause
  await page.clock.runFor(10000);
  assert.strictEqual(await text(page, "#clock"), "0:15");
  await page.click("#tgo"); // resume
  await page.clock.runFor(18000);
  assert.strictEqual(await text(page, "#clock"), "+0:03");
  assert.match(await page.getAttribute("#clock", "class"), /over/);
  await page.click("#treset");
  assert.strictEqual(await text(page, "#clock"), "0:20");
  assert.strictEqual(await text(page, "#tgo"), "Start 20s timer");
});

test("filler counter keeps your best (lowest) round, including a clean round of 0", async () => {
  const page = await open("lesson-5", { clock: true });
  for (const n of [1, 3, 0]) {
    await page.click("#tgo");
    await page.clock.runFor(2000);
    for (let i = 0; i < n; i++) await page.click("#fplus");
    await page.click("#treset");
  }
  assert.strictEqual((await stored(page)).fillers[4], 0);
  assert.match(await text(page, "#fbest"), /Best: 0/);
  // a round counted only by leaving the page is kept too
  await page.click("#fplus");
  await page.click("#fplus");
  await go(page, "home");
  assert.strictEqual((await stored(page)).fillers[4], 0);
});

test("teacher voice list offers at most three voices", async () => {
  const voices = [["Google US English", "en-US"], ["Google UK English Female", "en-GB"], ["Daniel", "en-GB"], ["Karen", "en-AU"], ["Aria Online (Natural) - English (United States)", "en-US"]]
    .map(([name, lang]) => ({ name, lang, localService: false }));
  const page = await open("lesson-1", { voices });
  const opts = await page.$$eval("#dvoice option", o => o.map(x => x.textContent));
  assert.ok(opts.length <= 3, opts.join(", "));
  assert.match(opts[0], /Heart/);
});

/* ---------- warm-up ---------- */
test("warm-up runs through every step on its own and finishes", async () => {
  const page = await open("warmup-express", { clock: true });
  await page.click("#wgo");
  assert.match(await text(page, "#wmeta"), /STEP 1 OF 3/);
  await page.clock.runFor(21000);
  assert.match(await text(page, "#wmeta"), /STEP 2 OF 3/);
  await page.clock.runFor(30000);
  assert.match(await text(page, "#wmeta"), /STEP 3 OF 3/);
  await page.clock.runFor(61000);
  assert.strictEqual(await text(page, "#wt"), "Warm-up done");
  assert.ok(await page.isDisabled("#wskip"));
  await page.click("#wgo");
  await page.waitForFunction(() => location.hash === "#home");
  assert.deepStrictEqual(page.errors, []);
});

test("warm-up: pause stops the countdown, skip moves on", async () => {
  const page = await open("warmup", { clock: true });
  await page.click("#wgo");
  await page.clock.runFor(3000);
  await page.click("#wgo");
  const t = await text(page, "#wclock");
  await page.clock.runFor(10000);
  assert.strictEqual(await text(page, "#wclock"), t);
  await page.click("#wskip");
  assert.match(await text(page, "#wmeta"), /STEP 2 OF 7/);
});

test("quick warm-up button on home starts the express routine right away", async () => {
  const page = await open("", { clock: true });
  await page.click("#qx");
  await page.waitForFunction(() => location.hash === "#warmup-express");
  assert.strictEqual(await text(page, "#wgo"), "Pause");
});

/* ---------- kids ---------- */
test("kids: 5 sentences, timer, and the star shows up in the total", async () => {
  const page = await open("kids-3", { clock: true });
  assert.strictEqual(await page.locator(".kline").count(), 5);
  await page.click("#kgo");
  await page.clock.runFor(21000); // 20 s task
  assert.strictEqual(await text(page, "#kgo"), "Again");
  assert.strictEqual(await text(page, "#kclock"), "0:00"); // time's up stays visible
  await page.click("#kgo"); // "Again" starts a fresh round
  assert.strictEqual(await text(page, "#kclock"), "0:20");
  await page.clock.runFor(1000);
  assert.strictEqual(await text(page, "#kclock"), "0:19");
  await page.click("#kreset");
  await page.click("#kstar");
  await go(page, "kids");
  assert.match(await text(page, ".starbox"), /^1\/22/);
});

test("pronunciation games: words play and the star is saved", async () => {
  const page = await open("sound-4");
  const reqs = [];
  page.on("request", r => { if (r.url().includes("/audio/")) reqs.push(r.url().split("/audio/")[1]); });
  await page.click(".pword[data-a='p4-w2']");
  await page.waitForTimeout(150);
  assert.ok(reqs.includes("p4-w2.mp3"));
  await page.click("#pstar");
  assert.strictEqual((await stored(page)).pron[3], true);
});

/* ---------- progress ---------- */
test("practice days build a streak", async () => {
  const d = n => { const x = new Date(); x.setDate(x.getDate() - n); return x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getDate()).padStart(2, "0"); };
  const page = await open("", { state: { days: [d(1), d(2), d(3)] } });
  assert.strictEqual(await text(page, ".streak"), "3 day streak");
  await go(page, "lesson-1");
  await page.click("#done");
  assert.strictEqual(await text(page, ".streak"), "4 day streak");
});

test("backup: save a file and restore it on a fresh device", async () => {
  const page = await open("about", { state: { done: { 0: true, 5: true }, kids: { 2: true }, days: ["2026-01-02"] } });
  assert.match(await text(page, "#app"), /2 of 29 lessons, 1 of 12 kids' stars, 1 practice day/);
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#bsave")]);
  const file = await download.path();
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(saved.app, "spok");

  const fresh = await open("about");
  await fresh.setInputFiles("#bload", file);
  await fresh.waitForFunction(() => /restored/.test(document.querySelector("#bstat").textContent));
  assert.deepStrictEqual((await stored(fresh)).done, { 0: true, 5: true });

  const bad = path.join(path.dirname(file), "not-spok.json");
  fs.writeFileSync(bad, '{"hello":1}');
  await fresh.setInputFiles("#bload", bad);
  await fresh.waitForFunction(() => /isn't a Spok backup/.test(document.querySelector("#bstat").textContent));
  assert.deepStrictEqual((await stored(fresh)).done, { 0: true, 5: true });
  assert.deepStrictEqual(fresh.errors, []);
});

test("feedback form asks for a message before opening email", async () => {
  const page = await open("about");
  await page.click("#fsend");
  assert.match(await text(page, "#fstat"), /Write a message first/);
});

/* ---------- accessibility ---------- */
test("no accessibility violations (axe-core) in light and dark mode", async () => {
  let axe;
  try { axe = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8"); } catch (e) { console.log("    (skipped: npm install to get axe-core)"); return; }
  for (const scheme of ["light", "dark"]) {
    const page = await open();
    await page.emulateMedia({ colorScheme: scheme });
    for (const r of ["home", "lesson-1", "lesson-12", "lesson-20", "lesson-27", "warmup", "kids", "kids-2", "sound-1", "about"]) {
      await go(page, r);
      if (r === "home") await page.$$eval(".mtop[aria-expanded='false']", bs => bs.forEach(b => b.click()));
      await page.addScriptTag({ content: axe });
      const res = await page.evaluate(() => axe.run(document, { resultTypes: ["violations"] }));
      assert.deepStrictEqual(res.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(" ")).slice(0, 3).join(", ")}`), [], `${scheme} ${r}`);
    }
  }
});

(async () => {
  const server = await serve();
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ✓ ${t.name}`); }
    catch (e) { failed++; console.log(`  ✗ ${t.name}\n      ${String(e.message).split("\n").join("\n      ")}`); }
  }
  await browser.close();
  server.close();
  console.log(failed ? `e2e: ${failed} of ${tests.length} failed` : `e2e: all ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
