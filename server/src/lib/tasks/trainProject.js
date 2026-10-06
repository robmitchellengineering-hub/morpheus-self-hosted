// TRAIN — the project the USER runs, on their own machine, because that is where training belongs.
//
// ── WHY MORPHEUS DOES NOT TRAIN ─────────────────────────────────────────────────────────────────────────
// A GPU fleet is a fixed cost paid before the first customer, and every model trained on our hardware would be
// our liability rather than the user's asset. So what this module emits is a PROJECT: pinned dependencies, a
// resumable loop, a dry run that predicts the wall clock before a single epoch is spent, and our measurement
// built in. The user runs it. The model is theirs from the first gradient.
//
// ── ⚠️ THE PRE-FLIGHT VERDICT IS THE GATE, AND THAT IS THE WHOLE DESIGN ─────────────────────────────────
// The dataset contract lives in `dataset.js` — one implementation, in JavaScript, the one the app runs on the
// server over the user's own bytes. This project does NOT re-implement it in Python. `train.py` refuses to
// start unless `preflight.json` is present and says the dataset is trainable.
//
// That is not laziness about writing a second copy. A rule expressed twice is a rule that disagrees with
// itself eventually, and the disagreement would be invisible: Morpheus says "your data is fine", the trainer
// says "no it is not", and neither is lying about the same dataset. One authority, named in the failure.
//
// ⚠️ AND THE SPLIT IS BY RECORDING. Windows of one take are near-identical, so splitting by CLIP puts some in
// train and some in test and reports a score that measures memory rather than learning. The rule is published
// in the family's data contract and implemented here: the file name before the first `_` or `-` is the
// recording, and a recording never straddles the split.
//
// ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────────────────────────────────
// It does not quantise. Exporting writes FLOAT weights and a card; quantising is the PACK stage and it is ours
// (`audio-quantize.mjs` measures what a bit width costs, and that measurement is the reason to keep the two
// apart). It does not embed either — EMBED is generated source, and it comes after a model exists to embed.
import { TASK_FAMILIES, taskFamily } from './registry.js';

/** Where the app writes the verdict the trainer insists on. Named here because two languages share it. */
export const PREFLIGHT_FILE = 'preflight.json';

/** The files a generated project contains, in the order a README would mention them. */
export const PROJECT_FILES = [
  'README.md', 'requirements.txt', PREFLIGHT_FILE,
  'preflight.py', 'dataset.py', 'model.py', 'train.py', 'evaluate.py', 'export.py',
];

/**
 * `preflight.py` — the gate, with NO dependencies.
 *
 * ⚠️ IT IS ITS OWN FILE FOR A REASON THAT ONLY SHOWS UP ON A FIRST RUN. The check lived in `dataset.py`, which
 * imports numpy, torch and soundfile — so a user who had not yet installed the requirements got
 * `ModuleNotFoundError: numpy` instead of the answer to the question they actually had, which is whether their
 * data is any good. And the ORDER was wrong: the expensive imports happened before the gate whose whole job is
 * to stop work being done.
 *
 * So the gate is stdlib-only, and `train.py` imports it before anything scientific. Two first-run outcomes
 * remain, and both are now the right sentence: the dataset did not pass, or the requirements are not installed.
 */
const preflightPy = () => py(`
"""The gate: read Morpheus's verdict on the dataset, and refuse to train if it did not pass.

Imports nothing outside the standard library, on purpose — see train.py, which imports THIS before torch, so
the first thing a new user is told is the truth about their data rather than a missing-package error.
"""
import json
import os


class DatasetNotChecked(SystemExit):
    """Raised and printed rather than traced: a verdict is a sentence, not a crash."""


def load_preflight(project_dir):
    path = os.path.join(project_dir, "${PREFLIGHT_FILE}")
    if not os.path.exists(path):
        raise DatasetNotChecked(
            f"{path} is missing. Morpheus writes it when it checks the dataset, and this project will not "
            "train without it. Generate the project with --dataset, or run the check yourself:\\n"
            "    node scripts/task.mjs check <dataset-dir>"
        )
    with open(path) as fh:
        verdict = json.load(fh)
    if not verdict.get("ok"):
        fails = [i for i in verdict.get("issues", []) if i.get("level") == "fail"]
        lines = "\\n".join(f"  - {i.get('what')}" for i in fails) or ("  - (the verdict is in " + path + ")")
        raise DatasetNotChecked(
            "the dataset check did not pass, so training would spend electricity on data that cannot work:\\n"
            + lines
            + "\\n\\nFix those, run the check again, and regenerate this project so the verdict is current."
        )
    return verdict
`);

