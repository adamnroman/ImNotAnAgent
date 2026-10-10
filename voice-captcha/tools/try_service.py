"""Exercises the running service end to end with browser-format (WebM/Opus) uploads.

Run from voice-captcha/ with server.py running:  .venv/bin/python tools/try_service.py

Covers: TTS engines reading the real challenge phrase, real human recordings (which say
something else, so they test the voice score and the phrase rejection), and token reuse.
Nobody has spoken into a microphone here; that path needs a person.
"""
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = "http://127.0.0.1:8790"
STARTED = time.time() - 1


def curl(*args):
    out = subprocess.run(["curl", "-s", "-w", "\n%{http_code}", *args], capture_output=True, text=True).stdout
    body, _, status = out.rpartition("\n")
    return int(status), json.loads(body)


def as_webm(src, dst):
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-t", "10", "-c:a", "libopus", "-b:a", "32k", str(dst)],
        check=True,
    )


def speak(engine, text, out):
    if engine == "say":
        subprocess.run(["say", "-v", "Samantha", "-o", str(out.with_suffix(".aiff")), text], check=True)
        return out.with_suffix(".aiff")
    if engine == "piper":
        subprocess.run(
            [sys.executable, "-m", "piper", "-m", str(ROOT / "models" / "en_US-lessac-medium.onnx"), "-f", str(out)],
            input=text.encode(), check=True, capture_output=True,
        )
        return out
    import soundfile as sf
    from kokoro_onnx import Kokoro

    kokoro = Kokoro(str(ROOT / "models" / "kokoro-v1.0.onnx"), str(ROOT / "models" / "voices-v1.0.bin"))
    audio, rate = kokoro.create(text, voice="af_heart", speed=1.0, lang="en-us")
    sf.write(out, audio, rate)
    return out


def submit(token, webm):
    return curl("-X", "POST", f"{BASE}/api/verify", "-F", f"token={token}", "-F", f"audio=@{webm}")


def show(label, status, data):
    keys = ["passed", "phraseOk", "voiceOk", "heard", "phraseMatch", "syntheticProbability", "detectors", "detail"]
    print(f"{label:34} {status} " + json.dumps({k: data[k] for k in keys if k in data}))


with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)

    for engine in ["say", "piper", "kokoro"]:
        _, challenge = curl("-X", "POST", f"{BASE}/api/challenge")
        spoken = speak(engine, challenge["phrase"], tmp / f"{engine}.wav")
        as_webm(spoken, tmp / f"{engine}.webm")
        status, data = submit(challenge["token"], tmp / f"{engine}.webm")
        show(f"TTS {engine} reads the phrase", status, data)
        if engine == "say":
            status, data = submit(challenge["token"], tmp / "say.webm")
            show("same token again", status, data)
            status, data = submit(challenge["token"][:-1] + "0", tmp / "say.webm")
            show("tampered token", status, data)

    for wav in sorted((ROOT / "samples" / "human").rglob("*.wav")):
        _, challenge = curl("-X", "POST", f"{BASE}/api/challenge")
        as_webm(wav, tmp / "human.webm")
        status, data = submit(challenge["token"], tmp / "human.webm")
        show(f"human clip {wav.stem}", status, data)

# These uploads were test clips, not microphone recordings; keep samples/mic for real ones.
for leftover in (ROOT / "samples" / "mic").glob("*"):
    if leftover.stat().st_mtime >= STARTED:
        leftover.unlink()
