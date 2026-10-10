"""Scores every clip under samples/ with every detector and prints a summary.

Run from voice-captcha/:  .venv/bin/python tools/evaluate.py [--codec opus] [--out results.json]

--codec opus sends each clip through the browser's recording format (WebM/Opus at
32 kbit/s) first, which is what the detectors see in the real captcha.
"""
import argparse
import json
import subprocess
import sys
import tempfile
from collections import defaultdict
from pathlib import Path

import soundfile as sf

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import detectors  # noqa: E402

THRESHOLD = 0.5
MIN_SECONDS = 0.5  # skips empty and near-empty clips


def read(path, codec):
    if codec == "opus":
        with tempfile.TemporaryDirectory() as tmp:
            webm, wav = Path(tmp) / "a.webm", Path(tmp) / "a.wav"
            quiet = ["ffmpeg", "-y", "-loglevel", "error"]
            subprocess.run([*quiet, "-i", str(path), "-c:a", "libopus", "-b:a", "32k", str(webm)], check=True)
            subprocess.run([*quiet, "-i", str(webm), "-ac", "1", "-ar", "16000", str(wav)], check=True)
            return sf.read(wav, dtype="float32")[0]
    return sf.read(path, dtype="float32")[0]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--codec", choices=["none", "opus"], default="none")
    parser.add_argument("--out")
    args = parser.parse_args()

    models = detectors.load()
    rows = []
    for path in sorted((ROOT / "samples").rglob("*.wav")):
        group = str(path.parent.relative_to(ROOT / "samples"))
        if sf.info(path).duration < MIN_SECONDS:
            continue
        audio = read(path, args.codec)
        scores = {name: round(model.synthetic_probability(audio), 4) for name, model in models.items()}
        rows.append({"group": group, "file": path.name, "seconds": round(len(audio) / 16000, 1), **scores})

    # Per group: how many clips each detector called synthetic, and the mean score.
    groups = defaultdict(list)
    for row in rows:
        groups[row["group"]].append(row)
    print(f"codec={args.codec}  threshold={THRESHOLD}  (cells: clips called synthetic / total, mean score)")
    print(f"{'group':28}" + "".join(f"{name:>19}" for name in models))
    for group, members in sorted(groups.items()):
        cells = []
        for name in models:
            flagged = sum(r[name] >= THRESHOLD for r in members)
            mean = sum(r[name] for r in members) / len(members)
            cells.append(f"{flagged:>2}/{len(members):<2} {mean:.2f}".rjust(19))
        print(f"{group:28}" + "".join(cells))

    if args.out:
        Path(args.out).write_text(json.dumps(rows, indent=1))


if __name__ == "__main__":
    main()
