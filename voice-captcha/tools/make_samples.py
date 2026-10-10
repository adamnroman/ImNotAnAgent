"""Builds the evaluation set under samples/ as 16 kHz mono WAV.

  samples/synthetic/<engine>/...   macOS `say`, Piper and Kokoro reading the test phrases
  samples/human/<source>/...       real recordings pulled from public speech datasets
  samples/human_short/...          the same recordings cut to 3 s, to match a short captcha phrase

Run from voice-captcha/:  .venv/bin/python tools/make_samples.py
"""
import json
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SAMPLES = ROOT / "samples"
MODELS = ROOT / "models"

PHRASES = {
    "short": "I am human.",
    "challenge": "I am human. Amber, falcon, ninety two.",
    "long": "When you call someone who is thousands of miles away, you are using a satellite.",
}
SAY_VOICES = ["Samantha", "Daniel", "Karen", "Fred", "Reed (English (US))", "Flo (English (US))", "Shelley (English (US))"]
PIPER_VOICES = ["en_US-lessac-medium", "en_US-ryan-high", "en_GB-alan-medium"]
KOKORO_VOICES = ["af_heart", "af_bella", "am_michael", "am_fenrir", "bf_emma", "bm_george"]

# (name, dataset, config, split, row offsets)
HUMAN_SOURCES = [
    ("fleurs", "google/fleurs", "en_us", "validation", [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330]),
    ("librispeech", "hf-internal-testing/librispeech_asr_dummy", "clean", "validation", [0, 10, 20, 30, 40, 50]),
    ("ami_headset", "edinburghcstr/ami", "ihm", "validation", [5, 205, 405, 605, 805, 1005]),
    ("voxpopuli", "facebook/voxpopuli", "en", "validation", [0, 100, 200, 300, 400, 500]),
]


def to_wav(src, dst, extra=()):
    dst.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), *extra, "-ac", "1", "-ar", "16000", str(dst)],
        check=True,
    )


def make_say():
    for voice in SAY_VOICES:
        for key, text in PHRASES.items():
            out = SAMPLES / "synthetic" / "say" / f"{voice.split()[0]}_{key}.wav"
            if out.exists():
                continue
            tmp = out.with_suffix(".aiff")
            out.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(["say", "-v", voice, "-o", str(tmp), text], check=True)
            to_wav(tmp, out)
            tmp.unlink()


def make_piper():
    for voice in PIPER_VOICES:
        for key, text in PHRASES.items():
            out = SAMPLES / "synthetic" / "piper" / f"{voice}_{key}.wav"
            if out.exists():
                continue
            tmp = out.with_suffix(".raw.wav")
            out.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(
                [sys.executable, "-m", "piper", "-m", str(MODELS / f"{voice}.onnx"), "-f", str(tmp)],
                input=text.encode(), check=True, capture_output=True,
            )
            to_wav(tmp, out)
            tmp.unlink()


def make_kokoro():
    import soundfile as sf
    from kokoro_onnx import Kokoro

    kokoro = Kokoro(str(MODELS / "kokoro-v1.0.onnx"), str(MODELS / "voices-v1.0.bin"))
    for voice in KOKORO_VOICES:
        for key, text in PHRASES.items():
            out = SAMPLES / "synthetic" / "kokoro" / f"{voice}_{key}.wav"
            if out.exists():
                continue
            audio, rate = kokoro.create(text, voice=voice, speed=1.0, lang="en-gb" if voice[0] == "b" else "en-us")
            tmp = out.with_suffix(".raw.wav")
            out.parent.mkdir(parents=True, exist_ok=True)
            sf.write(tmp, audio, rate)
            to_wav(tmp, out)
            tmp.unlink()


def make_human():
    for name, dataset, config, split, offsets in HUMAN_SOURCES:
        for offset in offsets:
            out = SAMPLES / "human" / name / f"{name}_{offset}.wav"
            if out.exists():
                continue
            query = urllib.parse.urlencode({"dataset": dataset, "config": config, "split": split, "offset": offset, "length": 1})
            try:
                with urllib.request.urlopen(f"https://datasets-server.huggingface.co/rows?{query}", timeout=30) as res:
                    row = json.load(res)["rows"][0]["row"]
                tmp = out.with_suffix(".download")
                out.parent.mkdir(parents=True, exist_ok=True)
                urllib.request.urlretrieve(row["audio"][0]["src"], tmp)
                to_wav(tmp, out)
                tmp.unlink()
            except Exception as err:  # a dataset being unavailable should not stop the rest
                print(f"skipped {name} row {offset}: {err}")
    for wav in sorted((SAMPLES / "human").rglob("*.wav")):
        short = SAMPLES / "human_short" / wav.parent.name / wav.name
        if not short.exists():
            to_wav(wav, short, extra=("-ss", "0.5", "-t", "3"))


if __name__ == "__main__":
    make_say()
    make_piper()
    make_kokoro()
    make_human()
    for folder in sorted(p for p in SAMPLES.rglob("*") if p.is_dir() and any(p.glob("*.wav"))):
        print(f"{len(list(folder.glob('*.wav'))):3d}  {folder.relative_to(SAMPLES)}")