/** The verdict, as the file the trainer reads. */
export const preflightJson = (verdict) => `${JSON.stringify(verdict, null, 2)}\n`;

const py = (s) => s.replace(/^\n/, '');

/**
 * `dataset.py` — loading, the recording rule, and the split.
 *
 * ⚠️ IT READS THE SAMPLES ITSELF, and it does not check them. Whether the clips are silent, clipped, long
 * enough, balanced or duplicated is the pre-flight's answer and it is already written down; re-deciding it
 * here would be a second opinion nobody asked for. What this file owns is the part the pre-flight cannot know:
 * HOW THE CLIPS BECOME TENSORS, and that a recording never straddles the split.
 */
const datasetPy = (family) => py(`
"""Loading, the recording rule, and the split.

The contract — how many clips, how loud, how long, whether anything is duplicated — is checked by Morpheus
before this project is written, and the verdict is in ${PREFLIGHT_FILE}. This file does not repeat that work.
"""
import os
import numpy as np
import soundfile as sf
import torch
from torch.utils.data import Dataset

SAMPLE_RATE = ${family.data.sampleRate || 48000}
CLIP_SECONDS = ${family.data.clipSeconds || 2.0}
N_MELS = 64
N_FFT = 1024
HOP = 256


def recording_of(path):
    """The recording a clip belongs to — the file name before the first _ or -.

    This is the rule the family publishes. It exists because windows of one take are near-identical: put some
    in train and some in test and the score measures memory. Name your takes so this can see them
    (take1_001.wav, take1_002.wav) or every clip of a label counts as its own recording, which is the honest
    answer when the names do not say otherwise.
    """
    stem = os.path.splitext(os.path.basename(path))[0]
    for sep in ("_", "-"):
        if sep in stem:
            return stem.split(sep)[0]
    return stem


def discover(dataset_dir):
    """Every clip, as (path, label), with the labels sorted so two runs agree."""
    classes = sorted(d for d in os.listdir(dataset_dir) if os.path.isdir(os.path.join(dataset_dir, d)))
    items = []
    for label in classes:
        folder = os.path.join(dataset_dir, label)
        for name in sorted(os.listdir(folder)):
            if name.lower().endswith(".wav"):
                items.append((os.path.join(folder, name), classes.index(label)))
    return classes, items


def split_by_recording(items, fractions, seed=1234):
    """Train/validation/test, with a whole recording on one side of the line.

    ⚠️ THE SPLIT IS BY RECORDING AND NOT BY CLIP. Splitting clips is the mistake that produces a good number:
    windows of one take are near-identical, so a model tested on them is being tested on what it memorised.
    """
    by_recording = {}
    for path, label in items:
        by_recording.setdefault((label, recording_of(path)), []).append((path, label))
    keys = sorted(by_recording)
    rng = np.random.default_rng(seed)
    rng.shuffle(keys)
    n = len(keys)
    n_train = int(round(n * fractions[0]))
    n_val = int(round(n * fractions[1]))
    parts = {"train": keys[:n_train], "validation": keys[n_train:n_train + n_val], "test": keys[n_train + n_val:]}
    return {name: [pair for k in ks for pair in by_recording[k]] for name, ks in parts.items()}, len(keys)


def log_mel(wave, sample_rate):
    """A log-mel spectrogram, in torch, with no front-end library.

    torchaudio would be one more pinned dependency for twelve lines of arithmetic, and the arithmetic is the
    part that has to match at inference time anyway — the generated C++ implements THIS, not a library call.
    """
    if sample_rate != SAMPLE_RATE:
        # A linear resample. The pre-flight already warned about mixed rates; this is what keeps the model from
        # learning the resampler instead of the sound.
        idx = torch.linspace(0, len(wave) - 1, int(len(wave) * SAMPLE_RATE / sample_rate))
        wave = wave[idx.long()]
    want = int(SAMPLE_RATE * CLIP_SECONDS)
    if len(wave) < want:
        wave = torch.nn.functional.pad(wave, (0, want - len(wave)))
    else:
        wave = wave[:want]
    window = torch.hann_window(N_FFT)
    spec = torch.stft(wave, n_fft=N_FFT, hop_length=HOP, window=window, return_complex=True).abs()
    # The mel filterbank, built once, in the same shape the emitted C++ will carry.
    mel = mel_filterbank(N_MELS, N_FFT // 2 + 1, SAMPLE_RATE)
    out = torch.log(mel @ spec + 1e-6)
    mean = out.mean()
    std = out.std()
    return (out - mean) / (std + 1e-5)


_filterbank_cache = {}


def mel_filterbank(n_mels, n_freqs, sample_rate):
    key = (n_mels, n_freqs, sample_rate)
    if key in _filterbank_cache:
        return _filterbank_cache[key]
    def hz_to_mel(f):
        return 2595.0 * np.log10(1.0 + f / 700.0)
    def mel_to_hz(m):
        return 700.0 * (10.0 ** (m / 2595.0) - 1.0)
    points = mel_to_hz(np.linspace(hz_to_mel(30.0), hz_to_mel(sample_rate / 2.0), n_mels + 2))
    freqs = np.linspace(0.0, sample_rate / 2.0, n_freqs)
    fb = np.zeros((n_mels, n_freqs), dtype=np.float32)
    for i in range(n_mels):
        lo, mid, hi = points[i], points[i + 1], points[i + 2]
        fb[i] = np.clip(np.minimum((freqs - lo) / max(mid - lo, 1e-9), (hi - freqs) / max(hi - mid, 1e-9)), 0, None)
    fb = torch.from_numpy(fb)
    _filterbank_cache[key] = fb
    return fb


class ClipDataset(Dataset):
    def __init__(self, items):
        self.items = items

    def __len__(self):
        return len(self.items)

    def __getitem__(self, i):
        path, label = self.items[i]
        wave, rate = sf.read(path, dtype="float32", always_2d=True)
        wave = torch.from_numpy(wave.mean(axis=1))
        return log_mel(wave, rate).unsqueeze(0), label
`);

