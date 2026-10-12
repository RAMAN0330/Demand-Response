"""ADRMS social overview video — renderer.

A frame-by-frame camera over high-resolution product captures: eased zoom from the full screen to each component
(boxes recorded at capture time), a spotlight on the component being explained, an animated cursor with click
ripples, animated title and end cards, word-highlighted burned-in captions, narration over a ducked music bed.

    python render.py <format> <shots_dir> <audio_dir> <out.mp4>      format: 16x9 | 4x5 | 9x16

Raw RGB frames are piped to ffmpeg (libx264, 30 fps); narration + music are mixed with numpy.
"""

from __future__ import annotations

import json
import math
import os
import subprocess
import sys

import numpy as np
import soundfile as sf
from PIL import Image, ImageDraw, ImageFilter, ImageFont

FMT, SHOTS, AUDIO, OUT = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
HERE = os.path.dirname(os.path.abspath(__file__))
FPS = 30
SR = 24000
LEAD, TAIL, XF = 0.45, 0.6, 0.5  # narration lead-in, tail, crossfade between different screens
MOVE = 1.15  # seconds per camera move

NAVY, NAVY2 = (17, 36, 62), (10, 23, 41)
BRAND, BRAND_L, SKY = (42, 88, 148), (92, 140, 198), (183, 207, 233)
GREEN, AMBER, CRIMSON, INK, STEEL = (90, 190, 140), (226, 160, 60), (210, 80, 78), (30, 38, 48), (106, 118, 134)
F = "/usr/share/fonts/opentype/inter/"


