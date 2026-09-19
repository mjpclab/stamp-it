# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A browser-based "stamp-ifier": turns photos into postage-stamp / souvenir-sheet (小型张) / sheetlet (小全张) images with perforated edges, configurable margins/gradients, and transparent PNG export. Pure client-side, **no build step, no dependencies, no tests, no framework**. Three files do everything: `index.html` (control panel + canvas), `index.css`, `index.js` (all logic). Chinese is the UI language; respond to the user in Chinese. A thin PWA layer (`manifest.webmanifest`, `sw.js`, three icons) sits beside them — see PWA below.

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
- **Verifying narrow (mobile) viewports**: headless Chromium **clamps the window to ≥500px wide** and gives a viewport ~87px shorter than the requested `--window-size` height, so `--window-size=390,844` silently renders a 500×757 layout and screenshots a 390-wide *crop* of it — layout looks broken when it isn't. Instead put the app in an exactly-sized iframe and screenshot the wrapper with a window big enough to contain it:
  ```html
  <!-- _frame.html -->
  <body style="margin:0"><iframe src="_test.html" width="390" height="844" style="border:0"></iframe></body>
  ```
  ```bash
  chromium --headless --disable-gpu --no-sandbox --hide-scrollbars \
    --window-size=420,940 --virtual-time-budget=4000 --screenshot=out.png "file://$PWD/_frame.html"
  ```
  The iframe document gets a genuine 390×844 layout viewport (`dvh` resolves against it too).
- **Asserting on numbers instead of pixels**: for geometry/behavior checks, have the injected script write results into `document.title` and read them with `--dump-dom | grep`, rather than eyeballing a screenshot. Gestures can be unit-tested this way by dispatching synthetic `PointerEvent`s (stub `canvas.setPointerCapture = () => {}` first — a synthetic `pointerId` is not an active pointer and real capture throws).
- **Pixel-diff harnesses must hide the control panel first**: a full-page screenshot includes `.panel`/`.drawer-handle`, whose inputs legitimately differ across a layout-semantics change, so those panel pixels poison any pixel-diff gate. Before rendering, inject:
  ```js
  document.head.insertAdjacentHTML('beforeend',
    '<style>.panel,.drawer-handle{display:none!important}</style>');
  ```
  A "before" baseline is re-derivable at any time from committed history with `git archive <commit> | tar -x -C <tmpdir>`; sanity-check a baseline pair against each other with a non-zero `compare -metric AE` so the gate cannot pass vacuously. This rule is specific to pixel diffs — a harness making **DOM assertions about the panel** must NOT hide it.

## Architecture

`state` (top of `index.js`) is the single source of truth; every control writes `state`, then calls `renderPreview()`. There is no virtual DOM or reactivity — `bindControls()` wires inputs, `syncInputsFromState()` pushes state back into the DOM (used on load and after programmatic changes).

### Geometry (`computeGeometry`)
All sizes derive from `pitch = holeDiameter(d) + holeGap(g)`. A single stamp is `Sw = nx*pitch` × `Sh = ny*pitch`. The matrix is `X*Y` stamps tucked edge-to-edge → block `blockW=X*Sw`, `blockH=Y*Sh`. Outer margin `m = d/2 + outerMargin*pitch` wraps the block. `holeCenters` lays perforation circles along X+1 vertical and Y+1 horizontal lines so adjacent stamps share a row of holes.