/**
 * `model.py` — the network.
 *
 * ⚠️ IT IS SMALL ON PURPOSE, AND THE SIZE IS THE PRODUCT. Every layer here has to be emitted as C++ by the
 * EMBED stage and carried inside somebody's application, so capacity that does not earn its place is weight
 * they ship. A hundred thousand parameters is a few hundred kilobytes of source and runs in microseconds.
 */
const modelPy = () => py(`
"""The classifier: a small convolutional network over a log-mel spectrogram.

Small on purpose. Every layer here is emitted as C++ later and shipped inside somebody's app, so capacity that
does not earn its place is weight they carry. Numbers from this file are what the generated inference uses.
"""
import torch
import torch.nn as nn

N_MELS = 64


class AudioClassifier(nn.Module):
    def __init__(self, n_classes):
        super().__init__()
        self.features = nn.Sequential(
            nn.Conv2d(1, 16, kernel_size=3, padding=1), nn.BatchNorm2d(16), nn.ReLU(),
            nn.MaxPool2d(2),
            nn.Conv2d(16, 32, kernel_size=3, padding=1), nn.BatchNorm2d(32), nn.ReLU(),
            nn.MaxPool2d(2),
            nn.Conv2d(32, 32, kernel_size=3, padding=1), nn.BatchNorm2d(32), nn.ReLU(),
            nn.AdaptiveAvgPool2d(1),
        )
        self.head = nn.Linear(32, n_classes)

    def forward(self, x):
        # x: (batch, 1, n_mels, frames)
        return self.head(self.features(x).flatten(1))
`);

/**
 * `train.py` — the loop, with the two things that make it usable by somebody who is not a machine-learning
 * engineer: a dry run that predicts the wall clock, and a checkpoint that survives a closed laptop lid.
 */
