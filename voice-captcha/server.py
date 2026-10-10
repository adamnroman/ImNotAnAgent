"""Voice captcha prototype: say a one-time phrase, get a human-vs-synthetic score.

Run from voice-captcha/:  .venv/bin/python server.py   then open http://localhost:8790

  POST /api/challenge -> a one-time phrase ("I am human" plus three random words) and a signed token
  POST /api/verify    -> transcript check (Whisper) and synthetic-voice scores (see detectors.py)

Local prototype only: one process, challenges tracked in memory.
"""
import hashlib
import hmac
import json
import re
import secrets
import subprocess
import tempfile
import time
from base64 import urlsafe_b64decode, urlsafe_b64encode
from difflib import SequenceMatcher
from pathlib import Path

import soundfile as sf
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from transformers import pipeline

import detectors

PORT = 8790
HERE = Path(__file__).parent

BASE_PHRASE = "I am human"
WORDS = (
    "amber anchor apple basket candle canyon copper dolphin falcon forest garden hammer harbor "
    "island jacket ladder lemon marble meadow mirror orange paper pepper planet pocket rabbit "
    "river rocket saddle silver spider summer thunder ticket tunnel velvet window winter yellow"
).split()
CHALLENGE_TTL_S = 60
MAX_UPLOAD_BYTES = 2_000_000
MIN_SECONDS, MAX_SECONDS = 1.5, 12.0
PHRASE_MATCH_NEEDED = 0.85  # share of the expected words Whisper must hear, in order
# The verdict comes from one detector; the other is reported alongside for comparison.
# On the sample set (tools/evaluate.py --codec opus) forensics_base at 0.2 flagged 1 of 42
# human clips and missed 2 of 48 TTS clips. Its model card also suggests 0.1-0.2.
VERDICT_DETECTOR = "forensics_base"
SYNTHETIC_THRESHOLD = 0.2
ACTIVE_DETECTORS = [VERDICT_DETECTOR, "spectra_aasist3"]
# Every upload is kept here with its scores, so detectors can be compared on real microphone audio.
RECORDINGS = HERE / "samples" / "mic"

SECRET = secrets.token_bytes(32)  # new on every start, so old tokens die with the process
used_challenges = set()

print("Loading models…")
models = detectors.load(ACTIVE_DETECTORS)
transcriber = pipeline("automatic-speech-recognition", model="openai/whisper-base.en", device=detectors.DEVICE)
app = FastAPI()


def sign(payload):
    body = urlsafe_b64encode(json.dumps(payload).encode()).decode()
    return body + "." + hmac.new(SECRET, body.encode(), hashlib.sha256).hexdigest()


def unsign(token):
    body, _, signature = token.partition(".")
    expected = hmac.new(SECRET, body.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        return None
    return json.loads(urlsafe_b64decode(body))


def words(text):
    text = text.lower().replace("i'm", "i am").replace("i’m", "i am")  # Whisper often writes the contraction
    return re.sub(r"[^a-z ]", " ", text).split()


def phrase_match(expected, heard):
    """Share of the expected words that appear, in order, in what was heard."""
    want, got = words(expected), words(heard)
    matched = sum(block.size for block in SequenceMatcher(None, want, got).get_matching_blocks())
    return matched / len(want)


def decode(upload_bytes):
    """Any browser recording format -> 16 kHz mono float32."""
    with tempfile.TemporaryDirectory() as tmp:
        src, wav = Path(tmp) / "upload", Path(tmp) / "audio.wav"
        src.write_bytes(upload_bytes)
        done = subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-ac", "1", "-ar", "16000", str(wav)],
            capture_output=True,
        )
        if done.returncode != 0 or not wav.exists():
            raise HTTPException(400, "could not decode the recording")
        return sf.read(wav, dtype="float32")[0]


@app.get("/")
def page():
    return FileResponse(HERE / "index.html")


@app.post("/api/challenge")
def challenge():
    phrase = f"{BASE_PHRASE}. {' '.join(secrets.SystemRandom().sample(WORDS, 3))}."
    token = sign({"id": secrets.token_hex(8), "phrase": phrase, "expires": time.time() + CHALLENGE_TTL_S})
    return {"phrase": phrase, "token": token, "ttlSeconds": CHALLENGE_TTL_S}


@app.post("/api/verify")
async def verify(token: str = Form(...), audio: UploadFile = File(...)):
    payload = unsign(token)
    if payload is None:
        raise HTTPException(400, "invalid challenge")
    if payload["expires"] < time.time():
        raise HTTPException(400, "challenge expired")
    if payload["id"] in used_challenges:
        raise HTTPException(409, "challenge already used")

    data = await audio.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "recording too large")
    samples = decode(data)
    seconds = len(samples) / detectors.SAMPLE_RATE
    if not MIN_SECONDS <= seconds <= MAX_SECONDS:
        raise HTTPException(400, f"recording must be {MIN_SECONDS}-{MAX_SECONDS} seconds, got {seconds:.1f}")
    used_challenges.add(payload["id"])

    heard = transcriber({"raw": samples, "sampling_rate": detectors.SAMPLE_RATE})["text"].strip()
    match = phrase_match(payload["phrase"], heard)
    scores = {name: round(model.synthetic_probability(samples), 3) for name, model in models.items()}
    synthetic = scores[VERDICT_DETECTOR]

    phrase_ok = match >= PHRASE_MATCH_NEEDED
    voice_ok = synthetic < SYNTHETIC_THRESHOLD
    RECORDINGS.mkdir(parents=True, exist_ok=True)
    stem = RECORDINGS / time.strftime("%Y%m%d-%H%M%S")
    sf.write(f"{stem}.wav", samples, detectors.SAMPLE_RATE)
    Path(f"{stem}.json").write_text(json.dumps({"heard": heard, "phraseMatch": match, **scores}))
    return {
        "passed": phrase_ok and voice_ok,
        "phraseOk": phrase_ok,
        "voiceOk": voice_ok,
        "expected": payload["phrase"],
        "heard": heard,
        "phraseMatch": round(match, 2),
        "syntheticProbability": round(synthetic, 3),
        "syntheticThreshold": SYNTHETIC_THRESHOLD,
        "detectors": scores,
        "seconds": round(seconds, 1),
    }


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