**Span regions are the unit of photo layout, not cells.** `state.merges` holds only the
regions that cover more than one cell (`{c, r, w, h, big}`); `computeGroups(X, Y, merges)`
places each one (clamped to the matrix, **first-wins** on overlap, ignored if clipping
leaves it a single cell), fills every unclaimed cell with a 1×1 region, and sorts by
`(r0, c0)` — which is also the photo-fill order. `geo.groups` is that list and
`geo.cellGroup` is an `Int32Array` cell→index lookup so `groupAt` stays O(1) during drags.
An empty `merges` is the per-cell mode. `uniformMerges(X, Y, spanX, spanY)` regenerates the
list as a uniform split (the 连票宽×高 / 应用 controls, labelled 均匀分块 internally);
`state.spanX`/`spanY` are now **only** that button's remembered inputs and do not affect
geometry — every region it produces is `big: false` (连票), which is the button's whole point:
it is the "make se-tenant strips" path, distinct from the hand-drawn merge below.
Out-of-bounds merges are clipped for rendering but **kept in `state.merges` unmodified**, so
shrinking and re-growing the matrix
revives them — the same policy as orphaned crop keys. `groupFrame(geo, g)` → the region's
frame rect, inset by the per-side inner margin (**the inner margin applies only at the
region's outer edge**, so cells inside a region butt together with no white gutter);
`groupContent(geo, g)` → the photo rect, inset again by `borderWidth + borderGap`;
`groupOuterRect(geo, g)` → the un-inset cell rect, used by perforation suppression.
Regions are **rectangles only** — L-shapes are out of scope.

**大票 vs 连票.** A region with `big: true` renders as one large-format stamp:
`holeCenters` drops every hole **strictly inside** its `groupOuterRect` (strict inequalities
plus a `1e-6` epsilon, because `r0*(ny*pitch)` and `(r0*ny)*pitch` can differ by a ULP). Holes
*on* the boundary are all kept, so the outer perforation ring stays unbroken and the interior
gridlines' endpoints — which coincide with boundary positions — survive. `big: false` keeps
every hole, which is the se-tenant (连票) look.

**Default big/连票 by path, and inheritance on merge.** The two ways to create a multi-cell
region default to opposite kinds, and the region-grid UI (button order, mini-grid legend) is
built to make that legible: 均匀分块 (`uniformMerges`, the 连票宽×高/应用 controls) always
produces `big: false` — it's the "make a se-tenant sheet" shortcut. A hand-drawn merge (拖选 +
合并) defaults to `big: true` **unless** it absorbs existing multi-cell regions, in which case
it inherits their kind: `big: false` only if *every* absorbed region is `big: false`, `big: true`
if any absorbed region is. Absorbing zero multi-cell regions (a merge built purely from 1×1
cells) has no precedent to inherit, so it falls through to the hand-drawn default (`big: true`).
See the `absorbed`/`big` computation in `mergeBtn`'s click handler (`regionsWithin`, shared with
`renderRegionGrid`'s covered-region check) — reading `absorbed.length === 0` as "no multi-cell
region survives" would make every fresh merge default to 连票 and silently cancel this rule.

### Layered render (`render(targetCtx, scale)`) — the core, read this before touching rendering
Everything is drawn in **geometry pixels** under a `scale` transform; offscreen layers are built with `layerCanvas(geo, scale)`. Compositing is bottom-up and the layering is load-bearing:
1. **base** (`baseColor`@`baseOpacity`) — bottommost; this is what shows through punched holes.
2. **sheet** — outer fill (`fillStyle(ctx, geo, 'outer')`: solid / linear / radial gradient spanning the **whole canvas**) + `outerImage` (cover), composited into `deco` at `outerOpacity`.
3. **stamp** (in `deco`) — inner fill (`fillStyle(ctx, geo, 'inner')`: solid / linear / radial gradient spanning the **whole matrix block**) + `innerImage` (cover, also block-wide) + each region's photo + each region's **border** (solid stroke hugging the inside of `groupFrame`, `borderColor`@`borderOpacity`, skipped when `borderWidth` is 0; over-thick values clamp to `min(w,h)/2` so the frame degenerates to a filled block instead of overflowing). `innerFill`/`innerImage` stay **block-level regardless of region layout** — they are deliberately not repeated per region, which is what lets a global gradient/backdrop sit under several independent regions.
4. **holes** — `destination-out` circles punched through `deco` (sheet **and** stamp), so the base shows through → real perforation cut-outs between stamps and at edges.
5. composite to target: base, then `deco` on top.

This offscreen approach (not a single `destination-over` pass) is required so `outerOpacity`/`baseOpacity` stay uniform and gradients render in user space. The old "outer margin was the backdrop" model was replaced by the explicit base layer precisely so holes reveal a controllable bottom color.

### Fill groups (内/外边距填充)
Inner and outer margin fills share one implementation, keyed by the prefix strings in `FILL_GROUPS` (`'inner'`, `'outer'`). Every state key and DOM id is `prefix + suffix` (`outerFill`, `outerStops`, `outerAngle`, `outerOriginX/Y`, `#outerColorRow`, `#outerStopsEditor`, …) — `els` entries are filled by looping `FILL_EL_SUFFIXES`, and `syncFillGroup`/`updateFillControlsVisibility`/`renderStopsEditor`/`bindFillGroup` all take the prefix. The **only** per-group difference is the gradient's reference rect in `FILL_RECTS`: inner = the matrix block, outer = the whole canvas. Adding a third fill group = one `FILL_RECTS` entry + the matching state keys, `PERSISTED` entries, and prefixed markup.