const trainPy = (family) => py(`
"""Train the classifier. Run this on YOUR machine — Morpheus generates the project, it does not train for you.

    python train.py --dataset ~/my-sounds            # trains, writing runs/<timestamp>/
    python train.py --dataset ~/my-sounds --dry-run  # times one step and tells you how long the whole run is
    python train.py --dataset ~/my-sounds --resume runs/<timestamp>/last.pt

⚠️ IT REFUSES TO START WITHOUT ${PREFLIGHT_FILE}. That file is Morpheus's verdict on the dataset — silent clips,
a starved class, the same audio under two labels — and training without it would spend your electricity on
data that cannot work.
"""
import argparse
import json
import os
import sys
import time

# ⚠️ THE GATE IS EVALUATED AT STARTUP, BEFORE THE SCIENTIFIC IMPORTS — not inside main(), which runs after
# them. That distinction is the whole point: a user with nothing installed should be told about their DATA
# first, and an import-time call is the only way to be ahead of a missing package. It also means the verdict
# cannot drift from the run: the file is read once, and a bad one stops the process before a single tensor
# exists.
from preflight import load_preflight

VERDICT = load_preflight(os.path.dirname(os.path.abspath(__file__)))

try:
    import numpy as np
    import torch
    import torch.nn as nn
    from torch.utils.data import DataLoader
except ModuleNotFoundError as exc:
    raise SystemExit(
        f"{exc.name} is not installed. Install the pinned requirements first:\\n"
        "    python -m venv .venv && . .venv/bin/activate      (Windows: .venv\\\\Scripts\\\\activate)\\n"
        "    pip install -r requirements.txt"
    )

from dataset import ClipDataset, discover, split_by_recording
from model import AudioClassifier

FRACTIONS = (${family.data.split.train}, ${family.data.split.validation}, ${family.data.split.test})


def evaluate(model, loader, device):
    model.eval()
    correct = 0
    total = 0
    confusion = None
    with torch.no_grad():
        for x, y in loader:
            x, y = x.to(device), y.to(device)
            pred = model(x).argmax(dim=1)
            if confusion is None:
                confusion = torch.zeros((model.head.out_features,) * 2, dtype=torch.long)
            for t, p in zip(y.view(-1), pred.view(-1)):
                confusion[t.long(), p.long()] += 1
            correct += int((pred == y).sum())
            total += int(y.numel())
    return (correct / max(total, 1)), (confusion.tolist() if confusion is not None else [])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", required=True, help="one directory per label, .wav files inside")
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--batch-size", type=int, default=16)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--seed", type=int, default=1234)
    ap.add_argument("--out", default=None, help="where to write the run (default runs/<timestamp>)")
    ap.add_argument("--resume", default=None, help="path to last.pt to carry on from")
    ap.add_argument("--dry-run", action="store_true", help="time one step, then stop and say how long the rest is")
    args = ap.parse_args()

    verdict = VERDICT
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)

    classes, items = discover(args.dataset)
    parts, n_recordings = split_by_recording(items, FRACTIONS, args.seed)
    print(f"{len(items)} clips, {len(classes)} labels, {n_recordings} recordings")
    print(f"  train {len(parts['train'])} · validation {len(parts['validation'])} · test {len(parts['test'])}")
    if min(len(parts[k]) for k in parts) == 0:
        raise SystemExit(
            "a split came out empty. With the split kept whole by recording, you need at least three "
            "recordings per label for three ways — see the pre-flight's note on naming your takes."
        )

    out = args.out or os.path.join("runs", time.strftime("%Y%m%d-%H%M%S"))
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "config.json"), "w") as fh:
        json.dump({"args": vars(args), "classes": classes, "fractions": FRACTIONS,
                   "recordings": n_recordings, "preflight": verdict.get("facts", {})}, fh, indent=2)

    device = torch.device("cuda" if torch.cuda.is_available() else
                          ("mps" if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available() else "cpu"))
    print(f"device: {device}")
    loaders = {name: DataLoader(ClipDataset(parts[name]), batch_size=args.batch_size, shuffle=(name == "train")) for name in parts}
    model = AudioClassifier(len(classes)).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr)
    loss_fn = nn.CrossEntropyLoss()
    start_epoch = 0
    best = -1.0

    if args.resume:
        state = torch.load(args.resume, map_location=device)
        model.load_state_dict(state["model"])
        opt.load_state_dict(state["opt"])
        start_epoch = state["epoch"] + 1
        best = state["best"]
        print(f"resumed from {args.resume} at epoch {start_epoch}")

    step_start = time.time()
    for epoch in range(start_epoch, args.epochs):
        model.train()
        running = 0.0
        for x, y in loaders["train"]:
            x, y = x.to(device), y.to(device)
            opt.zero_grad()
            loss = loss_fn(model(x), y)
            loss.backward()
            opt.step()
            running += float(loss)
            if args.dry_run:
                # ⭐ THE DRY RUN IS THE POINT OF THIS FLAG: one step is enough to say what the whole thing
                # costs, and it is the difference between "start it and hope" and a number before you begin.
                spent = time.time() - step_start
                steps = max(1, len(loaders["train"])) * args.epochs
                print(f"one step: {spent:.2f}s · {steps} steps · about {spent * steps / 60:.1f} minutes on {device}")
                return
        acc, _ = evaluate(model, loaders["validation"], device)
        print(f"epoch {epoch + 1}/{args.epochs}  loss {running / max(1, len(loaders['train'])):.4f}  validation {acc * 100:.1f}%")
        torch.save({"model": model.state_dict(), "opt": opt.state_dict(), "epoch": epoch, "best": best,
                    "classes": classes}, os.path.join(out, "last.pt"))
        if acc > best:
            best = acc
            torch.save({"model": model.state_dict(), "classes": classes, "validation_accuracy": acc},
                       os.path.join(out, "best.pt"))
        if best >= 0.999:
            print("validation is at 100% — check the confusion matrix in evaluate.py before believing it")
            break

    print(f"best validation {best * 100:.1f}% — now run: python evaluate.py --run {out} --dataset {args.dataset}")


if __name__ == "__main__":
    main()
`);

