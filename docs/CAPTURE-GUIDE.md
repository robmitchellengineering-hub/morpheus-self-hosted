# Capturing an amp and a cabinet

Two captures, two methods, and the difference decides everything: **an amplifier is nonlinear, a cabinet is
linear.** A linear system is completely described by its impulse response, so a cabinet needs one sweep and one
take. An amplifier needs a long, varied re-amp signal and a training run, because there is no impulse response
that describes it.

| | amplifier → `.nam` | cabinet → `.wav` |
|---|---|---|
| what you play | NAM's official re-amp signal (27 MB, fetched and hash-checked) | a 3 s log sweep we generate |
| what you record | the amp's output, in one take, no edits | the cabinet with a mic, in one take |
| what happens then | **you** train it (PyTorch, your machine — Morpheus does not own the training) | one deconvolution, seconds, no GPU |
| the check | `audio-capture.mjs check` — NAM's own trainer rules, transcribed | the deconvolution is proved against a known answer to 2 % |
| the result | a `.nam` you own | an IR you own, and no licence question |

---

## 1. Capturing a cabinet (the impulse response)

### Why the cab and not the amp

⚠️ **If the rig is guitar → amp → cabinet → mic, the IR you get is the amp AND the cabinet together.** Put that
in the plugin next to a `.nam` of the same amp and the amp is applied twice: thinner, fizzier, wrong. Take the
sweep from a **clean power amp** into the cabinet, or from the amp's **effects return** — anything that drives
the speaker without colouring it. If all you have is the whole rig, capture it and name the file
`my-rig-full.wav`, so it does not get used as a cabinet later.

### What you need

- The cabinet, and something clean to drive it (power amp, or the amp's FX return).
- A microphone on the speaker — on-axis at the cone edge is the usual starting point.
- An interface, and a DAW that can play one track and record another.

### The steps

1. **Generate the sweep** and put it on a track:

   ```
   node scripts/audio-capture.mjs ir sweep --out ir-sweep.wav --f1 60 --f2 12000
   ```

   It is 5 s: 0.5 s of silence, a 3 s exponential sweep, then 1.5 s of silence. The silence at the end is where
   the cabinet's own decay happens — without it the tail is cut off by the recording rather than by us.

   ⚠️ **`--f1 60 --f2 12000` for a guitar cabinet**, rather than the default 20 Hz–20 kHz. A guitar speaker does
   not reproduce 20 Hz, and three seconds of it is cone excursion for energy that will not be in the cabinet.

   ⚠️ **Match your session's sample rate.** The sweep is 48 kHz by default; if your session is 44.1 kHz, either
   record at 48 or generate the sweep to match: `--sample-rate 44100`. A mismatch is refused rather than turned
   into a time-scaled cabinet.

2. **Set the level.** Play it, and set the amp so the loudest moment is a good way below clipping on the
   interface. It will sound harsh — a sweep always does. What matters is that nothing clips and the room is
   quiet.

3. **Record one take**, mic in place, playing the whole 5 s including the silence at both ends. Do not move the
   mic, do not change the level, do not normalise afterwards.

4. **Deconvolve it**:

   ```
   node scripts/audio-capture.mjs ir make --recorded my-take.wav --sweep ir-sweep.wav --out my-cab.wav
   ```

   You get a 4096-tap IR, scaled so a guitar keeps its level through it (see lib/cabIr.js), plus a report:
   where the sweep's response sits in your
   take, how long the tail runs, and how closely the two ways of locating the response agree — which is what
   says this really is a capture. (⚠️ Neither is your interface's round-trip latency: the recording does not
   contain the moment the sweep was *sent*, so that number is not knowable from these two files.)

   It refuses the three ways a take is not a capture, by name: a different sample rate, a take shorter than the
   sweep, and a take that does not contain the sweep at all.

5. **Check it** — any time, on any IR:

   ```
   node scripts/audio-capture.mjs ir check my-cab.wav
   ```

   It refuses a silent take, and warns when a response decays in under 5 ms (a mic at the cone edge, or a gate
   somewhere in the chain) or is still going at the end of the window (that is the room, not the cabinet).

6. **Drop it in a project** as `models/my-cab.wav` and rebuild. The plugin warns when there is a Cabinet block
   with no `.wav` — "the block does nothing" — and this is that file. It bakes the taps in as float
   coefficients; there is no runtime file loading.

### What good looks like

A guitar cabinet IR decays in tens of milliseconds, has a sharp leading edge (a crest factor well above 6 dB),
and is mostly over by ~85 ms — which is exactly the 4096-tap cap at 48 kHz. If `ir check` says the response is
still going at the end of the window, move the mic closer or accept that the IR carries the room.

⚠️ **Then listen to it.** No number here says a cabinet sounds good, and none of them pretend to.

---

## 2. Capturing an amplifier (the `.nam`)

This half already existed; it is repeated here because the two are usually done in one session.

```
node scripts/audio-capture.mjs input                      # fetch the re-amp signal NAM accepts, verified
node scripts/audio-capture.mjs check --recorded amp.wav    # will it train? what will NAM make of it?
node scripts/audio-capture.mjs verify --model amp.nam --recorded amp.wav
```

⚠️ **You cannot use your own re-amp signal.** NAM's trainer identifies the input by its MD5 and refuses
anything it does not recognise — the Train button never enables. That is why we fetch the official one rather
than generating a nicer one. See `server/src/lib/audio/namCapture.js`, which transcribes the trainer's own
rules so the pre-flight cannot disagree with it.

Training itself runs in **your** PyTorch, on **your** machine: `node scripts/task.mjs scaffold` writes the
project. Morpheus does not train, and that is a decision rather than a gap.

---

## 3. Where the files go

```
your-project/
  models/
    my-amp.nam        ← the trained model
    my-cab.wav        ← the captured impulse response
  morpheus.plugin.json
  Source/ …
```

Both are found by convention (`models/` ranks first) and both are baked into the plugin at build time.
