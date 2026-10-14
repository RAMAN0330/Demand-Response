---
name: ui-style-selection
description: Choose the visual design style for a new UI project (spatial UI, glassmorphism, neumorphism, claymorphism or maximalism) before building it. Use at the start of every new frontend, dashboard, app or website project, and whenever the user asks which design style to use or asks for a redesign.
---

# UI style selection

At the start of every new UI project, pick ONE primary style from the five below (optionally plus one accent style), state the choice and the one-line reason to the user, then build with it. Do not ask the user to choose unless the project type is genuinely unclear; recommend, and let them override.

## The five styles

| Style | What it is | Strengths | Weaknesses |
|---|---|---|---|
| **Spatial UI** | The content's real space (map, floor plan, 3D model, canvas) is the workspace; panels float over it with depth hierarchy; selecting an object moves the camera to it and anchors its details beside it. | Shows *where* things are; keeps context; great for anything physical or geographic. | Needs real spatial data; heavier to build (3D/map stack); poor fit for list/form-heavy apps. |
| **Glassmorphism** | Translucent frosted panels (backdrop blur) over a meaningful background. | Keeps the background visible under overlays; modern, light. | Text readability drops over busy backgrounds; costly blur on low-end devices. Best as an **accent**, not a base. |
| **Neumorphism** | Soft extruded/pressed shapes, same colour as background, low contrast. | Calm, tactile, minimal. | Poor contrast and accessibility (fails WCAG easily); pressed vs unpressed states are ambiguous. Only for tiny, low-stakes surfaces (a single control panel, a music player). |
| **Claymorphism** | Chunky, rounded, inflated 3D-looking shapes with soft inner shadows and pastel colours. | Friendly, playful, memorable. | Wastes space; reads as a toy in professional contexts. |
| **Maximalism** | Bold colour, dense layering, mixed type, decoration as a feature. | Strong personality and brand expression; stands out. | Competes with status and error signals; tiring for long sessions; hard to scan. |

## Decision procedure

1. **Is the work about stakes and speed?** For example operations, control rooms, monitoring, trading, medical, admin consoles, or anything with alarms, approvals or long sessions.
   - Use a calm, muted base where colour is reserved for state (ISA-101 "high-performance HMI" principle).
   - Never use neumorphism, claymorphism or maximalism here.
   - If the domain is physical or geographic (grid, fleet, logistics, buildings, field assets, maps), choose **Spatial UI + Glassmorphism accent**.
   - Otherwise choose a **clean flat base + Glassmorphism accent** only for overlays (drawers, popovers, floating panels).
2. **Is it a data-heavy productivity tool** (CRM, analytics, internal tools, SaaS dashboards)?
   - Use a **clean flat base**. Add Glassmorphism only for overlays.
   - Add Spatial UI only if there is real spatial data.
3. **Is it consumer, onboarding, education, kids or a habit/wellness app?**
   - Choose **Claymorphism** (with accessible contrast on text).
   - Use Glassmorphism for hero or overlay moments.
4. **Is it brand, marketing, portfolio, editorial, fashion, music or an event site** (expression over efficiency)?
   - Choose **Maximalism**, kept to marketing surfaces.
   - Any functional flow inside it (checkout, forms) stays clean.
5. **Is it a small device-like surface** (a single widget, smart-home or media control, settings panel)?
   - **Neumorphism** is acceptable.
   - Verify contrast ≥ 4.5:1 for text and add a non-shadow cue (colour or icon) for on/off states.
6. **Immersive or 3D product** (configurator, digital twin, AR/VR, games, visualisation)? Choose **Spatial UI**.

When two rules match, the higher-stakes rule wins (rule 1 beats everything).

## Non-negotiables in every style

- Text contrast meets WCAG AA (4.5:1 body, 3:1 large text and UI components); test glass panels over the busiest background they can appear on.
- State never relies on shadow or translucency alone; pair it with colour, icon or label.
- Colours for error, warning and success are reserved for meaning, not decoration.
- Respect `prefers-reduced-motion`; and for glass, fall back to an opaque surface when `backdrop-filter` is unsupported or performance is poor.
- Keep one spacing scale, one radius scale and at most two typefaces (maximalism may use three on marketing surfaces).

## Implementation notes (Tailwind / shadcn)

