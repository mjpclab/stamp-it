# Irregular span regions (自定义不规则跨格)

**Date:** 2026-09-19
**Status:** Approved, ready for implementation planning

## Problem

Span groups (连票) are currently a *uniform chunking* of the stamp matrix: `spanX × spanY`
cells per group, `ceil(X/spanX) × ceil(Y/spanY)` groups, remnants on the last column/row.
Every group in a sheet therefore has the same shape.

Real souvenir sheets (小全张) mix shapes. The reference sheet (2000-3 国家重点保护野生动物)
is a 4×4 matrix holding a 2×1 se-tenant pair at the top, a 2×2 large-format stamp in the
middle, and ten 1×1 stamps around them. Two distinct behaviors appear in that one sheet:

- **连票 (se-tenant):** several stamps whose artwork is continuous, still separated by
  perforations. This is what the current span model produces.
- **大票 (large-format):** one physically larger stamp — its interior has *no* perforations,
  only its outer edge is perforated. The current model cannot produce this at all, because
  `holeCenters()` punches every gridline unconditionally.

## Goals

1. Let the user carve the matrix into an arbitrary tiling of **rectangular** regions.
2. Let each merged region choose 连票 (keep interior perforations) or 大票 (suppress them).
3. Preserve existing behavior byte-for-byte when no regions are merged, and when regions
   come from a uniform split.

## Non-goals

- **Non-rectangular (L-shaped) regions.** Explicitly out of scope. Supporting them would
  force a rewrite of `groupContent`, cover-crop math, and border stroking. Rectangles only.
- On-canvas direct manipulation of the layout. The canvas drag gesture is owned by
  pan/zoom; adding a layout mode there is a separate, larger UX change.
- Per-region overrides of inner margin, border, or fill. Regions only control shape,
  photo assignment, and interior perforations.
- **Migrating pre-feature state.** Saved settings and scheme files written before this
  change are not translated. `spanX`/`spanY` stop affecting geometry; existing users get
  the per-cell default and re-apply a split if they want one. Crop data still carries over,
  because crop keys are unchanged.

## Design

### 1. State: store merges only, derive the rest

```js
state.merges = [{ c: 1, r: 2, w: 2, h: 2, big: true }, ...]
```

Only regions spanning more than one cell are stored. Every cell not covered by a merge is
implicitly its own 1×1 region. Consequences:

- An empty list is exactly the per-cell mode, which stays the default.
- Changing the matrix size needs no migration of the list: newly exposed cells fill in as
  1×1 automatically.
- The persisted payload stays a handful of small objects, not an X×Y table.

`computeGroups(X, Y, merges)` derives the full region list during geometry computation:

1. Walk `merges` in order. Clamp each to the matrix; skip it if its clamped rect is empty
   or overlaps a cell already claimed by an earlier merge (**first-wins**). Mark its cells.
2. Emit a 1×1 region for every unclaimed cell.
3. Sort by `(r0, c0)`.

Result: `[{ c0, r0, cw, ch, big }]`.

Overlap can only arrive from imported or hand-edited data — the editor never produces it.
First-wins is a guard, not a feature.

**Out-of-bounds merges are clipped for rendering but kept in `state.merges` unmodified**,
so shrinking and then re-growing the matrix revives them. This mirrors the existing policy
for orphaned crop keys (see `getCrop`).

### 2. Three existing invariants carry over unchanged