/**
 * `evaluate.py` — the measurement, which is the stage that makes the number mean something.
 */
const evaluatePy = () => py(`
"""Measure the trained model on the split it has never seen, and write metrics.json.

⚠️ ACCURACY ALONE IS NOT A MEASUREMENT. A dataset that is 90% one class scores 90% by answering that class
every time, and the number looks like success. The confusion matrix and the per-class figures are printed
precisely so that a model which has learned one class and guessed the rest is visible as what it is.
"""
import argparse
import json
import os

import torch
from torch.utils.data import DataLoader

from dataset import ClipDataset, discover, split_by_recording
from model import AudioClassifier

FRACTIONS = (0.8, 0.1, 0.1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True, help="the run directory train.py wrote")
    ap.add_argument("--dataset", required=True)
    ap.add_argument("--split", default="test", choices=["train", "validation", "test"])
    args = ap.parse_args()

    state = torch.load(os.path.join(args.run, "best.pt"), map_location="cpu")
    classes = state["classes"]
    model = AudioClassifier(len(classes))
    model.load_state_dict(state["model"])
    model.eval()

    _, items = discover(args.dataset)
    parts, _ = split_by_recording(items, FRACTIONS)
    loader = DataLoader(ClipDataset(parts[args.split]), batch_size=16)

    confusion = [[0] * len(classes) for _ in classes]
    with torch.no_grad():
        for x, y in loader:
            for t, p in zip(y.view(-1), model(x).argmax(dim=1).view(-1)):
                confusion[int(t)][int(p)] += 1

    total = sum(sum(row) for row in confusion)
    correct = sum(confusion[i][i] for i in range(len(classes)))
    per_class = {}
    for i, label in enumerate(classes):
        seen = sum(confusion[i])
        per_class[label] = {"clips": seen, "recall": (confusion[i][i] / seen) if seen else None}
    metrics = {
        "split": args.split,
        "clips": total,
        "accuracy": correct / max(total, 1),
        "confusion": confusion,
        "classes": classes,
        "per_class": per_class,
    }
    with open(os.path.join(args.run, "metrics.json"), "w") as fh:
        json.dump(metrics, fh, indent=2)

    print(f"\\n{args.split}: {total} clips, accuracy {(metrics['accuracy']) * 100:.1f}%\\n")
    width = max(len(c) for c in classes)
    print(" " * (width + 2) + "  ".join(f"{c[:7]:>7}" for c in classes))
    for i, label in enumerate(classes):
        print(f"{label:>{width}}  " + "  ".join(f"{n:>7}" for n in confusion[i]))
    print("")
    for label, row in per_class.items():
        recall = "n/a" if row["recall"] is None else f"{row['recall'] * 100:.0f}%"
        print(f"  {label}: {row['clips']} clips, {recall} of them right")
    if metrics["accuracy"] > 0.98 and total < 60:
        print("\\n  ⚠️ near-perfect on fewer than 60 clips is usually the split, not the model.")


if __name__ == "__main__":
    main()
`);

