# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A browser-based "stamp-ifier": turns photos into postage-stamp / souvenir-sheet (小型张) / sheetlet (小全张) images with perforated edges, configurable margins/gradients, and transparent PNG export. Pure client-side, **no build step, no dependencies, no tests, no framework**. Three files do everything: `index.html` (control panel + canvas), `index.css`, `index.js` (all logic). Chinese is the UI language; respond to the user in Chinese.

`CLAUDE.md` and `GEMINI.md` are symlinks to this file (`AGENTS.md`) — **edit `AGENTS.md`**, not the symlinks.

## Run & verify

- **Run**: open `index.html` directly in a browser (`file://` works — image export uses blob URLs so the canvas is never tainted).
- **Verify changes** (no test suite): render headlessly and screenshot, then read the PNG. Drive state by copying `index.html` to a temp `_test.html` and injecting a `<script>` after `index.js` that sets `state.*` / loads images via `new Image()` and calls `renderPreview()`. `fetch()` is blocked on `file://`, so load images with `new Image(); img.src='doc/plan/img/input.png'` (not fetch).
  ```bash
  chromium --headless --disable-gpu --no-sandbox --hide-scrollbars \
    --window-size=1000,720 --virtual-time-budget=3000 \
    --screenshot=out.png "file://$PWD/_test.html"
  ```
  Reference inputs/outputs live in `doc/plan/img/` (`input.png`, `output.png`, gifs); README demo images are in `doc/example/`. Clean up temp files after.

## Architecture

`state` (top of `index.js`) is the single source of truth; every control writes `state`, then calls `renderPreview()`. There is no virtual DOM or reactivity — `bindControls()` wires inputs, `syncInputsFromState()` pushes state back into the DOM (used on load and after programmatic changes).

### Geometry (`computeGeometry`)
All sizes derive from `pitch = holeDiameter(d) + holeGap(g)`. A single stamp is `Sw = nx*pitch` × `Sh = ny*pitch`. The matrix is `X*Y` stamps tucked edge-to-edge → block `blockW=X*Sw`, `blockH=Y*Sh`. Outer margin `m = d/2 + outerMargin*pitch` wraps the block. `cellContent(geo,c,r)` gives each cell's content rect (inset by one `pitch` inner margin). `holeCenters` lays perforation circles along X+1 vertical and Y+1 horizontal lines so adjacent stamps share a row of holes.

### Layered render (`render(targetCtx, scale)`) — the core, read this before touching rendering
Everything is drawn in **geometry pixels** under a `scale` transform; offscreen layers are built with `layerCanvas(geo, scale)`. Compositing is bottom-up and the layering is load-bearing:
1. **base** (`baseColor`@`baseOpacity`) — bottommost; this is what shows through punched holes.
2. **sheet** — `outerColor` + `outerImage` (cover), composited into `deco` at `outerOpacity`.
3. **stamp** (in `deco`) — inner fill (`innerFillStyle`: solid / linear / radial gradient spanning the **whole matrix block**) + `innerImage` (cover) + each cell's photo.
4. **holes** — `destination-out` circles punched through `deco` (sheet **and** stamp), so the base shows through → real perforation cut-outs between stamps and at edges.
5. composite to target: base, then `deco` on top.

This offscreen approach (not a single `destination-over` pass) is required so `outerOpacity`/`baseOpacity` stay uniform and gradients render in user space. The old "outer margin was the backdrop" model was replaced by the explicit base layer precisely so holes reveal a controllable bottom color.

### Photos & per-cell crop
`state.images` is an array; cell `n=r*X+c` shows `images[n % len]` (1 image→sheetlet, N→full sheet, repeats in order). Crop (zoom/pan) is **per cell**: `state.crops` is keyed `"c,r"` → `{scale,offsetX,offsetY}`; `getCrop` reads (shared identity default), `cellCrop` lazily creates an editable one. Pointer drag / wheel-zoom (cursor-anchored) act only on the cell under the cursor (`cellAt`); `clampCropCell` keeps each image covering its cell, `clampAllCrops` re-clamps after geometry changes. `state.images`/`state.crops` are **session-only** (not persisted).

### Persistence
`PERSISTED` keys are saved to `localStorage` under prefix `stampit_` (one key each, JSON) on every change and restored by `loadOptions()` at startup. Images are intentionally excluded.

## Gotchas

- **`[hidden]` needs `!important`**: `index.css` sets `display:flex` on `label`/group containers, which overrides the UA `[hidden]{display:none}`. The rule `[hidden]{display:none !important}` makes the conditional gradient/origin/color rows actually hide.
- **Preview scale (`previewScale`)**: fit mode must have **no lower clamp** or large hole diameters overflow into scrollbars; only the upper bound (`DPR_LIMIT`) is capped.
- When adding an element referenced from JS, add it to the `els` map — a missing `els.foo` makes `syncInputsFromState` throw mid-run and silently breaks initialization.
- Commit messages use Conventional Commits (`feat:`, `fix:`…); commit only when asked, and branch off `master`/`main` first.