### Photos & per-region crop
`state.images` is an array; region `i` in `geo.groups` (already sorted `(r0, c0)`) shows `images[i % len]` via `groupImage` (1 image→sheetlet, N→full sheet, repeating in that same row-major order). Crop (zoom/pan) is **per region**: `state.crops` is keyed by the region's **start cell** `"c0,r0"` → `{scale,offsetX,offsetY}`; `getCrop` reads (shared identity default), `groupCrop` lazily creates an editable one. Crop keys are the region's **start cell**, which stays unique under an irregular tiling and survives a clip (clipping shrinks `cw`/`ch`, never the origin), so crop data carries across layout changes untouched. Pointer drag / wheel-zoom (cursor-anchored) act only on the region under the cursor (`groupAt`, an O(1) lookup through `geo.cellGroup`); `clampCropGroup` keeps each image covering its region's content rect, `clampAllCrops` re-clamps after geometry changes.

**Drag-target identity.** `hitTarget`/`groupTarget` record a gesture's target as the region's **start cell** `{c0, r0}` — never an index into `geo.groups`. `cropContext` re-resolves the region by that origin on every frame (`geo.groups.findIndex`), because the region list is rebuilt each render and both grows (拆分, 全部还原) and reorders (inserting an earlier-sorting merge), so an index captured at `pointerdown` can silently come to name a different region a frame later. A target whose origin no longer exists (its region was absorbed by a merge) degrades `cropContext` to an inert no-op crop context rather than throwing or retargeting.

Editing regions (合并/拆分/均匀分块/全部还原) or resizing the matrix can orphan crop keys that are no longer region starts — they are **kept, not pruned** (same policy as `state.merges`, see Geometry), so reverting the edit revives them. Drag/zoom also retarget by cursor region: outside the matrix block → `outerImage`/`outerCrop`; inside → the region's photo, or the `innerImage`/`innerCrop` when Alt/Option is held (or when no photos are loaded) — see `hitTarget`/`cropContext`, and the drag-target lock under Responsive layout & touch for the touch-device path. A region clipped by the matrix edge has a different aspect ratio from an unclipped one, so the same looping image covers differently in each. Image **bytes** and their crops now persist across refresh (see Persistence).