/**
 * `export.py` — the artefact, in a container Morpheus already reads.
 *
 * ⚠️ IT WRITES FLOAT WEIGHTS. Quantising is the PACK stage and it is Morpheus's, because that stage's whole
 * value is the MEASUREMENT — what a bit width costs in accuracy against what it saves in bytes — and a
 * decision that needs a measurement should not be made by a script whose author cannot see the alternatives.
 */
const exportPy = () => py(`
"""Write model.json: the trained weights in Morpheus's container, with a card describing them.

    python export.py --run runs/<timestamp> [--out model.json]

The format is \`morpheus-model/1\` — the same container the audio pipeline already reads. Quantising it is
Morpheus's job (PACK), because that stage's value is the measurement of what a bit width costs, and it belongs
where the alternatives can be compared.
"""
import argparse
import json
import os
import time

import torch

from model import AudioClassifier

FORMAT = "morpheus-model/1"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--out", default="model.json")
    ap.add_argument("--name", default=None)
    args = ap.parse_args()

    state = torch.load(os.path.join(args.run, "best.pt"), map_location="cpu")
    classes = state["classes"]
    model = AudioClassifier(len(classes))
    model.load_state_dict(state["model"])
    model.eval()

    # Every tensor, by name, as plain lists. NO QUANTISATION — see the docstring.
    tensors = {}
    for name, tensor in model.state_dict().items():
        tensors[name] = {"shape": list(tensor.shape), "values": tensor.flatten().tolist()}

    metrics = None
    metrics_path = os.path.join(args.run, "metrics.json")
    if os.path.exists(metrics_path):
        with open(metrics_path) as fh:
            metrics = json.load(fh)

    model_json = {
        "format": FORMAT,
        "family": "audio.classify",
        "architecture": "AudioClassifier",
        "sample_rate": 48000,
        "task": {
            "labels": classes,
            "input": "a mono clip, 2.0 s at 48 kHz, resampled and normalised",
            "output": "one score per label; the highest wins",
        },
        "tensors": tensors,
        "source": {"tool": "task.mjs train project", "run": os.path.abspath(args.run), "exported": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())},
        "card": {
            "name": args.name or os.path.basename(os.path.abspath(args.run)),
            "trained_by": "the owner of this machine",
            "metrics": {"accuracy": metrics.get("accuracy") if metrics else None,
                        "clips": metrics.get("clips") if metrics else None,
                        "split": metrics.get("split") if metrics else None},
            "classes": classes,
            "parameters": sum(int(t.numel()) for t in model.state_dict().values()),
        },
    }
    with open(args.out, "w") as fh:
        json.dump(model_json, fh)
    size = os.path.getsize(args.out)
    print(f"wrote {args.out} — {len(classes)} labels, {model_json['card']['parameters']} parameters, {size / 1024:.0f} KB")
    if metrics is None:
        print("  (no metrics.json in that run — run evaluate.py first, so the card can carry a number)")


if __name__ == "__main__":
    main()
`);

/** The README is the instructions, and it is generated because the numbers in it come from the family. */
const readmeMd = (family) => `# Train an audio classifier — on your own machine

Morpheus generated this project. **It does not train for you**: the loop below runs here, on your hardware,
and the model it produces is yours. Nothing about it is sent anywhere.

## 1. Check the dataset first

\`\`\`
node scripts/task.mjs check ~/my-sounds
\`\`\`

Morpheus writes its verdict into \`${PREFLIGHT_FILE}\` beside this README, and \`train.py\` **refuses to start
without it** — the check is what stops an hour of electricity being spent on data that cannot work. It refuses
silent clips, classes too small to learn, clips duplicated across labels, and anything else in the contract for
\`${family.id}\`.

## 2. Install

\`\`\`
python -m venv .venv && . .venv/bin/activate     # Windows: .venv\\Scripts\\activate
pip install -r requirements.txt
\`\`\`

## 3. Find out how long it will take, before it takes it

\`\`\`
python train.py --dataset ~/my-sounds --dry-run
\`\`\`

One step, extrapolated. On a laptop CPU expect minutes; on a GPU, less.

## 4. Train

\`\`\`
python train.py --dataset ~/my-sounds
\`\`\`

It writes \`runs/<timestamp>/\` with a checkpoint after every epoch, so a closed laptop lid costs one epoch
rather than the run — \`--resume runs/<timestamp>/last.pt\` carries on.

## 5. Measure it, then believe it

\`\`\`
python evaluate.py --run runs/<timestamp> --dataset ~/my-sounds
\`\`\`

**Read the confusion matrix, not the accuracy.** A dataset that is mostly one class scores well by answering
that class every time, and the accuracy on its own will not tell you that.

## 6. Export

\`\`\`
python export.py --run runs/<timestamp>
\`\`\`

\`model.json\` is a \`morpheus-model/1\` container — the same one the audio pipeline reads — carrying the labels,
the weights and a card with what it scored. Hand it back to Morpheus to quantise and embed it as source in
your application.

## The dataset layout

\`\`\`
my-sounds/
  clean/     take1_001.wav  take1_002.wav  take2_001.wav …
  distorted/ take1_001.wav  take1_002.wav …
\`\`\`

One directory per label, \`.wav\` files inside, at least ${family.data.minClipsPerLabel} per label.

⚠️ **The split is by recording, not by clip**: the file name before the first \`_\` or \`-\` is the recording,
and a recording never straddles train and test. Windows of one take are near-identical, so splitting them
across the line gives a score that measures memory. If your names do not mark the takes, every clip counts as
its own recording — which is the honest answer when the names do not say otherwise.
`;

