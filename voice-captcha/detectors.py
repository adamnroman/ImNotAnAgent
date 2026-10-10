"""Open-source synthetic-speech detectors behind one interface.

Each detector takes 16 kHz mono float32 audio and returns the probability (0-1)
that the voice is synthetic. Models download from Hugging Face on first use.
"""
import contextlib
import importlib.util

import numpy as np
import torch
import transformers
from huggingface_hub import hf_hub_download
from safetensors.torch import load_file
from transformers import AutoFeatureExtractor, AutoModelForAudioClassification, pipeline

SAMPLE_RATE = 16000
DEVICE = "mps" if torch.backends.mps.is_available() else "cpu"


class Wav2Vec2Classifier:
    """Standard Hugging Face audio-classification checkpoints."""

    def __init__(self, repo, synthetic_label):
        self.extractor = AutoFeatureExtractor.from_pretrained(repo)
        self.model = AutoModelForAudioClassification.from_pretrained(repo).eval().to(DEVICE)
        labels = {v.lower(): int(k) for k, v in self.model.config.id2label.items()}
        self.synthetic_index = labels[synthetic_label]

    @torch.no_grad()
    def synthetic_probability(self, audio):
        inputs = self.extractor(audio, sampling_rate=SAMPLE_RATE, return_tensors="pt", padding=True)
        logits = self.model(**{k: v.to(DEVICE) for k, v in inputs.items()}).logits
        return torch.softmax(logits, dim=-1)[0, self.synthetic_index].item()


class DFArena:
    """Speech DF Arena model. Ships its own model code, hence trust_remote_code."""

    def __init__(self, repo, revision):
        self.pipe = pipeline("antispoofing", model=repo, revision=revision, trust_remote_code=True, device=DEVICE)

    def synthetic_probability(self, audio):
        return self.pipe(np.asarray(audio, dtype=np.float32))["all_scores"]["spoof"]


@contextlib.contextmanager
def _backbones_from_config():
    """These repos build their backbone with from_pretrained and then load a full checkpoint
    over it. Building from the config alone skips a 1.2 GB download of weights that get replaced."""
    originals = {}
    for cls in (transformers.Wav2Vec2Model, transformers.WavLMModel):
        originals[cls] = cls.from_pretrained
        cls.from_pretrained = classmethod(
            lambda c, name, **kwargs: c(c.config_class.from_pretrained(name))
        )
    try:
        yield
    finally:
        for cls, original in originals.items():
            cls.from_pretrained = original


def _load_repo_model(repo, revision, class_name, weights):
    """Imports model.py from a Hub repo at a pinned, reviewed revision and loads its weights."""
    code = hf_hub_download(repo, "model.py", revision=revision)
    spec = importlib.util.spec_from_file_location(f"hub_{revision[:8]}", code)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with _backbones_from_config():
        model = getattr(module, class_name)()
    state = load_file(hf_hub_download(repo, weights, revision=revision))
    missing, _ = model.load_state_dict(state, strict=False)
    missing = [k for k in missing if "masked_spec_embed" not in k]
    if missing:
        raise RuntimeError(f"{repo}: checkpoint is missing {len(missing)} weights, e.g. {missing[:3]}")
    return model.eval().to(DEVICE)


def _fixed_window(audio, samples, centre):
    """Tile short clips and cut long ones to exactly `samples`, as these models were trained."""
    audio = np.asarray(audio, dtype=np.float32)
    if len(audio) < samples:
        audio = np.tile(audio, samples // len(audio) + 1)
    start = (len(audio) - samples) // 2 if centre else 0
    return audio[start : start + samples]


class Forensics:
    """eliya/forensics_0.3B_*: SSL backbone with AASIST pooling, scored on a 5 s window."""

    def __init__(self, repo, revision, weights):
        self.model = _load_repo_model(repo, revision, "DeepfakeDetector", weights)

    @torch.no_grad()
    def synthetic_probability(self, audio):
        window = _fixed_window(audio, 5 * SAMPLE_RATE, centre=True)
        window = window / (np.abs(window).max() + 1e-8)
        logit = self.model(torch.from_numpy(window).unsqueeze(0).to(DEVICE)).float()
        return 1.0 - torch.sigmoid(logit).item()  # the model outputs P(real)


class SpectraAASIST3:
    """lab260/Spectra-AASIST3: XLS-R with a KAN-AASIST back end, scored on the first 4 s."""

    def __init__(self, repo, revision):
        self.model = _load_repo_model(repo, revision, "SpectraAASIST3", "model.safetensors")

    @torch.no_grad()
    def synthetic_probability(self, audio):
        audio = np.asarray(audio, dtype=np.float32)
        audio = np.append(audio[0], audio[1:] - 0.97 * audio[:-1])  # pre-emphasis, per the model card
        window = _fixed_window(audio, 64600, centre=False)
        logits = self.model(torch.from_numpy(window.astype(np.float32)).unsqueeze(0).to(DEVICE))
        return torch.softmax(logits.float(), dim=-1)[0, 0].item()  # index 1 is bona fide


# name -> (licence, loader). Order is the order they are reported in.
DETECTORS = {
    "spectra_aasist3": (
        "apache-2.0",
        lambda: SpectraAASIST3("lab260/Spectra-AASIST3", "bc0ded888080ddad493177bb53aa6f5b95219d7c"),
    ),
    "forensics_wild": (
        "cc-by-nc-4.0",
        lambda: Forensics(
            "eliya/forensics_0.3B_xlsr_wild_deepfake_classifier",
            "0cbc87b3fbd683ff8c8c961bcf244a8d5f1bcf02",
            "checkpoint_epoch_4.safetensors",
        ),
    ),
    "forensics_base": (
        "cc-by-nc-4.0",
        lambda: Forensics(
            "eliya/forensics_0.3B_base_deepfake_classifier",
            "cfd11365b02167214dc3b392378809fef6ca3cfa",
            "checkpoint_epoch_5.safetensors",
        ),
    ),
    "df_arena_500m": (
        "non-commercial",
        # Pinned to the revision whose code was read before running it.
        lambda: DFArena("Speech-Arena-2025/DF_Arena_500M_V_1", "8258fa8e74ff9b8ad20d4c939c1a7f694a6e4080"),
    ),
    "garystafford_xlsr": (
        "apache-2.0",
        lambda: Wav2Vec2Classifier("garystafford/wav2vec2-deepfake-voice-detector", "fake"),
    ),
    "melody_w2v2_base": (
        "apache-2.0",
        lambda: Wav2Vec2Classifier("MelodyMachine/Deepfake-audio-detection-V2", "fake"),
    ),
}


def load(names=None):
    return {name: DETECTORS[name][1]() for name in (names or DETECTORS)}
