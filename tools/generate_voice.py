#!/usr/bin/env python3
"""Generate the natural "Heart" voice clips for Spok's drill lines.

Every drill line in index.html (adult lessons: l<lesson>-<line>, kids lessons:
k<lesson>-<line>) can have a recorded clip in audio/ plus word start times in
the TIMING table, which the app uses to highlight each word as it is spoken.
Lines without a clip are read by the device voice instead.

This script finds the lines that have no clip yet, synthesises them with
Kokoro (voice af_heart), saves them as MP3 files matching the existing ones
(24 kHz, mono, 64 kbit/s), writes their word timings into index.html and
refreshes the offline file list in sw.js.

Setup (once):
    python3 -m venv .venv && . .venv/bin/activate
    pip install "kokoro>=0.9.4"
    # also needed: ffmpeg, and espeak-ng (recommended by Kokoro for rare words)

Usage, from the repository root:
    python3 tools/generate_voice.py            # only lines that are missing
    python3 tools/generate_voice.py --list     # show what would be generated
    python3 tools/generate_voice.py --only l4-4,k2-5   # (re)generate these clips

The first run downloads the Kokoro model (about 330 MB) from Hugging Face.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import shutil

SAMPLE_RATE = 24000
VOICE = "af_heart"
SPEED = 1.0
PAUSE_SECONDS = 0.8  # silence spoken for each "(pause)" cue, as in the existing clips
PAUSE = "(pause)"


# ---------- reading the lines from index.html ----------

def drill_lines(html):
    """Return {clip_name: display_text} for every adult and kids drill line, in app order."""
    script = html.split("<script>", 1)[1]
    out = {}
    for key, prefix in (("drill:[", "l"), ("say:[", "k")):
        for n, m in enumerate(re.finditer(re.escape(key) + r'(.*?")\]', script), start=1):
            for j, text in enumerate(json.loads("[" + m.group(1) + "]"), start=1):
                out[f"{prefix}{n}-{j}"] = text
    return out


def read_timing(html):
    m = re.search(r"const TIMING=(\{.*?\});", html)
    if not m:
        sys.exit("TIMING table not found in index.html")
    return json.loads(m.group(1))


def write_timing(html, timing):
    def natural(k):
        return [int(x) if x.isdigit() else x for x in re.split(r"(\d+)", k)]
    ordered = {k: timing[k] for k in sorted(timing, key=natural)}
    return re.sub(r"const TIMING=\{.*?\};",
                  lambda _: "const TIMING=" + json.dumps(ordered, separators=(",", ":")) + ";",
                  html, count=1)


# ---------- text and timings ----------

def norm(s):
    return re.sub(r"[^a-z0-9]", "", s.lower())


def spoken(token):
    """How a displayed token is said: cue brackets are dropped, a blank (____) is read as "name"."""
    return token.replace("[", "").replace("]", "").replace("____", "name")


def segments(display):
    """Split a line at its (pause) cues: [[tokens...], [tokens...], ...]."""
    segs, cur = [], []
    for tok in display.split():
        if tok == PAUSE:
            segs.append(cur)
            cur = []
        else:
            cur.append(tok)
    segs.append(cur)
    return segs


def align(tokens, words, seg_start, seg_end):
    """Start time for each displayed token from Kokoro's word timestamps.

    `words` is a list of (text, start_seconds) from Kokoro, already offset to
    the clip. Tokens are matched by their letters and digits, so differences in
    how punctuation or contractions are split do not matter. If the words do
    not line up, times are spread by token length instead (and a warning is
    printed), which is close enough for highlighting.
    """
    starts, k = [], 0
    for tok in tokens:
        need = norm(spoken(tok))
        if not need:
            starts.append(starts[-1] if starts else seg_start)
            continue
        got, first = "", None
        while k < len(words) and len(got) < len(need):
            text, st = words[k]
            if norm(text):
                got += norm(text)
                if first is None and st is not None:
                    first = st
            k += 1
        if got != need or first is None:
            return None
        starts.append(first)
    return starts


def spread(tokens, seg_start, seg_end):
    weights = [max(1, len(norm(spoken(t)))) + 1 for t in tokens]
    total, acc, out = sum(weights), 0, []
    for w in weights:
        out.append(seg_start + (seg_end - seg_start) * acc / total)
        acc += w
    return out


# ---------- synthesis ----------

def synthesize(pipeline, display):
    """Return (samples, starts) for one line: one start time per displayed token."""
    import numpy as np

    audio, starts, t = [], [], 0.0
    segs = segments(display)
    for si, seg in enumerate(segs):
        if si > 0:  # the (pause) cue lights up during the silence
            starts.append(t)
            audio.append(np.zeros(int(PAUSE_SECONDS * SAMPLE_RATE), dtype=np.float32))
            t += PAUSE_SECONDS
        if not seg:
            continue
        seg_start, words = t, []
        for result in pipeline(" ".join(spoken(x) for x in seg), voice=VOICE, speed=SPEED, split_pattern=None):
            chunk = result.audio
            chunk = chunk.cpu().numpy() if hasattr(chunk, "cpu") else np.asarray(chunk)
            for tk in result.tokens or []:
                st = getattr(tk, "start_ts", None)
                words.append((tk.text, None if st is None else t + st))
            audio.append(chunk.astype(np.float32))
            t += len(chunk) / SAMPLE_RATE
        got = align(seg, words, seg_start, t)
        if got is None:
            print(f"   ! word timings did not line up for: {' '.join(seg)!r}; spreading evenly")
            got = spread(seg, seg_start, t)
        starts.extend(got)
    starts = [round(x, 2) for x in starts]
    if starts:
        starts[0] = 0.0
    for i in range(1, len(starts)):  # keep them in order
        starts[i] = max(starts[i], starts[i - 1])
    return np.concatenate(audio), starts


def save_mp3(samples, path):
    """Encode float samples to MP3 with ffmpeg, matching the existing clips."""
    import numpy as np

    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "f32le", "-ar", str(SAMPLE_RATE), "-ac", "1",
                    "-i", "pipe:0", "-ar", str(SAMPLE_RATE), "-ac", "1", "-b:a", "64k", path],
                   input=np.asarray(samples, dtype="<f4").tobytes(), check=True)


# ---------- service worker ----------

def update_sw(sw, audio_files):
    assets = "', '".join(["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png"])
    audio = ",".join(f"'./audio/{f}'" for f in sorted(audio_files))
    sw = re.sub(r"const ASSETS = \[.*?\];", lambda _: f"const ASSETS = ['{assets}',\n  {audio}];", sw, count=1, flags=re.S)
    return re.sub(r"spok-v(\d+)", lambda m: f"spok-v{int(m.group(1)) + 1}", sw, count=1)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
    ap.add_argument("--only", help="comma-separated clip names to (re)generate, e.g. l4-4,k2-5")
    ap.add_argument("--list", action="store_true", help="only list the clips that would be generated")
    args = ap.parse_args()

    root = os.path.abspath(args.root)
    index_path, sw_path, audio_dir = (os.path.join(root, x) for x in ("index.html", "sw.js", "audio"))
    html = open(index_path, encoding="utf-8").read()
    lines, timing = drill_lines(html), read_timing(html)

    if args.only:
        todo = [x.strip() for x in args.only.split(",") if x.strip()]
        unknown = [x for x in todo if x not in lines]
        if unknown:
            sys.exit("Unknown clip names: " + ", ".join(unknown))
    else:
        todo = [n for n in lines if n not in timing or not os.path.exists(os.path.join(audio_dir, n + ".mp3"))]

    if not todo:
        print("Every drill line already has its Heart clip. Nothing to do.")
        return
    print(f"{len(todo)} clip(s) to generate:")
    for n in todo:
        print(f"  {n:7} {lines[n]}")
    if args.list:
        return

    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg is needed to save the MP3 files. Install it first (e.g. brew install ffmpeg / apt install ffmpeg).")
    try:
        from kokoro import KPipeline
    except ImportError:
        sys.exit('Kokoro is not installed. Run: pip install "kokoro>=0.9.4"')
    pipeline = KPipeline(lang_code="a")  # American English, the language of the af_heart voice

    for n in todo:
        samples, starts = synthesize(pipeline, lines[n])
        expected = len(lines[n].split())
        if len(starts) != expected:
            sys.exit(f"{n}: got {len(starts)} word times for {expected} words; stopping so nothing is saved half-done")
        save_mp3(samples, os.path.join(audio_dir, n + ".mp3"))
        timing[n] = starts
        print(f"  ok {n}  {len(samples) / SAMPLE_RATE:.2f}s")
        # save as we go, so an interrupted run keeps the clips it finished
        open(index_path, "w", encoding="utf-8").write(write_timing(html, timing))

    audio_files = [f for f in os.listdir(audio_dir) if f.endswith(".mp3")]
    sw = open(sw_path, encoding="utf-8").read()
    open(sw_path, "w", encoding="utf-8").write(update_sw(sw, audio_files))
    print(f"Done. index.html timings and sw.js offline list updated ({len(audio_files)} audio files).")


if __name__ == "__main__":
    main()