/** `requirements.txt`, pinned, because "it worked yesterday" needs yesterday to be a version. */
const requirementsTxt = () => `# Pinned, deliberately. An unpinned training project is one that trains differently next month and cannot be
# reproduced — and a model nobody can reproduce is a model nobody can argue with.
torch==2.4.1
numpy==1.26.4
soundfile==0.12.1
`;

/**
 * The whole project, as a list of `{ path, content }`.
 *
 * `preflight` is the verdict the app already computed; it is written IN as `preflight.json` so the trainer's
 * gate has something to read. A caller that has not run the check passes `null` and gets a project whose
 * trainer will refuse to start — which is the correct behaviour, and better than a project that trains on
 * anything.
 */
export function trainingProject(familyId = 'audio.classify', preflight = null) {
  const family = taskFamily(familyId);
  if (!family) throw new Error(`no such task family: ${familyId}`);
  return {
    family: family.id,
    files: [
      { path: 'README.md', content: readmeMd(family) },
      { path: 'requirements.txt', content: requirementsTxt() },
      { path: PREFLIGHT_FILE, content: preflightJson(preflight ?? { ok: false, issues: [{ level: 'fail', what: 'the dataset has not been checked yet', detail: 'Run the dataset check and write its verdict here.' }] }) },
      { path: 'preflight.py', content: preflightPy() },
      { path: 'dataset.py', content: datasetPy(family) },
      { path: 'model.py', content: modelPy() },
      { path: 'train.py', content: trainPy(family) },
      { path: 'evaluate.py', content: evaluatePy() },
      { path: 'export.py', content: exportPy() },
    ],
  };
}

/** What is wrong with a generated project, as reasons. Used by the guard, and by a caller that wants to be sure. */
export function validateProject(project) {
  const problems = [];
  if (!taskFamily(project?.family)) problems.push(`unknown family: ${project?.family}`);
  const have = new Map((project?.files || []).map((f) => [f.path, f.content || '']));
  for (const path of PROJECT_FILES) {
    if (!have.has(path)) problems.push(`missing ${path}`);
    else if (!have.get(path).trim()) problems.push(`${path} is empty`);
  }
  // The gate is only a gate if the trainer opens it — AND OPENS IT FIRST. A check that runs after the
  // scientific imports is a check a user with nothing installed never reaches, and the message they get
  // instead is about numpy.
  const train = have.get('train.py') || '';
  if (!/from preflight import load_preflight/.test(train)) problems.push('train.py does not consult the pre-flight verdict');
  const gateAt = train.indexOf('from preflight import');
  const heavyAt = train.indexOf('import torch');
  if (heavyAt >= 0 && gateAt > heavyAt) problems.push('train.py imports torch before the pre-flight, so a missing dependency hides the verdict');
  // And the split is only by recording if the rule is in the loader.
  if (!/def recording_of/.test(have.get('dataset.py') || '')) problems.push('dataset.py has no recording rule, so the split is by clip');
  return problems;
}

/** Every family that can be scaffolded today, which is the one with a TRAIN stage written. */
export const scaffoldableFamilies = () => TASK_FAMILIES.filter((f) => f.built.includes('train') || f.id === 'audio.classify').map((f) => f.id);
