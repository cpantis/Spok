// Content checks: every line the app can play has its audio and word timings,
// and the offline list in sw.js matches the files that exist.
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const script = html.split("<script>")[1].split("</script>")[0];
const data = script.slice(0, script.indexOf("const APP_VERSION"));
const { MODULES, LESSONS, WARMUP, KIDS, PRON } = new Function(data + ";return {MODULES,LESSONS,WARMUP,KIDS,PRON};")();
const TIMING = JSON.parse(script.match(/const TIMING=(\{.*?\});/)[1]);
const audio = new Set(fs.readdirSync(path.join(root, "audio")).filter(f => f.endsWith(".mp3")).map(f => f.slice(0, -4)));

const errors = [];
const check = (ok, msg) => { if (!ok) errors.push(msg); };
const used = new Set();
const words = s => s.split(/\s+/).filter(Boolean).length;
function clip(name, text) {
  used.add(name);
  check(audio.has(name), `missing audio/${name}.mp3`);
  if (text != null) {
    check(TIMING[name], `no word timings for ${name}`);
    if (TIMING[name]) {
      const t = TIMING[name];
      check(t.length === words(text), `${name}: ${t.length} timings for ${words(text)} words`);
      check(t.every((x, i) => i === 0 || x >= t[i - 1]), `${name}: timings out of order`);
    }
  }
}

const lessonKeys = ["mod", "t", "m", "goal", "ideas", "drill", "dtip", "prompt", "secs", "checks"];
LESSONS.forEach((L, i) => {
  lessonKeys.forEach(k => check(L[k] != null, `lesson ${i + 1} has no ${k}`));
  check(MODULES.some(m => m.id === L.mod), `lesson ${i + 1}: unknown module ${L.mod}`);
  check(L.drill.length >= 5, `lesson ${i + 1}: only ${L.drill.length} drill lines`);
  check(L.ideas.length >= 3 && L.checks.length >= 3, `lesson ${i + 1}: too few ideas or checks`);
  L.drill.forEach((d, j) => clip(`l${i + 1}-${j + 1}`, d));
});
MODULES.forEach(M => check(LESSONS.some(L => L.mod === M.id), `module ${M.id} has no lessons`));
WARMUP.forEach((w, i) => clip(`w${i + 1}`));
KIDS.forEach((K, i) => {
  ["t", "c", "badge", "why", "game", "say", "turn", "secs"].forEach(k => check(K[k] != null, `kids lesson ${i + 1} has no ${k}`));
  check(K.say.length >= 5, `kids lesson ${i + 1}: only ${K.say.length} lines`);
  K.say.forEach((s, j) => clip(`k${i + 1}-${j + 1}`, s));
  clip(`ki${i + 1}`);
  clip(`kt${i + 1}`);
});
PRON.forEach((P, i) => {
  const n = i + 1;
  P.words.forEach((w, j) => clip(`p${n}-w${j + 1}`));
  P.pairs.forEach((p, j) => { clip(`p${n}-a${j + 1}`); clip(`p${n}-b${j + 1}`); });
  clip(`p${n}-s`, P.sentence);
});
for (const a of audio) check(used.has(a), `audio/${a}.mp3 is not used by any lesson`);
for (const k of Object.keys(TIMING)) check(used.has(k), `TIMING has an entry for unknown clip ${k}`);

// offline cache list = core files + every audio file
const sw = fs.readFileSync(path.join(root, "sw.js"), "utf8");
const assets = new Function(sw.match(/const ASSETS = (\[.*?\]);/s)[0] + ";return ASSETS;")();
const swAudio = assets.filter(a => a.startsWith("./audio/")).map(a => a.slice(8, -4));
check(swAudio.length === audio.size && swAudio.every(a => audio.has(a)), "sw.js ASSETS does not list exactly the files in audio/");
assets.filter(a => !a.startsWith("./audio/") && a !== "./").forEach(a => check(fs.existsSync(path.join(root, a)), `sw.js lists missing file ${a}`));

const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
manifest.icons.forEach(ic => check(fs.existsSync(path.join(root, ic.src)), `manifest icon ${ic.src} missing`));
check(manifest.description.includes(String(LESSONS.length)), "manifest description has the wrong lesson count");
check(html.includes(`${LESSONS.length} lessons`) || html.includes(`${LESSONS.length} short lessons`), "page description has the wrong lesson count");

if (errors.length) {
  console.error(`data: ${errors.length} problem(s)\n  ` + errors.join("\n  "));
  process.exit(1);
}
assert.ok(true);
console.log(`data: ok (${LESSONS.length} lessons, ${KIDS.length} kids lessons, ${PRON.length} sounds, ${audio.size} audio files)`);