### Tab groups
Tabbed control panels are config-driven, not hardcoded: `TAB_GROUPS` lists `{key, bar, fallback, panels}` per group (`stampTab` → 矩阵/齿孔, `layerTab` → 边框/内边距/外边距/底色). `updateTabs()` toggles `.active` and `hidden` for every group and falls back to `fallback` on an illegal persisted/imported value; `bindTabs()` delegates clicks on each `.tab-bar`. Adding a tab group = one `TAB_GROUPS` entry + its `els` ids + the `state` key in `PERSISTED`. Markup: use `.tabs-group` when the whole `<section>` is tabs, `.tabs` for a tab region inside a section that also has controls outside the tabs (the file picker sits outside `stampTab`'s tabs).

### Responsive layout & touch
One breakpoint, `@media (max-width: 860px)`, turns the desktop two-column layout into **preview on top + control panel as a bottom drawer**. `.app` is a flex row on desktop and `column-reverse` below the breakpoint: DOM order is `.panel` → `.drawer-handle` → `.stage`, so reversing the main axis alone yields 预览 → 把手 → 面板 without any `order` declarations. The handle is a sibling of both panel and stage, so it never scrolls with the panel. `.drawer-handle` toggles `body.drawer-open`; collapsed = `.panel { height: 0 }` so the canvas takes the whole screen. There is **no height transition** on purpose — animating it would fire the `ResizeObserver` (and a full canvas redraw) every frame.

Sizing is measurement-based, not breakpoint-based: `.canvas-area` (`flex:1; min-height:0; overflow:auto`) is the only element `previewScale` looks at, so drawer open/close, orientation change, and the soft keyboard all just work. `.app` uses `100dvh`, not `100vh`, so mobile URL bars don't clip the bottom.

Touch affordances: `input`/`select` go to `font-size: 16px` inside the query (below 16px iOS Safari auto-zooms the page on focus) and controls to ≥44px; `.stop-row input[type="color"]` needs its own override since `.stop-row input[…]` outranks the bare type selector. Operating hints are two mutually exclusive `<p>`s (`.desktop-only` / `.touch-only`).

**Gestures** (`bindCanvasInteractions`): a `pointers` Map drives both modes — 1 pointer pans, 2 pinch-zoom (re-hit at the midpoint, scaled by the distance ratio), 3+ freeze but keep re-baselining so dropping back to 2 doesn't jump. `zoomAt(geo, target, factor, anchor)` holds the anchor pixel still and is shared by the wheel handler and pinch, and returns `false` at the 1–5× clamp so callers can skip the redraw. `saveOptions()` fires once when the last pointer lifts, not per move.

**Drag target lock** (`state.dragTarget`, in `PERSISTED`): the `.seg` control above the canvas forces gestures onto `photo` / `inner` / `outer`, since touch devices have no Alt key to reach `innerImage`. `'auto'` reproduces the original Alt/region-based inference exactly. A lock whose image is missing **falls back to `'auto'` rather than dead-ending** (`DRAG_TARGET_READY`), and the lock revives when the image comes back — which matters because `restoreImages()` populates images asynchronously after the first render. `updateDragTargetSeg()` is called from `renderPreview()` and guards its DOM writes with a signature string, since `renderPreview` runs every drag frame.

### Persistence
`PERSISTED` keys (settings, crops — `crops`/`outerCrop`/`innerCrop` — and `merges`) are saved to `localStorage` under prefix `stampit_` (one key each, JSON) on every change and restored by `loadOptions()` at startup. `merges` rides in `PERSISTED`, so scheme export/import and `resetScheme` cover it for free. There is no migration from the pre-region format: `spanX`/`spanY` in an old saved state no longer affect geometry, so an old profile opens in per-cell mode until 均匀分块 is applied. The same no-migration rule applies to `importScheme`: a scheme file written before this branch carries no `merges` key, and since the importer otherwise skips keys absent from the file (leaving whatever the user currently has), it explicitly resets `state.merges = []` when the imported settings have no valid `merges` array, rather than silently keeping the current region layout. Image **bytes** are too big for localStorage, so the original `File` blobs go to **IndexedDB** (`idbOpen/idbPut/idbGet/idbDelete`, DB `stampit`, store `images`, keys `grid`/`outer`/`inner`). On startup, after the synchronous first render, `restoreImages()` async-reads the blobs, decodes via `blobToImage`, sets `state.images`/`outerImage`/`innerImage` (without resetting the already-restored crops), then re-renders. All IndexedDB ops fail silently → if IDB is unavailable the app degrades to no image-persistence (settings/crops still persist). Note: IndexedDB blob round-trips **stall under headless `--virtual-time-budget`**; verify image persistence over `http://localhost` driving real-time Chromium via CDP, not the virtual-time screenshot path.

### PWA
`manifest.webmanifest` + `sw.js` + `icon-192.png`/`icon-512.png`/`icon-maskable-512.png` (repo root, flat like everything else) make the app installable and fully offline-capable. `index.html` only adds a `theme-color` meta and the manifest/icon/`apple-touch-icon` links (iOS ignores manifest `icons`) — there is no inline script. Registration is `registerServiceWorker()` in `index.js`, called last in the 启动 block; it registers immediately (no `load` wait — by the time `index.js` runs, the three first-paint assets are already down, so precaching has no bandwidth to steal) and swallows the failure.

**Every path is relative** (`start_url`/`scope`/`id` = `"./"`, icons `"./icon-…"`, register `'sw.js'` — resolved against the *document* URL, not the script's, so living in `index.js` changes nothing) because the same files must serve from a domain root *and* from GitHub Pages' `/stamp-it/` subpath. Never introduce an absolute path here — verified working under both.

`sw.js` precaches the 8 static assets on install (offline-ready immediately), then serves **navigations network-first** (falling back to the cached `./index.html`) and **everything else stale-while-revalidate**. The SWR half is deliberate: it means a deploy reaches users on their *second* load without anyone remembering to bump `CACHE`. The `CACHE` constant is only a manual nuke switch — `activate` deletes every cache whose name differs. Non-GET and cross-origin requests are passed through untouched. There is intentionally no "new version available, click to reload" UI.

**The SW caches your edits during local development.** `file://` is unaffected (no SW there), but the `http://localhost` + CDP path used to verify IndexedDB will happily serve you a stale `index.js` — a code change appears to do nothing, then works on the next reload. Use a throwaway `--user-data-dir` per run, or `Page.setBypassServiceWorker`, when driving localhost.

`file://` still works and must keep working — the only symptom is one harmless console warning that the manifest was blocked by CORS.

## Gotchas

- **`[hidden]` needs `!important`**: `index.css` sets `display:flex` on `label`/group containers, which overrides the UA `[hidden]{display:none}`. The rule `[hidden]{display:none !important}` makes the conditional gradient/origin/color rows actually hide. **Exception: `#regionKind`** (the 大票/连票 toggle) uses `.seg-hidden { visibility: hidden }` instead of the `hidden` attribute, on purpose — `[hidden]`'s `display:none` would drop it from layout and make the panel's scroll height jump every time the region-grid selection changes; `visibility: hidden` keeps its box reserved. Any other element that toggles visibility from selection state (as opposed to a one-shot mode switch like the tabs) should default to this pattern too.
- **Preview scale (`previewScale`)**: fit mode **measures `#canvasArea`** (`stageAvail()`) — never re-derive the free space from `window.innerWidth` minus the panel width, which is what the deleted `PANEL_W` constant did (it under-measured by ~30px and broke the moment the panel stopped being a fixed-width left column). Fit mode must also have **no lower clamp** or large hole diameters overflow into scrollbars; only the upper bound (`DPR_LIMIT`) is capped.
- **`bindStageResize()`'s dedup is load-bearing**: the `ResizeObserver` on `#canvasArea` re-renders on any size change, but a 1:1-view re-render can toggle that element's scrollbars, which changes its content box again → infinite loop. The `lastAvail` comparison (written by `renderPreview`) is what breaks the cycle. Verified: 1:1 view with overflowing geometry settles in 2 renders.
- **`imageSmoothingQuality = 'high'` is set on every context that draws images** (the three `layerCanvas` layers, which is where all photo/background `drawImage` calls happen, plus the target context). Its effect is **platform-dependent, and the platforms disagree** — so judge it on the device that matters, not on the dev machine:
  - **iOS Safari: it works**, visibly better than the default (confirmed on device by the repo owner). This is the reason the setting exists.
  - **Chromium: measured no-op.** A 1600×1600 high-frequency checkerboard downscaled 8× produced a byte-identical result under `'low'` and `'high'`, on both the software and default GPU paths, even though the property reads back correctly. Do not expect it to fix a Chromium sharpness complaint, and do not delete it as dead code after testing only in Chrome.

  It must be assigned **after** `canvas.width/height`, since resizing resets context state.
- When adding an element referenced from JS, add it to the `els` map — a missing `els.foo` makes `syncInputsFromState` throw mid-run and silently breaks initialization.
- **`renderRegionGrid`'s signature dedup is load-bearing**: it runs from `renderPreview`,
  which fires every drag frame; rebuilding the grid's DOM each frame would thrash the panel
  and drop the selection. The `lastRegionSig` comparison (which includes the selection) is
  what keeps it to one rebuild per actual change.
- **The 大票 hole filter needs its epsilon.** Comparing a hole's `mT + k*pitch` against a
  region boundary's `mT + r0*(ny*pitch)` is exact in maths and off by a ULP in floating
  point. Without `EPS`, a boundary hole is occasionally judged interior and dropped, leaving
  a visible gap in a large-format stamp's perforation ring.
- **`state.merges` is never pruned.** Out-of-bounds merges are clipped for rendering but kept
  verbatim, so a matrix shrink/grow round trip revives them — mirroring the orphaned-crop-key
  policy above. Any code that removes merges by region must test **intersection**, not
  containment (`mergeIntersectsRect`, not "is this merge fully covered by the selection"), or
  an invisible out-of-bounds merge survives, later wins `computeGroups`'s first-wins pass, and
  silently discards a user's new merge.
- **`computeGroups` is not the only consumer of `state.merges`.** The region-grid's 合并/拆分/
  大票 click handlers (`bindRegionGrid`) read `state.merges` directly. `mergeIntersectsRect(m,
  rect)` and `mergeOriginMatches(m, c0, r0)` are safe by construction for a malformed entry
  (e.g. `null` from a corrupted import): they call `isValidMergeRecord(m)` themselves and
  return `false` rather than throwing, so **no caller needs to check validity before calling
  them** — the click handlers just do `state.merges.filter((m) => !mergeIntersectsRect(m, s))`
  etc., no `isValidMergeRecord` in sight. `computeGroups` still calls `isValidMergeRecord`
  itself too, because it doesn't go through either helper (it reads `m.c`/`m.r`/`m.w`/`m.h`
  inline) and it needs to `continue` (skip the record), not get a boolean back. If you add a
  new function that reads a single merge record's fields, make it check `isValidMergeRecord`
  (or delegate to one that does) internally — don't push that requirement onto its callers,
  that's exactly the "forgot to guard one call site" shape that caused this bug.
- Commit messages use Conventional Commits (`feat:`, `fix:`…); commit only when asked, and branch off `master`/`main` first.