def font(w: str, s: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(F + {"b": "Inter-Bold.otf", "xb": "Inter-ExtraBold.otf", "s": "Inter-SemiBold.otf", "m": "Inter-Medium.otf", "r": "Inter-Regular.otf", "d": "InterDisplay-ExtraBold.otf", "db": "InterDisplay-Bold.otf"}[w], s)


# ------------------------------------------------------------------ layout per format
if FMT == "16x9":
    W, H = 1920, 1080
    WIN = (0, 0, 1920, 1080)  # camera window
    CAP = dict(y=H - 168, size=46, width=1500, band=False)
elif FMT == "4x5":
    W, H = 1080, 1350
    WIN = (36, 196, 1008, 784)  # 9:7 window
    CAP = dict(y=1130, size=46, width=980, band=True)
else:  # 9x16
    W, H = 1080, 1920
    WIN = (36, 430, 1008, 1008)  # square window
    CAP = dict(y=1600, size=56, width=960, band=True)
WX, WY, WW, WH = WIN
ASPECT = WW / WH


def ease(t: float) -> float:
    t = max(0.0, min(1.0, t))
    return 4 * t * t * t if t < 0.5 else 1 - (-2 * t + 2) ** 3 / 2


def ease_out(t: float) -> float:
    t = max(0.0, min(1.0, t))
    return 1 - (1 - t) ** 3


# ------------------------------------------------------------------ inputs
script = json.load(open(os.path.join(HERE, "script.json")))
man = json.load(open(os.path.join(SHOTS, "manifest.json")))
VW, VH = man["viewport"]
DSF = man["dsf"]
durs = json.load(open(os.path.join(AUDIO, "durations.json")))
PAD = 0.35  # padding around each capture (fraction of its size) so the camera may frame beyond the edges
BG_SHOT = (236, 240, 245)
_cache: dict[str, Image.Image] = {}


def shot_img(name: str) -> Image.Image:
    if name not in _cache:
        im = Image.open(os.path.join(SHOTS, man["shots"][name]["img"])).convert("RGB")
        pw, ph = int(im.width * PAD), int(im.height * PAD)
        big = Image.new("RGB", (im.width + 2 * pw, im.height + 2 * ph), BG_SHOT)
        big.paste(im, (pw, ph))
        _cache[name] = big
    return _cache[name]


def target(shot: str, name: str) -> tuple[float, float, float, float]:
    if ":" in name:
        shot, name = name.split(":")
    if name == "full":
        return (0, 0, VW, VH)
    part = None
    if "#" in name:  # "cases#2/3": the 2nd of 3 equal columns of the box
        name, sl = name.split("#")
        rng, n = sl.split("/")
        k0, k1 = (rng.split("-") + [rng])[:2] if "-" in rng else (rng, rng)
        part = (int(k0), int(k1), int(n))
    r = man["shots"][shot]["targets"].get(name)
    if not r or r[2] <= 0:
        return (0, 0, VW, VH)
    if part:  # "cases#2/3" = 2nd of 3 equal columns; "kpis#5-8/8" = columns 5 to 8 of 8
        k0, k1, n = part
        w = r[2] / n
        return (r[0] + (k0 - 1) * w, r[1], w * (k1 - k0 + 1), r[3])
    return tuple(r)


def frame_for(rect, spot: bool) -> tuple[float, float, float]:
    """Camera (center x, center y, width) in CSS px that frames `rect` in the window's aspect."""
    x, y, w, h = rect
    full = (w >= VW * 0.95 and h >= VH * 0.9)
    pad = 0.0 if full else 0.08 * max(w, h) + 14
    w2, h2 = w + 2 * pad, h + 2 * pad
    if w2 / h2 < ASPECT:
        w2 = h2 * ASPECT
    if full:
        w2 = max(w2, VW * 1.02, VH * ASPECT * 1.02)
    w2 = max(w2, VW * (0.34 if FMT == "16x9" else 0.30))
    return (x + w / 2, y + h / 2, w2)


def lerp_cam(a, b, t):
    e = ease(t)
    return (a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e, math.exp(math.log(a[2]) + (math.log(b[2]) - math.log(a[2])) * e))


def render_cam(shot: str, cam) -> Image.Image:
    cx, cy, cw = cam
    ch = cw / ASPECT
    im = shot_img(shot)
    s = DSF
    ox, oy = VW * DSF * PAD, VH * DSF * PAD
    # keep the camera inside the padded capture (a wide, short target can ask for more than there is)
    cw = min(cw, im.width / s)
    ch = cw / ASPECT
    if ch * s > im.height:
        ch = im.height / s
        cw = ch * ASPECT
    x0 = min(max((cx - cw / 2) * s + ox, 0), im.width - cw * s)
    y0 = min(max((cy - ch / 2) * s + oy, 0), im.height - ch * s)
    box = (x0, y0, x0 + cw * s, y0 + ch * s)
    return im.resize((WW, WH), Image.BICUBIC, box=box, reducing_gap=2.5)


def to_screen(cam, rect):
    cx, cy, cw = cam
    k = WW / cw
    x, y, w, h = rect
    return ((x - (cx - cw / 2)) * k, (y - (cy - cw / ASPECT / 2)) * k, w * k, h * k)


# ------------------------------------------------------------------ overlays
def spotlight(img: Image.Image, r, alpha: float) -> Image.Image:
    if alpha <= 0.01:
        return img
    x, y, w, h = r
    pad = 8
    q = 4  # draw the mask at quarter resolution, then upsample (soft edge for free)
    m = Image.new("L", (WW // q, WH // q), int(105 * alpha))
    d = ImageDraw.Draw(m)
    d.rounded_rectangle(((x - pad) / q, (y - pad) / q, (x + w + pad) / q, (y + h + pad) / q), radius=14 / q, fill=0)
    m = m.resize((WW, WH), Image.BILINEAR)
    dark = Image.new("RGB", (WW, WH), NAVY2)
    out = Image.composite(dark, img, m)
    d2 = ImageDraw.Draw(out, "RGBA")
    a = int(255 * alpha)
    d2.rounded_rectangle((x - pad - 3, y - pad - 3, x + w + pad + 3, y + h + pad + 3), radius=18, outline=(*BRAND_L, int(a * 0.45)), width=6)
    d2.rounded_rectangle((x - pad, y - pad, x + w + pad, y + h + pad), radius=14, outline=(255, 255, 255, a), width=3)
    return out


CURSOR = [(0, 0), (0, 34), (9, 26), (15, 40), (21, 37), (15, 24), (27, 24)]


def cursor(img: Image.Image, pos, click_t: float | None) -> Image.Image:
    d = ImageDraw.Draw(img, "RGBA")
    x, y = pos
    if click_t is not None and 0 <= click_t <= 0.7:
        rr = 10 + 46 * ease_out(click_t / 0.7)
        a = int(200 * (1 - click_t / 0.7))
        d.ellipse((x - rr, y - rr, x + rr, y + rr), outline=(*BRAND_L, a), width=5)
        d.ellipse((x - 9, y - 9, x + 9, y + 9), fill=(255, 255, 255, a))
    pts = [(x + px, y + py) for px, py in CURSOR]
    d.polygon([(px + 2, py + 3) for px, py in pts], fill=(0, 0, 0, 70))
    d.polygon(pts, fill=(255, 255, 255, 255), outline=(20, 30, 45, 255))
    return img


# ------------------------------------------------------------------ static backgrounds
def backdrop(w: int, h: int, dark: bool = True) -> Image.Image:
    y = np.linspace(0, 1, h)[:, None]
    x = np.linspace(0, 1, w)[None, :]
    t = x * 0.45 + y * 0.55
    c0, c1 = np.array(NAVY), np.array(NAVY2)
    arr = (c0[None, None, :] * (1 - t[..., None]) + c1[None, None, :] * t[..., None]).astype(np.uint8)
    im = Image.fromarray(arr, "RGB").convert("RGBA")
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    g = ImageDraw.Draw(glow)
    g.ellipse((-w * 0.3, -h * 0.35, w * 0.65, h * 0.45), fill=(*BRAND_L, 70))
    g.ellipse((w * 0.55, h * 0.55, w * 1.35, h * 1.3), fill=(*GREEN, 45))
    im = Image.alpha_composite(im, glow.filter(ImageFilter.GaussianBlur(min(w, h) * 0.12)))
    grid = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grid)
    for gx in range(0, w, 56):
        gd.line((gx, 0, gx, h), fill=(255, 255, 255, 9))
    for gy in range(0, h, 56):
        gd.line((0, gy, w, gy), fill=(255, 255, 255, 9))
    return Image.alpha_composite(im, grid).convert("RGB")


BG = backdrop(W, H)
BG_CARD = BG.copy()  # title and end cards: no window shadow
WIN_MASK = Image.new("L", (WW, WH), 0)
ImageDraw.Draw(WIN_MASK).rounded_rectangle((0, 0, WW - 1, WH - 1), radius=0 if FMT == "16x9" else 26, fill=255)
SHADOW = None
if FMT != "16x9":
    SHADOW = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(SHADOW).rounded_rectangle((WX, WY + 14, WX + WW, WY + WH + 14), radius=26, fill=(0, 0, 0, 120))
    SHADOW = SHADOW.filter(ImageFilter.GaussianBlur(22))
    BG = Image.alpha_composite(BG.convert("RGBA"), SHADOW).convert("RGB")


def mark(d: ImageDraw.ImageDraw, x: float, y: float, s: float, progress: float = 1.0):
    """ADRMS mark: peak-shaved demand curve (dashed peak = load that would have been, solid = after DR)."""
    d.rounded_rectangle((x, y, x + s, y + s), radius=s * 0.25, fill=BRAND)
    P = lambda px, py: (x + px / 32 * s, y + py / 32 * s)  # noqa: E731
    d.line([P(5, 24.5), P(27, 24.5)], fill=(255, 255, 255, 60), width=max(1, int(s / 32)))
    peak = [P(5 + 22 * i / 40, 21.5 - 14 * math.sin(math.pi * i / 40) ** 1.6) for i in range(41)]
    for i in range(0, 40, 3):
        d.line([peak[i], peak[i + 1]], fill=(*SKY, 200), width=max(1, int(s / 24)))
    shaved = [P(5, 21.5), P(8.5, 20), P(12.4, 15), P(19.6, 15), P(23.5, 20), P(27, 21.5)]
    n = max(2, int(len(shaved) * progress + 0.999))
    d.line(shaved[:n], fill=(255, 255, 255), width=max(2, int(s / 13)), joint="curve")
    if progress >= 1:
        d.line([P(16, 9.6), P(16, 12.8)], fill=GREEN, width=max(2, int(s / 20)))
        d.line([P(14.4, 11.4), P(16, 13), P(17.6, 11.4)], fill=GREEN, width=max(2, int(s / 20)))


def wrap(text: str, f: ImageFont.FreeTypeFont, width: int) -> list[str]:
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if f.getlength(t) <= width:
            cur = t
        else:
            lines.append(cur)
            cur = w
    return lines + [cur]


# ------------------------------------------------------------------ captions
def chunks(text: str, maxw: int, f: ImageFont.FreeTypeFont) -> list[str]:
    """Break narration into caption chunks of at most two lines, at punctuation where possible."""
    parts, cur = [], []
    for w in text.split():
        cur.append(w)
        line = " ".join(cur)
        if (w[-1] in ".:;!?" and len(cur) >= 3) or len(wrap(line, f, maxw)) > 2 or (w[-1] == "," and len(line) > 16):
            if len(wrap(line, f, maxw)) > 2:
                cur.pop()
                parts.append(" ".join(cur))
                cur = [w]
            else:
                parts.append(line)
                cur = []
    if cur:
        parts.append(" ".join(cur))
    return [p for p in parts if p]


def draw_caption(img: Image.Image, text: str, t0: float, t1: float, t: float):
    f = font("b", CAP["size"])
    cks = chunks(text, CAP["width"], f)
    total = sum(len(c) for c in cks)
    cur, start = None, t0
    for c in cks:
        d = (t1 - t0) * len(c) / total
        if start <= t < start + d or (c is cks[-1] and start <= t <= t1 + TAIL):
            cur = (c, start, d)
            break
        start += d
    if cur is None:
        return
    c, cs, cd = cur
    lines = wrap(c, f, CAP["width"])
    words = c.split()
    wl = [len(w) + 1 for w in words]
    wt = cs + cd * np.cumsum(wl) / sum(wl)  # word i is spoken by wt[i]
    active = int(np.searchsorted(wt, t))
    lh = int(CAP["size"] * 1.28)
    d = ImageDraw.Draw(img, "RGBA")
    y0 = CAP["y"] - (len(lines) * lh) // 2 + (lh // 2 if not CAP["band"] else 0)
    if not CAP["band"]:
        bw = max(f.getlength(l) for l in lines) + 56
        d.rounded_rectangle((W / 2 - bw / 2, y0 - 16, W / 2 + bw / 2, y0 + len(lines) * lh + 10), radius=20, fill=(*NAVY2, 205))
    k = 0
    pop = ease_out(min(1.0, (t - cs) / 0.18))
    for line in lines:
        lw = f.getlength(line)
        x = W / 2 - lw / 2
        yy = y0 + (1 - pop) * 10
        for wd in line.split():
            col = (255, 255, 255) if k > active else ((255, 214, 120) if k == active else (255, 255, 255))
            if k < active:
                col = (225, 232, 242)
            d.text((x, yy), wd, font=f, fill=(*col, int(255 * pop)))
            x += f.getlength(wd + " ")
            k += 1
        y0 += lh


# ------------------------------------------------------------------ chrome (chapter, progress, logo)
def chrome(img: Image.Image, chapter: str, idx: int, n: int, prog: float, t_in: float):
    d = ImageDraw.Draw(img, "RGBA")
    a = int(255 * ease_out(min(1, t_in / 0.4)))
    if FMT == "16x9":
        d.rectangle((0, 0, W * prog, 6), fill=(*BRAND_L, 230))
        if chapter:
            f = font("b", 26)
            label = f"{idx:02d}  {chapter.upper()}"
            tw = f.getlength(label)
            d.rounded_rectangle((36, 34, 36 + tw + 44, 34 + 54), radius=27, fill=(*NAVY2, int(a * 0.86)))
            d.ellipse((54, 54, 66, 66), fill=(*GREEN, a))
            d.text((76, 45), label, font=f, fill=(255, 255, 255, a))
        bug = Image.new("RGBA", (220, 64), (0, 0, 0, 0))
        bd = ImageDraw.Draw(bug)
        bd.rounded_rectangle((0, 0, 219, 63), radius=18, fill=(*NAVY2, 200))
        mark(bd, 10, 10, 44)
        bd.text((66, 16), "ADRMS", font=font("xb", 28), fill=(255, 255, 255))
        img.paste(bug, (W - 256, 34), bug)
    else:
        big = FMT == "9x16"
        top = 60 if big else 34
        ms = 64 if big else 52
        mark(d, 36, top, ms)
        d.text((36 + ms + 16, top + (8 if big else 6)), "ADRMS", font=font("xb", 40 if big else 32), fill=(255, 255, 255))
        d.text((36 + ms + 16, top + (56 if big else 44)), "Automated Demand Response", font=font("m", 22 if big else 18), fill=(*SKY, 220))
        if chapter:
            f = font("d", 76 if big else 46)
            y = (top + ms + 70) if big else (top + 4)
            x = 36 if big else W - 36 - f.getlength(chapter)
            if big:
                d.text((36, y - 34), f"{idx:02d} / {n:02d}", font=font("s", 26), fill=(*BRAND_L, a))
            d.text((x, y + (1 - a / 255) * 12), chapter, font=f, fill=(255, 255, 255, a))
        # progress bar under the window
        py = WY + WH + 22
        d.rounded_rectangle((WX, py, WX + WW, py + 6), radius=3, fill=(255, 255, 255, 30))
        d.rounded_rectangle((WX, py, WX + max(6, WW * prog), py + 6), radius=3, fill=(*BRAND_L, 230))


# ------------------------------------------------------------------ cards
def title_card(t: float, dur: float, split: float) -> Image.Image:
    img = BG_CARD.copy()
    d = ImageDraw.Draw(img, "RGBA")
    big = W < H
    if t < split:  # hook: kinetic lines over a demand curve breaching its schedule
        lines = ["Every 15 minutes,", "the grid is billed", "for every MW", "it misses."] if big else ["Every 15 minutes,", "the grid is billed for", "every MW it misses."]
        f = font("d", 104 if big else (92 if W >= 1900 else 64))
        lh = int(f.size * 1.12)
        y0 = H * (0.2 if big else 0.22)
        for i, ln in enumerate(lines):
            p = ease_out((t - 0.25 - i * 0.45) / 0.5)
            if p <= 0:
                continue
            col = (255, 255, 255) if i < 2 else (255, 214, 120)
            d.text((W * 0.08, y0 + i * lh + (1 - p) * 28), ln, font=f, fill=(*col, int(255 * p)))
        # demand curve vs schedule
        cx0, cx1 = W * 0.08, W * 0.92
        cy = H * 0.66
        amp = H * (0.09 if big else 0.1)
        sched = cy - amp * 0.35
        d.line((cx0, sched, cx1, sched), fill=(*SKY, 160), width=3)
        d.text((cx1 - 160, sched - 40), "schedule", font=font("m", 24), fill=(*SKY, 200))
        prog = ease((t - 0.2) / max(1.0, split - 0.6))
        pts = []
        for i in range(0, 201):
            u = i / 200
            if u > prog:
                break
            v = 0.25 * math.sin(u * 7) + 0.9 * math.exp(-((u - 0.62) / 0.12) ** 2)
            pts.append((cx0 + (cx1 - cx0) * u, cy - amp * v))
        if len(pts) > 1:
            d.line(pts, fill=(*AMBER, 255), width=6, joint="curve")
            over = [p for p in pts if p[1] < sched]
            for p in over[::3]:
                d.line((p[0], p[1], p[0], sched), fill=(*CRIMSON, 90), width=3)
        return img
    # brand reveal
    u = t - split
    s = (220 if big else 200) * (0.86 + 0.14 * ease_out(u / 0.6))
    a = ease_out(u / 0.5)
    lay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ld = ImageDraw.Draw(lay)
    mx = W / 2 - s / 2
    my = H * (0.27 if big else 0.2)
    mark(ld, mx, my, s, progress=min(1.0, u / 1.2))
    lay.putalpha(lay.getchannel("A").point(lambda v: int(v * a)))
    img = Image.alpha_composite(img.convert("RGBA"), lay).convert("RGB")
    d = ImageDraw.Draw(img, "RGBA")
    f1 = font("d", 150 if big else 132)
    p1 = ease_out((u - 0.35) / 0.5)
    tw = f1.getlength("ADRMS")
    d.text((W / 2 - tw / 2, my + s + 40 + (1 - p1) * 20), "ADRMS", font=f1, fill=(255, 255, 255, int(255 * p1)))
    f2 = font("m", 40 if big else 38)
    sub = "Automated Demand Response Management System"
    p2 = ease_out((u - 0.75) / 0.5)
    for i, ln in enumerate(wrap(sub, f2, W * 0.86)):
        lw = f2.getlength(ln)
        d.text((W / 2 - lw / 2, my + s + 40 + f1.size * 1.15 + i * 52 + (1 - p2) * 14), ln, font=f2, fill=(*SKY, int(255 * p2)))
    return img


def end_card(t: float, dur: float) -> Image.Image:
    img = BG_CARD.copy()
    d = ImageDraw.Draw(img, "RGBA")
    big = W < H
    s = 150 if big else 120
    my = H * ((0.13 if H > 1500 else 0.07) if big else 0.1)
    mark(d, W / 2 - s / 2, my, s)
    f1 = font("d", 120 if big else 96)
    tw = f1.getlength("ADRMS")
    d.text((W / 2 - tw / 2, my + s + 24), "ADRMS", font=f1, fill=(255, 255, 255))
    tiers = [("1", "Batteries first", (165, 120, 230)), ("2", "Industry next", GREEN), ("3", "Rotation last", CRIMSON)]
    fy = my + s + 24 + f1.size * 1.25
    fc = font("b", 50 if big else 44)
    cw = (W * 0.8) if big else (W * 0.27)
    ch = 96
    for i, (n, label, col) in enumerate(tiers):
        p = ease_out((t - 0.35 - i * 0.55) / 0.45)
        if p <= 0:
            continue
        if big:
            x, y = W / 2 - cw / 2, fy + i * (ch + 22)
        else:
            gap = W * 0.025
            x, y = W / 2 - (3 * cw + 2 * gap) / 2 + i * (cw + gap), fy
        y += (1 - p) * 24
        d.rounded_rectangle((x, y, x + cw, y + ch), radius=28, fill=(255, 255, 255, int(22 * p)), outline=(*col, int(255 * p)), width=3)
        d.ellipse((x + 24, y + ch / 2 - 24, x + 72, y + ch / 2 + 24), fill=(*col, int(255 * p)))
        d.text((x + 48 - fc.getlength(n) / 2 * 0.62, y + ch / 2 - 21), n, font=font("b", 34), fill=(255, 255, 255, int(255 * p)))
        d.text((x + 92, y + ch / 2 - fc.size * 0.62), label, font=fc, fill=(255, 255, 255, int(255 * p)))
    p = ease_out((t - 2.2) / 0.5)
    yb = (fy + 3 * (ch + 22) + 30) if big else (fy + ch + 60)
    f3 = font("m", 36 if big else 34)
    for i, ln in enumerate(["With the operator in control.", "Automated Demand Response Management System"]):
        f = f3 if i == 0 else font("r", 28 if big else 26)
        lw = f.getlength(ln)
        d.text((W / 2 - lw / 2, yb + i * 56 + (1 - p) * 12), ln, font=f, fill=(*(SKY if i else (255, 255, 255)), int(255 * p)))
    return img


# ------------------------------------------------------------------ timeline
scenes = script["scenes"]
plan = []
t = 0.0
for i, sc in enumerate(scenes):
    a = durs[sc["id"]]
    dur = LEAD + a + TAIL + (0.5 if sc["kind"] in ("title", "end") else 0.0) + (0.8 if sc["kind"] == "end" else 0)
    plan.append({**sc, "t0": t, "dur": dur, "audio": a})
    t += dur
TOTAL = t
NSHOT = sum(1 for s in scenes if s["kind"] == "shot")


def build_moves(sc, start_cam, start_pos):
    """Keyframes for a shot scene: list of (t_start, t_arrive, cam_from, cam_to, spot_rect|None, click_point|None)."""
    moves, cam, pos = [], start_cam, start_pos
    tt = 0.0
    shot = sc["shot"]
    holds = [m.get("hold") for m in sc["moves"]]
    n = len(sc["moves"])
    fixed = sum(h for h in holds if h) + MOVE * n
    for k, m in enumerate(sc["moves"]):
        tgt = m["to"]
        sshot = tgt.split(":")[0] if ":" in tgt else shot
        rect = target(shot, tgt)
        to = frame_for(rect, m.get("spot", False))
        first_full = k == 0 and tgt == "full"
        d_move = 0.0 if (first_full and cam is None) else MOVE
        if cam is None:
            cam = (to[0], to[1], to[2] * 1.05)
        hold = m.get("hold") or max(1.2, sc["dur"] - fixed - (0 if k < n - 1 else 0))
        click = None
        if m.get("click"):
            cr = target(shot, m["click"])
            fx, fy = m.get("click_at", [0.5, 0.5])  # where in the target the click lands
            click = (cr[0] + cr[2] * fx, cr[1] + cr[3] * fy)
        prev_shot = moves[-1]["shot"] if moves else shot
        moves.append({"t0": tt, "t1": tt + d_move, "from": cam, "to": to, "spot": rect if m.get("spot") else None, "click": click, "shot": sshot, "prev_shot": prev_shot, "hold": hold})
        tt += d_move + hold
        cam = to
    return moves


for sc in plan:
    if sc["kind"] != "shot":
        continue
for i, sc in enumerate(plan):
    if sc["kind"] != "shot":
        continue
    prev = plan[i - 1] if i else None
    cont = prev and prev["kind"] == "shot" and prev["shot"] == sc["shot"]
    start = prev["moves"][-1]["to"] if cont else None
    sc["cont"] = bool(cont)
    sc["moves"] = build_moves(sc, start, None)


def cam_at(sc, tl: float):
    mv = sc["moves"]
    cur = mv[0]
    for m in mv:
        if tl >= m["t0"]:
            cur = m
    if tl < cur["t1"]:
        cam = lerp_cam(cur["from"], cur["to"], (tl - cur["t0"]) / max(1e-6, cur["t1"] - cur["t0"]))
        arrived = False
    else:
        drift = 1 - 0.025 * ease(min(1.0, (tl - cur["t1"]) / 6.0))  # slow push-in while holding
        cam = (cur["to"][0], cur["to"][1], cur["to"][2] * drift)
        arrived = True
    return cur, cam, arrived


def shot_frame(sc, tl: float) -> Image.Image:
    cur, cam, arrived = cam_at(sc, tl)
    view = render_cam(cur["shot"], cam)
    if cur["prev_shot"] != cur["shot"] and not arrived:  # this move changes screen: dissolve while the camera travels
        u = ease((tl - cur["t0"]) / max(1e-6, cur["t1"] - cur["t0"]))
        view = Image.blend(render_cam(cur["prev_shot"], cam), view, u)
    # spotlight fades in after arrival, out as the next move starts
    a = 0.0
    if cur["spot"] is not None:
        a = ease_out((tl - cur["t1"]) / 0.35) if arrived else 0.0
        nxt = [m for m in sc["moves"] if m["t0"] > cur["t0"]]
        if nxt and tl > nxt[0]["t0"] - 0.25:
            a *= max(0.0, (nxt[0]["t0"] - tl) / 0.25)
    if a > 0:
        view = spotlight(view, to_screen(cam, cur["spot"]), a)
    if cur["click"] is not None:
        ct = tl - cur["t1"] - 0.35
        dest = to_screen(cam, (*cur["click"], 0, 0))[:2]
        start = (WW * 0.82, WH * 0.9)
        p = ease(min(1.0, max(0.0, (tl - cur["t1"] + 0.2) / 0.7)))
        pos = (start[0] + (dest[0] - start[0]) * p, start[1] + (dest[1] - start[1]) * p)
        view = cursor(view, pos, ct if ct >= 0 else None)
    return view


def compose(view: Image.Image | None, sc, tl: float, card: Image.Image | None = None) -> Image.Image:
    if card is not None:
        return card
    if FMT == "16x9":
        img = view
    else:
        img = BG.copy()
        img.paste(view, (WX, WY), WIN_MASK)
    idx = [s["id"] for s in plan if s["kind"] == "shot"].index(sc["id"]) + 1
    chrome(img, sc.get("chapter", ""), idx, NSHOT, (sc["t0"] + tl) / TOTAL, tl if not sc.get("cont") else 9)
    return img


def scene_frame(sc, tl: float) -> Image.Image:
    if sc["kind"] == "title":
        say = sc["say"]
        split = LEAD + sc["audio"] * (say.index("This is") / len(say)) - 0.15
        img = title_card(tl, sc["dur"], split)
    elif sc["kind"] == "end":
        img = end_card(tl, sc["dur"])
    else:
        img = compose(shot_frame(sc, tl), sc, tl)
    draw_caption(img, sc["say"], LEAD, LEAD + sc["audio"], tl)
    return img


# ------------------------------------------------------------------ preview: render chosen moments to PNG and stop
if os.environ.get("PREVIEW"):
    for tg in [float(x) for x in os.environ["PREVIEW"].split(",")]:
        i = max(k for k, s in enumerate(plan) if s["t0"] <= tg)
        scene_frame(plan[i], tg - plan[i]["t0"]).save(f"{OUT}_{FMT}_{tg:05.1f}.png")
    print("timeline", [(s["id"], round(s["t0"], 1), round(s["dur"], 1)) for s in plan], "total", round(TOTAL, 1))
    sys.exit(0)

# ------------------------------------------------------------------ video
ff = subprocess.Popen(
    ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
     "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-r", str(FPS), OUT + ".video.mp4"],
    stdin=subprocess.PIPE,
)
nfr = int(TOTAL * FPS)
for fi in range(nfr):
    tg = fi / FPS
    i = max(k for k, s in enumerate(plan) if s["t0"] <= tg)
    sc = plan[i]
    tl = tg - sc["t0"]
    img = scene_frame(sc, tl)
    # crossfade into a scene that shows a different screen (or a card)
    nxt = plan[i + 1] if i + 1 < len(plan) else None
    if nxt and not nxt.get("cont") and tl > sc["dur"] - XF:
        # dip through the brand navy: two busy screens never dissolve into each other
        u = (tl - (sc["dur"] - XF)) / XF
        b = scene_frame(nxt, 0.0)
        img = Image.blend(img, b, ease(u))
        img = Image.blend(img, Image.new("RGB", img.size, NAVY2), 0.85 * math.sin(math.pi * u))
    if fi < 10:
        img = Image.blend(Image.new("RGB", img.size, NAVY2), img, fi / 10)
    if fi > nfr - 18:
        img = Image.blend(img, Image.new("RGB", img.size, NAVY2), (fi - (nfr - 18)) / 18)
    ff.stdin.write(img.tobytes())
    if fi % 150 == 0:
        print(f"{FMT} frame {fi}/{nfr}", flush=True)
ff.stdin.close()
ff.wait()

# ------------------------------------------------------------------ audio: narration + music bed with ducking
N = int(TOTAL * SR) + SR
voice = np.zeros(N)
for sc in plan:
    a, sr = sf.read(os.path.join(AUDIO, f"{sc['id']}.wav"))
    if a.ndim > 1:
        a = a.mean(axis=1)
    i0 = int((sc["t0"] + LEAD) * SR)
    voice[i0 : i0 + len(a)] += a[: N - i0]
tt = np.arange(N) / SR
bpm = 96
beat = 60 / bpm
chords = [[220.0, 261.63, 329.63], [174.61, 220.0, 261.63], [130.81, 196.0, 261.63], [196.0, 246.94, 293.66]]
music = np.zeros(N)
bar = beat * 4
for k in range(int(TOTAL / bar) + 2):
    c = chords[k % 4]
    a0 = int(k * bar * SR)
    if a0 >= N:
        break
    a1 = min(N, int((k + 1) * bar * SR + SR))
    seg = tt[a0:a1] - k * bar
    env = np.clip(seg / 0.6, 0, 1) * np.clip((bar + 1 - seg) / 1.0, 0, 1)
    music[a0:a1] += sum(0.5 * np.sin(2 * np.pi * f * seg) + 0.18 * np.sin(2 * np.pi * f / 2 * seg) for f in c) * env * 0.5
    for j in range(8):  # soft plucked eighth notes
        p0 = int((k * bar + j * beat / 2) * SR)
        if p0 >= N:
            break
        pl = np.arange(min(int(0.45 * SR), N - p0)) / SR
        f = c[(j * 2 + k) % 3] * 2
        music[p0 : p0 + len(pl)] += 0.22 * np.sin(2 * np.pi * f * pl) * np.exp(-pl * 7)
music /= np.max(np.abs(music)) + 1e-9
win = int(0.3 * SR)
env = np.sqrt(np.convolve(voice**2, np.ones(win) / win, mode="same"))
duck = np.where(env > 0.01, 0.12, 0.3)
duck = np.convolve(duck, np.ones(int(0.35 * SR)) / int(0.35 * SR), mode="same")
fade = np.clip(tt / 1.5, 0, 1) * np.clip((TOTAL - tt) / 2.0, 0, 1)
mix = voice / (np.max(np.abs(voice)) + 1e-9) * 0.9 + music * duck * fade
mix /= max(1.0, np.max(np.abs(mix)) / 0.97)
sf.write(OUT + ".wav", mix.astype(np.float32), SR)
subprocess.run(
    ["ffmpeg", "-y", "-loglevel", "error", "-i", OUT + ".video.mp4", "-i", OUT + ".wav", "-c:v", "copy", "-af", "loudnorm=I=-14:TP=-1.5:LRA=11", "-ar", "48000", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-shortest", OUT],
    check=True,
)
os.remove(OUT + ".video.mp4")
os.remove(OUT + ".wav")


# ------------------------------------------------------------------ captions file (for platforms that take SRT)
def ts(x: float, sep: str = ",") -> str:
    h, r = divmod(x, 3600)
    m, s = divmod(r, 60)
    return f"{int(h):02d}:{int(m):02d}:{int(s):02d}{sep}{int((s % 1) * 1000):03d}"


f = font("b", CAP["size"])
with open(os.path.splitext(OUT)[0] + ".srt", "w") as srt:
    n = 1
    for sc in plan:
        cks = chunks(sc["say"], CAP["width"], f)
        total = sum(len(c) for c in cks)
        st = sc["t0"] + LEAD
        for c in cks:
            d = sc["audio"] * len(c) / total
            srt.write(f"{n}\n{ts(st)} --> {ts(st + d)}\n{c}\n\n")
            n += 1
            st += d
print("done", OUT, round(TOTAL, 1), "s")
