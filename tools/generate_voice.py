#!/usr/bin/env python3
"""Generate the natural "Heart" voice clips for Spok's drill lines.

Every drill line in index.html (adult lessons: l<lesson>-<line>, kids lessons:
k<lesson>-<line>) can have a recorded clip in audio/ plus word start times in
the TIMING table, which the app uses to highlight each word as it is spoken.
Lines without a clip are read by the device voice instead.

This script finds the lines that have no clip yet, synthesises them with
Kokoro (voice af_heart), saves them as MP3 files matching the existing ones,
writes their word timings into index.html and refreshes the offline file list
in sw.js. The settings below were calibrated on the existing clips: same
speaking pace (adults 0.9, kids 0.85), same trimmed silence, same format
(24 kHz, mono, 64 kbit/s) and an 0.8 s silence for each "(pause)" cue.

Two ways to run Kokoro (ffmpeg is needed for both):

  A. The official package (downloads the model from Hugging Face):
       pip install "kokoro>=0.9.4"
       python3 tools/generate_voice.py

  B. The ONNX model from GitHub (no Hugging Face needed):
       pip install onnxruntime onnx kokoro-onnx "misaki[en]"
       pip install https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl
       # put kokoro-v1.0.onnx and voices-v1.0.bin from
       # https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.0 in one folder, then:
       python3 tools/generate_voice.py --onnx-dir path/to/that/folder

Other options:
    --list               show which clips would be generated, and stop
    --only l4-4,k2-5     (re)generate exactly these clips
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys

SAMPLE_RATE = 24000
VOICE = "af_heart"
SPEED = {"l": 0.9, "k": 0.85}  # adults, kids: matches the pace of the existing clips
LEAD_SECONDS = 0.04            # silence kept before the first word
TAIL_SECONDS = 0.12            # silence kept after the last word
PAUSE_SECONDS = 0.8            # from the start of a "(pause)" cue to the next word
PAUSE = "(pause)"
MAX_PEAK = 0.9                 # the existing clips peak at about 0.93
# kokoro.KPipeline reports each word 3 duration frames (3 x 25 ms) before its first phoneme; undo that
OFFICIAL_TS_SHIFT = 3 * 600 / SAMPLE_RATE


# ---------- reading and writing index.html / sw.js ----------

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


def update_sw(sw, audio_files):
    """List every audio file for offline use and bump the cache name so phones fetch the new files."""
    assets = "', '".join(["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png"])
    audio = ",".join(f"'./audio/{f}'" for f in sorted(audio_files))
    sw = re.sub(r"const ASSETS = \[.*?\];", lambda _: f"const ASSETS = ['{assets}',\n  {audio}];", sw, count=1, flags=re.S)
    return re.sub(r"spok-v(\d+)", lambda m: f"spok-v{int(m.group(1)) + 1}", sw, count=1)


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


def align(tokens, words):
    """Start time for each displayed token from Kokoro's word timestamps, or None if they don't line up.

    `words` is a list of (text, start_seconds). Tokens are matched by their
    letters and digits, so punctuation and contractions ("I'm" -> "I", "'m")
    split differently by Kokoro still line up.
    """
    starts, k = [], 0
    for tok in tokens:
        need = norm(spoken(tok))
        if not need:
            starts.append(starts[-1] if starts else None)
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
    return starts if None not in starts else None


def spread(tokens, start, end):
    """Fallback: spread start times over the speech by word length."""
    weights = [max(1, len(norm(spoken(t)))) + 1 for t in tokens]
    total, acc, out = sum(weights), 0, []
    for w in weights:
        out.append(start + (end - start) * acc / total)
        acc += w
    return out


def speech_span(samples, threshold=0.01):
    """First and last sample where the voice is audible (10 ms RMS above threshold)."""
    import numpy as np

    w = SAMPLE_RATE // 100
    if len(samples) < w:
        return 0, len(samples)
    energy = np.sqrt(np.convolve(samples ** 2, np.ones(w) / w, "same"))
    loud = np.where(energy > threshold)[0]
    return (int(loud[0]), int(loud[-1]) + 1) if len(loud) else (0, len(samples))


# ---------- synthesis ----------

def run_kokoro(pipeline, text, speed):
    """Synthesise one piece of text: (samples, [(word, start_seconds), ...])."""
    import numpy as np

    audio, words, t = [], [], 0.0
    shift = 0.0 if getattr(pipeline, "exact_timestamps", False) else OFFICIAL_TS_SHIFT
    for result in pipeline(text, voice=VOICE, speed=speed, split_pattern=None):
        chunk = result.audio
        chunk = chunk.cpu().numpy() if hasattr(chunk, "cpu") else np.asarray(chunk)
        for tk in result.tokens or []:
            st = getattr(tk, "start_ts", None)
            words.append((tk.text, None if st is None else t + st + shift))
        audio.append(chunk.astype(np.float32).reshape(-1))
        t += len(audio[-1]) / SAMPLE_RATE
    return np.concatenate(audio), words


def synthesize(pipeline, display, speed):
    """Return (samples, starts) for one line, with one start time per displayed token."""
    import numpy as np

    out, starts, t, prev_end = [], [], 0.0, 0.0

    def add(samples):
        nonlocal t
        out.append(samples)
        t += len(samples) / SAMPLE_RATE

    for si, seg in enumerate(segments(display)):
        if si > 0:
            # the "(pause)" cue lights up when the voice stops; the next words follow 0.8 s later
            starts.append(prev_end)
            add(np.zeros(max(0, int(round((prev_end + PAUSE_SECONDS - t) * SAMPLE_RATE))), dtype=np.float32))
        if not seg:
            continue
        raw, words = run_kokoro(pipeline, " ".join(spoken(x) for x in seg), speed)
        a, b = speech_span(raw)
        cut = max(0, a - int(LEAD_SECONDS * SAMPLE_RATE)) if si == 0 else a
        offset = t - cut / SAMPLE_RATE  # output time of raw sample 0
        speech_start = t + (a - cut) / SAMPLE_RATE
        add(raw[cut:b])
        prev_end = t
        got = align(seg, [(w, None if s is None else s + offset) for w, s in words])
        if got is None:
            print(f"   ! word timings did not line up for {' '.join(seg)!r}; spreading them evenly")
            got = spread(seg, speech_start, prev_end)
        starts.extend(got)
    add(np.zeros(int(TAIL_SECONDS * SAMPLE_RATE), dtype=np.float32))
    samples = np.concatenate(out)
    peak = float(np.abs(samples).max()) if len(samples) else 0.0
    if peak > MAX_PEAK:  # turn the whole clip down a little rather than let MP3 encoding clip it
        samples = samples * (MAX_PEAK / peak)

    starts = [round(max(0.0, x), 2) for x in starts]
    if starts:
        starts[0] = 0.0
    for i in range(1, len(starts)):  # keep them in order
        starts[i] = max(starts[i], starts[i - 1])
    return samples, starts


def save_mp3(samples, path):
    """Encode float samples to MP3 with ffmpeg, in the same format as the existing clips."""
    import numpy as np

    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "f32le", "-ar", str(SAMPLE_RATE), "-ac", "1",
                    "-i", "pipe:0", "-ar", str(SAMPLE_RATE), "-ac", "1", "-b:a", "64k", path],
                   input=np.asarray(samples, dtype="<f4").tobytes(), check=True)


# ---------- Kokoro through ONNX (option B) ----------

class OnnxPipeline:
    """Kokoro v1.0 through onnxruntime, with the same G2P (misaki) and word timestamps as kokoro.KPipeline.

    The published ONNX model only returns audio, so on first use a copy is
    saved that also returns the predicted duration of each phoneme (in frames
    of 600 samples). A word starts where the frames of its first phoneme start.
    """
    DURATIONS = "/encoder/Clip_output_0"
    FRAME = 600
    exact_timestamps = True

    class Token:
        def __init__(self, text, start_ts):
            self.text, self.start_ts = text, start_ts

    class Result:
        def __init__(self, audio, tokens):
            self.audio, self.tokens = audio, tokens

    def __init__(self, model_dir):
        import numpy as np
        import onnxruntime
        import kokoro_onnx
        from misaki import en, espeak

        src = os.path.join(model_dir, "kokoro-v1.0.onnx")
        patched = os.path.join(model_dir, "kokoro-v1.0-durations.onnx")
        if not os.path.exists(patched):
            import onnx
            print("Preparing the model to report phoneme durations (once)...")
            model = onnx.load(src)
            model.graph.output.append(onnx.helper.make_tensor_value_info(self.DURATIONS, onnx.TensorProto.FLOAT, None))
            onnx.save(model, patched)
        config = os.path.join(os.path.dirname(kokoro_onnx.__file__), "config.json")
        self.vocab = json.load(open(config, encoding="utf-8"))["vocab"]
        self.voices = np.load(os.path.join(model_dir, "voices-v1.0.bin"))
        self.session = onnxruntime.InferenceSession(patched)
        self.g2p = en.G2P(trf=False, british=False, fallback=espeak.EspeakFallback(british=False))

    def __call__(self, text, voice, speed=1.0, split_pattern=None):
        import numpy as np

        _, tokens = self.g2p(text)
        ps = "".join((t.phonemes or "") + (" " if t.whitespace else "") for t in tokens).strip()
        ids = [self.vocab[p] for p in ps if p in self.vocab]
        if len(ids) != len(ps):
            raise ValueError(f"unknown phonemes in {ps!r}")
        style = self.voices[voice][len(ps) - 1].reshape(1, 256).astype(np.float32)
        audio, dur = self.session.run(None, {"tokens": np.array([[0, *ids, 0]], dtype=np.int64), "style": style,
                                             "speed": np.array([speed], dtype=np.float32)})
        yield self.Result(audio.reshape(-1), self._timestamps(tokens, dur.reshape(-1).astype(int)))

    def _timestamps(self, tokens, d):
        """Start time of each token: the frames before its first phoneme (d[0] is the start padding)."""
        import numpy as np

        before = np.concatenate([[0], np.cumsum(d)])  # before[i] = frames before position i
        out, i = [], 1
        for t in tokens:
            start = None
            if t.phonemes and i < len(d) - 1:
                start = before[i] * self.FRAME / SAMPLE_RATE
                i += len(t.phonemes)
            if t.whitespace:
                i += 1
            out.append(self.Token(t.text, start))
        return out


def make_pipeline(onnx_dir):
    if onnx_dir:
        try:
            return OnnxPipeline(onnx_dir)
        except ImportError as e:
            sys.exit(f"Missing package for the ONNX engine ({e.name}). See the setup notes at the top of this file.")
    try:
        from kokoro import KPipeline
    except ImportError:
        sys.exit('Kokoro is not installed. Run: pip install "kokoro>=0.9.4"  (or use --onnx-dir, see the top of this file)')
    return KPipeline(lang_code="a")  # American English, the language of the af_heart voice


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
    ap.add_argument("--only", help="comma-separated clip names to (re)generate, e.g. l4-4,k2-5")
    ap.add_argument("--list", action="store_true", help="only list the clips that would be generated")
    ap.add_argument("--onnx-dir", help="folder with kokoro-v1.0.onnx and voices-v1.0.bin (option B)")
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
    pipeline = make_pipeline(args.onnx_dir)

    for n in todo:
        samples, starts = synthesize(pipeline, lines[n], SPEED[n[0]])
        expected = len(lines[n].split())
        if len(starts) != expected:
            sys.exit(f"{n}: got {len(starts)} word times for {expected} words; stopping so nothing is saved half-done")
        save_mp3(samples, os.path.join(audio_dir, n + ".mp3"))
        timing[n] = starts
        print(f"  ok {n:7} {len(samples) / SAMPLE_RATE:.2f}s")
        # save as we go, so an interrupted run keeps the clips it finished
        open(index_path, "w", encoding="utf-8").write(write_timing(html, timing))

    audio_files = [f for f in os.listdir(audio_dir) if f.endswith(".mp3")]
    sw = open(sw_path, encoding="utf-8").read()
    open(sw_path, "w", encoding="utf-8").write(update_sw(sw, audio_files))
    print(f"Done. index.html timings and sw.js offline list updated ({len(audio_files)} audio files).")


if __name__ == "__main__":
    main()