- **Crop keys stay `"c0,r0"`** (the region's start cell). Still unique under an irregular
  tiling, so `state.crops`, `getCrop`, `groupCrop`, and crop persistence need no changes.
- **Photo order stays `(r0, c0)` row-major.** For a uniform split this is identical to
  today's `gr * groupsX + gc`, which makes the byte-for-byte regression test below possible.
- **Clipping a merge never moves its origin** (only `cw`/`ch` shrink), so a region's crop
  key survives a matrix resize.

### 3. Geometry and render: mechanical substitution

`computeGeometry` gains `groups` and drops `spanX`, `spanY`, `groupsX`, `groupsY`.

| Before | After |
|---|---|
| `groupRect(geo, gc, gr)` | removed — regions carry their own rect |
| `groupFrame(geo, gc, gr)` | `groupFrame(geo, g)` |
| `groupContent(geo, gc, gr)` | `groupContent(geo, g)` |
| `groupImage(geo, gc, gr)` | `groupImage(i)` |
| nested `gr`/`gc` loops (photos, borders, `clampAllCrops`) | `geo.groups.forEach((g, i) => ...)` |

The layered render, inner/outer fills, and border stroking are untouched: they only ever
consume rectangles.

`computeGeometry` also builds `geo.cellGroup`, an `Int32Array(X * Y)` mapping each cell to
its region index, so `groupAt` stays O(1). This matters because hit-testing runs on every
drag frame.

`hitTarget` returns `{ type: 'group', gi }` (region index) instead of `{ gc, gr }`;
`cropContext` reads the region from `geo.groups[gi]`.

### 4. 大票 perforation suppression: one filter

`holeCenters` generates the full hole set as today, then drops any hole strictly inside a
`big` region:

```js
const bigs = geo.groups.filter(g => g.big).map(g => regionRect(geo, g));
const inside = (x, y) => bigs.some(R =>
  x > R.x && x < R.x + R.w && y > R.y && y < R.y + R.h);
```

**Strict inequalities are load-bearing.** Holes *on* the region boundary are all kept, so a
大票 keeps a complete ring of perforations around its edge. The endpoints of a suppressed
interior gridline coincide with boundary hole positions, which are retained — no gaps.

`bigs` is precomputed once per render. Holes number in the low thousands and big regions in
the single digits, so the O(holes × bigs) scan is not worth optimizing.

Duplicate holes at gridline intersections already exist today (a crossing point is emitted
on both its vertical and its horizontal line) and remain harmless — they are filled circles.

### 5. Controls (矩阵 tab)

```
矩阵      [4] × [4]
均匀分块  [2] × [2]  [应用]     ⚠ 会清掉手工合并

┌───┬───────┬───┐
│ 1 │   2   │ 3 │      drag a rectangle on the grid → [合并]
├───┼───┬───┼───┤      click a merged region        → [拆分]
│ 4 │ 5 │ 6 │ 7 │
├───┼───┴───┼───┤      with a merged region selected:
│ 8 │       │ 9 │        ○ 连票（保留内部齿孔）
├───┤  10   ├───┤        ◉ 大票（无内部齿孔）
│11 │       │12 │
└───┴───────┴───┘              [全部还原]
```

- **均匀分块 N×M + 应用** replaces the old `spanX`/`spanY` number fields. It regenerates
  `state.merges` as a uniform split (emitting only regions larger than one cell, so
  remnants fall out as implicit 1×1s) and discards manual merges. The warning text is part
  of the control, not a confirm dialog.
- **Mini grid editor**: a CSS Grid, one `div` per region with
  `grid-column: c0+1 / span cw` and the matching row rule. Cells use `aspect-ratio` derived
  from `Sw`/`Sh` so a portrait matrix reads correctly. Each region shows its photo index,
  which doubles as the answer to "which image lands where".
- **Selection** uses pointer events (pointerdown → pointermove → pointerup) so touch works;
  the grid needs `touch-action: none`. A selection that covers one cell is a click. 合并 is
  enabled when the selection covers more than one cell; 拆分 when the selection is a single
  merged region.
- **A selection expands to the bounding box of every region it touches**, then repeats until
  stable. A drag can therefore never half-eat an existing merge: partially covering a 2×2
  region pulls that whole region into the selection. 合并 replaces every fully-covered merge
  with one new region.
- The 大票/连票 radio pair appears only while a merged region is selected.
- `els` gains every new element id — a missing `els` entry throws mid-run inside
  `syncInputsFromState` and silently breaks initialization.

### 6. Persistence

- `PERSISTED` gains `merges`. Scheme export/import iterate `PERSISTED`, so both come along
  for free, and `resetScheme` restores `merges: []` from the `DEFAULTS` snapshot.
- `spanX`/`spanY` stay in `state` and `PERSISTED`, demoted to pure UI memory for the
  均匀分块 fields. They no longer participate in geometry.
- No migration path. A scheme file written by this version always carries a `merges` key
  (`[]` at minimum), which is neither `null` nor `undefined`, so `importScheme` applies it
  normally.

### 7. Documentation

`AGENTS.md` — rewrite the "Span groups (连票)" paragraph under Geometry, and touch the
Persistence and Gotchas sections where they name `spanX`/`spanY` or crop keys.

## Verification

No test suite; use the headless-Chromium recipe in `AGENTS.md`.

| # | Assertion | Method |
|---|---|---|
| 1 | Empty `merges` renders byte-identically to today's 1×1 mode | pixel diff against a pre-change render |
| 2 | 均匀分块 2×2 renders byte-identically to today's `spanX=spanY=2` | pixel diff — the key regression proof |
| 3 | 大票 suppression is exact | write hole count into `document.title`, assert `full − interior` |
| 4 | All four cells of a 2×2 region hit the same crop key | synthetic `PointerEvent`s + `document.title` assertion |
| 5 | Out-of-bounds merges survive a matrix shrink/grow round trip | assert `state.merges.length` via `document.title` |
| 6 | The reference sheet layout reproduces | screenshot, visual check |

Tests 1 and 2 must be captured *before* the change lands, since they compare against the
current renderer.

## Files touched

- `index.js` — geometry, render loops, hit-testing, `holeCenters`, persistence, editor bindings
- `index.html` — 矩阵 tab controls
- `index.css` — mini grid editor
- `AGENTS.md` — Geometry / Persistence / Gotchas
