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
All sizes derive from `pitch = holeDiameter(d) + holeGap(g)`. A single stamp is `Sw = nx*pitch` × `Sh = ny*pitch`. The matrix is `X*Y` stamps tucked edge-to-edge → block `blockW=X*Sw`, `blockH=Y*Sh`. Outer margin `m = d/2 + outerMargin*pitch` wraps the block. `holeCenters` lays perforation circles along X+1 vertical and Y+1 horizontal lines so adjacent stamps share a row of holes.

**Span groups (连票) are the unit of photo layout, not cells.** `spanX`/`spanY` (default `1×1`) chunk the matrix into `groupsX = ceil(X/spanX)` × `groupsY = ceil(Y/spanY)` groups; one photo fills each whole group, so `spanX*spanY` adjacent stamps form a single continuous picture broken only by perforations. `groupRect(geo,gc,gr)` → `{c0,r0,cw,ch}` (the group's cell range, clamped to the matrix edge, so a non-dividing span leaves narrower **remnant groups** on the last column/row). `groupFrame(geo,gc,gr)` → its frame rect, inset by the per-side inner margin `innerMargin{Top,Right,Bottom,Left} * pitch` (default 0.75 each; both margin cross-pads share the `MARGIN_PADS` control logic) — **the inner margin applies only at the group's outer edge**, so cells inside a group butt together with no white gutter. `groupContent(geo,gc,gr)` → the **photo** rect: `groupFrame` inset a second time by `borderWidth + borderGap` (both in **pixels**, not pitch), so turning on a border shrinks the photo rather than covering it. `spanX=spanY=1` degenerates to per-cell layout and is byte-identical to the pre-span renderer (verified by pixel diff).

### Layered render (`render(targetCtx, scale)`) — the core, read this before touching rendering
Everything is drawn in **geometry pixels** under a `scale` transform; offscreen layers are built with `layerCanvas(geo, scale)`. Compositing is bottom-up and the layering is load-bearing:
1. **base** (`baseColor`@`baseOpacity`) — bottommost; this is what shows through punched holes.
2. **sheet** — `outerColor` + `outerImage` (cover), composited into `deco` at `outerOpacity`.
3. **stamp** (in `deco`) — inner fill (`innerFillStyle`: solid / linear / radial gradient spanning the **whole matrix block**) + `innerImage` (cover, also block-wide) + each span group's photo + each group's **border** (solid stroke hugging the inside of `groupFrame`, `borderColor`@`borderOpacity`, skipped when `borderWidth` is 0; over-thick values clamp to `min(w,h)/2` so the frame degenerates to a filled block instead of overflowing). `innerFill`/`innerImage` stay **block-level regardless of span** — they are deliberately not repeated per group, which is what lets a global gradient/backdrop sit under several independent span groups.
4. **holes** — `destination-out` circles punched through `deco` (sheet **and** stamp), so the base shows through → real perforation cut-outs between stamps and at edges.
5. composite to target: base, then `deco` on top.

This offscreen approach (not a single `destination-over` pass) is required so `outerOpacity`/`baseOpacity` stay uniform and gradients render in user space. The old "outer margin was the backdrop" model was replaced by the explicit base layer precisely so holes reveal a controllable bottom color.

### Photos & per-group crop
`state.images` is an array; span group `n=gr*groupsX+gc` shows `images[n % len]` via `groupImage` (1 image→sheetlet, N→full sheet, repeats in order — same row-major-repeat rule as before, just indexed by group instead of cell). Crop (zoom/pan) is **per group**: `state.crops` is keyed by the group's **start cell** `"c0,r0"` → `{scale,offsetX,offsetY}`; `getCrop` reads (shared identity default), `groupCrop` lazily creates an editable one. Because `1×1` groups start at their own cell, existing per-cell crop keys keep working unchanged. Pointer drag / wheel-zoom (cursor-anchored) act only on the group under the cursor (`groupAt`); `clampCropGroup` keeps each image covering its group's content rect, `clampAllCrops` re-clamps after geometry changes. Changing span can orphan crop keys that are no longer group starts — they are **kept, not pruned**, so switching span back revives them. Drag/zoom also retarget by cursor region: outside the matrix block → `outerImage`/`outerCrop`; inside → the group photo, or the `innerImage`/`innerCrop` when Alt/Option is held (or when no photos are loaded) — see `hitTarget`/`cropContext`. Note remnant groups have a different aspect ratio from full ones, so the same looping image covers differently in each. Image **bytes** and their crops now persist across refresh (see Persistence).

### Tab groups
Tabbed control panels are config-driven, not hardcoded: `TAB_GROUPS` lists `{key, bar, fallback, panels}` per group (`stampTab` → 矩阵/齿孔, `layerTab` → 边框/内边距/外边距/底色). `updateTabs()` toggles `.active` and `hidden` for every group and falls back to `fallback` on an illegal persisted/imported value; `bindTabs()` delegates clicks on each `.tab-bar`. Adding a tab group = one `TAB_GROUPS` entry + its `els` ids + the `state` key in `PERSISTED`. Markup: use `.tabs-group` when the whole `<section>` is tabs, `.tabs` for a tab region inside a section that also has controls outside the tabs (the file picker sits outside `stampTab`'s tabs).

### Persistence
`PERSISTED` keys (settings **and** crops — `crops`/`outerCrop`/`innerCrop`) are saved to `localStorage` under prefix `stampit_` (one key each, JSON) on every change and restored by `loadOptions()` at startup. Image **bytes** are too big for localStorage, so the original `File` blobs go to **IndexedDB** (`idbOpen/idbPut/idbGet/idbDelete`, DB `stampit`, store `images`, keys `grid`/`outer`/`inner`). On startup, after the synchronous first render, `restoreImages()` async-reads the blobs, decodes via `blobToImage`, sets `state.images`/`outerImage`/`innerImage` (without resetting the already-restored crops), then re-renders. All IndexedDB ops fail silently → if IDB is unavailable the app degrades to no image-persistence (settings/crops still persist). Note: IndexedDB blob round-trips **stall under headless `--virtual-time-budget`**; verify image persistence over `http://localhost` driving real-time Chromium via CDP, not the virtual-time screenshot path.

## Gotchas

- **`[hidden]` needs `!important`**: `index.css` sets `display:flex` on `label`/group containers, which overrides the UA `[hidden]{display:none}`. The rule `[hidden]{display:none !important}` makes the conditional gradient/origin/color rows actually hide.
- **Panel width lives in two places**: `.panel { width }` in `index.css` and `PANEL_W` in `index.js` (used by `previewScale` to compute the free stage width). Change both together, or fit-mode sizing drifts.
- **Preview scale (`previewScale`)**: fit mode must have **no lower clamp** or large hole diameters overflow into scrollbars; only the upper bound (`DPR_LIMIT`) is capped.
- When adding an element referenced from JS, add it to the `els` map — a missing `els.foo` makes `syncInputsFromState` throw mid-run and silently breaks initialization.
- Commit messages use Conventional Commits (`feat:`, `fix:`…); commit only when asked, and branch off `master`/`main` first.
