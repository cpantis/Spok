# Spok

Free voice and interview practice app: 29 short lessons, a 20-minute "interview tomorrow" plan, a warm-up, lessons for kids and pronunciation games for Romanian children. Every practice line can be recorded and compared with the model voice, back to back. It is a static web app (one `index.html`, a service worker for offline use and the recorded "Heart" voice clips in `audio/`), so any static host can serve it.

## Run locally

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000. Recording needs `https` or `localhost`.

## Tests

```bash
npm install
npm test
```

`tests/data.test.js` checks the content (every line has its audio and word timings, the offline list matches the files). `tests/e2e.test.js` drives the app in Chromium at phone size: every page, timers, warm-up, the interview plan, recording and comparing with the model (fake microphone), kids lessons, progress backup and an accessibility audit (axe-core).

## Adding or changing drill lines

Edit the `drill` (lessons) or `say` (kids) lists in `index.html`, then generate the voice for the new lines:

```bash
python3 tools/generate_voice.py
```

The script makes the missing clips, writes their word timings into `index.html` and updates the offline list in `sw.js`. Setup notes are at the top of the script. Run `npm test` afterwards.