- **Glass panel (generic default; ADRMS uses its house recipe below):** `bg-white/85 backdrop-blur-md border border-white/60 shadow-lg shadow-slate-900/5`. Use a dark variant `bg-slate-900/70` on dark maps. Keep opacity at 80% or more when text sits on it.
- **Spatial:** make the map or canvas the page background (`fixed inset-0`). Panels go in an overlay layer with `pointer-events-none` on the layer and `pointer-events-auto` on each panel. Use camera fly-to on selection and anchor detail cards to the selected object.
- **Neumorphism:** use two shadows (light top-left, dark bottom-right) on a background-coloured surface. Use an inset version for the pressed state.
- **Claymorphism:** use large radius (`rounded-3xl`), pastel fill, an outer soft shadow plus an inner highlight (`shadow-[inset_0_-6px_12px_rgba(0,0,0,.08),0_12px_24px_rgba(0,0,0,.08)]`).
- **Maximalism:** use a bold palette of 4–6 hues, oversized display type, layered imagery and texture. Keep the grid underneath so it still scans.

## This project's house theme (ADRMS)

ADRMS uses **Spatial UI + Glassmorphism**: the lavender backdrop and the 3D map are the space, and every panel is frosted glass floating over it. Use this theme for every page and component in this repo. Tokens live in `web/src/index.css`, and nothing outside that file hard-codes a brand hex.

**Palette** (the Tailwind `sky-*` scale is remapped to `brand-*`, so `sky-700` means brand indigo):

| Role | Token | Value |
|---|---|---|
| Page background | `--background` | `#f7f5fd` lavender white |
| Backdrop | `.spatial-backdrop` | violet light pool top-left, peach top-right, violet bottom-right, 32 px grid at 7 % violet |
| Primary (buttons, active nav) | `--primary` / `brand-800` | `#34208f` deep indigo |
| Brand scale | `brand-50 … 950` | `#f3f1fe` `#e7e3fd` `#d2cafb` `#b1a3f6` `#8d76ee` `#6d4fe3` `#5735cf` `#4527b0` `#34208f` `#281a6e` `#180f45` |
| Accent text | `text-gradient` | `#5735cf → #9b4dca → #e0883a` (violet to orange) |
| Borders / inputs / focus ring | `--border` / `--input` / `--ring` | `#e2ddf0` / `#cbc4e0` / `#8d76ee` |
| Categorical layers | as in the reference | green `#22c55e`-family, blue, violet, amber, for data series and map layers only |
| Status | emerald / amber / rose | unchanged; reserved for state (ISA-101) |

**Glass recipe** (`@utility` in `index.css`; never rebuild it with ad-hoc classes):

- `surface-panel`: 16 px radius, `rgb(255 255 255 / 0.66)`, `blur(18px) saturate(1.7)`, a white 75 % border, an inner top highlight (`inset 0 1px 0 #fff/90`) and the indigo-tinted `--shadow-float`.
- `surface-tile`: 12 px radius, 72 % white, `blur(16px)`.
- `surface-chip`: for controls over the 3D scene, 84 % white, because the scene is busier than the backdrop.
- Shadows are tinted with the brand indigo (`rgb(52 32 143 / …)`), never neutral grey.
- The top bar is glass too: `bg-white/70 backdrop-blur-xl`.
- Opaque white fallback is used when `backdrop-filter` is unsupported. Don't mix `surface-*` with `rounded-*`, `ring-*` or `shadow-*`; signal state with a `!border-…` colour instead.

**Rules**

- `text-gradient` is for the wordmark and hero or marketing words only. Never use it on numbers, status or body text.
- Keep glass at ≥ 66 % white over the backdrop and ≥ 84 % over the 3D scene, so text keeps AA contrast.
- Charts use brand violet (`#6d4fe3`, `#5735cf`) for the primary series. Data-meaning colours (DISCOMs, fuel types, hydro water) keep their own hues.
- The 3D scene follows the theme:
  - lavender background and fog `#f3f0fb`, ground grid `#e6e1f4` / `#d8d0ee`, state outline `#7c5ae8`;
  - pastel hypsometric terrain (coast `#e9f3e3`, plateau `#f5efdf`, Ghats `#b3d6a6`) with baked hillshade;
  - lattice towers in steel `#8f93a8`;
  - sun shadows following the grid clock.
  - Line loading and alarm colours must stay the loudest thing on the map.

## Output to the user

Start the project with one short line, for example:
"Style: Spatial UI + glass accents — it's a geographic operations tool where operators need to see where problems are and colour must be reserved for alarms."
