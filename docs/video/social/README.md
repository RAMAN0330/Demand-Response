# ADRMS social overview video

An ~86-second animated walkthrough for LinkedIn and Instagram, rendered from the live product in three formats:

| File | Size | Use |
| --- | --- | --- |
| `ADRMS-overview-16x9.mp4` | 1920×1080 | LinkedIn, YouTube, website |
| `ADRMS-overview-4x5.mp4` | 1080×1350 | LinkedIn and Instagram feed |
| `ADRMS-overview-9x16.mp4` | 1080×1920 | Instagram Reels, LinkedIn mobile |

Each has burned-in, word-highlighted captions (most feeds autoplay muted) and a matching `.srt`. Post copy is in `POST-CAPTIONS.md`.

## How it is made

1. **Stage real data** — run the backend with a simulated field at an evening time (industrial offer windows open):
   `KSFP_TIME_SCALE=30 KSFP_SIM_START=18:10 KSFP_AUTO_DISTURBANCES=0 uvicorn ksfp.main:app` and the web dev server.
2. **Capture** — `node capture.mjs <shots_dir>` (needs Playwright + Chromium) drives a real event through the API:
   a demand surge, dual approval, industries dispatching, a second surge that leaves a residual, an approved
   load-rotation order, then recovery and settlement. It screenshots every state at 3840×2160 (1600×900 CSS px at
   2.4×) and records the on-screen box of each component the camera will zoom to (`manifest.json`).
3. **Narration** — `python tts.py script.json <audio_dir> <kokoro_dir>` with [Kokoro](https://github.com/thewh1teagle/kokoro-onnx)
   (`af_heart`; model files from its GitHub release). One WAV per scene and `durations.json`.
4. **Render** — `python render.py 16x9|4x5|9x16 <shots_dir> <audio_dir> <out.mp4>`:
   - camera: eased zoom (centre lerp, width interpolated geometrically) from the full screen to each target box,
     framed in the window's aspect, with a slow push-in while holding; targets can be column slices
     (`cases#2/3`, `kpis#5-8/8`) or another capture (`reports:kpis`, dissolved during the move);
   - spotlight on the component being explained, an animated cursor with click ripples;
   - animated hook and brand cards (the peak-shaving mark draws itself) and an end card with the dispatch priority;
   - captions chunked at punctuation, the spoken word highlighted;
   - narration over a generated music bed that ducks under the voice; H.264 + AAC, 30 fps, `+faststart`.
   `PREVIEW=12.5,30` renders those moments to PNG instead of a video.

`script.json` holds the scenes: narration, chapter, capture, and the camera moves (`to`, `spot`, `hold`, `click`, `click_at`).
