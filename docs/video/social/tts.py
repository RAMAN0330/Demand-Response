"""Narration for the social overview video: one WAV per scene with Kokoro (af_heart), plus durations.

    /tmp/ttsenv/bin/python tts.py <script.json> <outdir> <kokoro-dir>
"""

import json
import os
import sys

import soundfile as sf
from kokoro_onnx import Kokoro

script, out, kdir = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(out, exist_ok=True)
cfg = json.load(open(script))
k = Kokoro(os.path.join(kdir, "kokoro-v1.0.onnx"), os.path.join(kdir, "voices-v1.0.bin"))
durs = {}
for s in cfg["scenes"]:
    path = os.path.join(out, f"{s['id']}.wav")
    if not os.path.exists(path):
        samples, sr = k.create(s["say"], voice=cfg["voice"], speed=cfg["speed"], lang="en-us")
        sf.write(path, samples, sr)
    a, sr = sf.read(path)
    durs[s["id"]] = round(len(a) / sr, 3)
    print(s["id"], durs[s["id"]])
json.dump(durs, open(os.path.join(out, "durations.json"), "w"), indent=1)
print("total", round(sum(durs.values()), 1))
