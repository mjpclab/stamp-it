# Irregular Span Regions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user carve the stamp matrix into an arbitrary tiling of rectangular regions, each optionally rendered as a 大票 (large-format stamp with no interior perforations) instead of a 连票 (se-tenant strip that keeps them).

**Architecture:** `state.merges` stores only regions spanning more than one cell; `computeGroups()` derives the full region list at geometry time by placing merges (clamped, first-wins on overlap) and filling every unclaimed cell with a 1×1 region, sorted `(r0, c0)`. Every renderer, hit-test, and crop path switches from `(gc, gr)` index math to iterating that list. `holeCenters()` gains a filter that drops holes strictly inside a `big` region.

**Tech Stack:** Vanilla ES2020 in three files (`index.html`, `index.css`, `index.js`). No build step, no dependencies, no test framework. Verification is headless Chromium screenshots plus `document.title` assertions, per `AGENTS.md`.

**Spec:** `docs/superpowers/specs/2026-09-19-irregular-span-regions-design.md`

## Global Constraints

- **No build step, no dependencies, no framework.** Three files do everything. Do not add a bundler, a package.json, or a test runner.
- **`file://` must keep working.** Never use `fetch()` in verification harnesses; load images with `new Image(); img.src = '...'`.
- **Code comments in Chinese** (matching `index.js`); **commit messages in English**, Conventional Commits (`feat:`, `fix:`, `refactor:`, `docs:`).
- **UI language is Simplified Chinese.**
- **Regions are rectangles only.** L-shaped regions are explicitly out of scope.
- **No migration of pre-feature saved state.** `spanX`/`spanY` stop affecting geometry.
- **Every new element referenced from JS must be added to the `els` map** — a missing `els.foo` makes `syncInputsFromState` throw mid-run and silently breaks initialization.
- **Crop keys stay `"c0,r0"`** (a region's start cell). Do not change `getCrop`/`groupCrop` key format.
- **Photo assignment order stays `(r0, c0)` row-major.**
- Work on a branch off `main`. Commit after each task.

## Verification Harness

There is no test suite. Every task below verifies through this recipe (from `AGENTS.md`).

**Build a harness page:** copy `index.html` to `_test.html` in the repo root and inject a `<script>` *after* the `index.js` tag. The injected script mutates `state`, calls `renderPreview()`, and either leaves a screenshot to diff or writes an assertion result into `document.title`.

```bash
# screenshot mode
chromium --headless --disable-gpu --no-sandbox --hide-scrollbars \
  --window-size=1000,720 --virtual-time-budget=3000 \
  --screenshot=out.png "file://$PWD/_test.html"

# assertion mode (read document.title)
chromium --headless --disable-gpu --no-sandbox --hide-scrollbars \
  --window-size=1000,720 --virtual-time-budget=3000 \
  --dump-dom "file://$PWD/_test.html" | grep -o '<title>[^<]*</title>'
```

**Pixel diff:** `compare -metric AE a.png b.png null: 2>&1` prints the number of differing pixels; `0` means identical. Both renders must come from the same Chromium build (true within one session).

**Harness pages must force a deterministic view.** `loadOptions()` restores whatever is in `localStorage`, which differs per machine. Every injected script below therefore assigns every geometry-relevant field explicitly and sets `state.view` before rendering.

**Clean up `_test.html` and any `out*.png` in the repo root at the end of each task.** Baseline PNGs live in the scratchpad directory, not the repo.

---

### Task 0: Capture the byte-identical baselines

The two most important assertions in this plan compare the *new* renderer against the *current* one. Those baselines can only be captured before any code changes. This task writes no product code.

**Files:**
- Create (temporary): `_test.html`
- Create (kept until Task 3): `/tmp/claude-1000/-home-marjune-stamp-it/e1d1f951-fdfd-4093-95d3-837ffb0f6f66/scratchpad/baseline-1x1.png`, `/tmp/claude-1000/-home-marjune-stamp-it/e1d1f951-fdfd-4093-95d3-837ffb0f6f66/scratchpad/baseline-2x2.png`

- [ ] **Step 1: Confirm the tree is clean and branch off main**

```bash
git status --short          # expect only the untracked docs/ and doc/example/ additions
git switch -c feat/irregular-span-regions
```

- [ ] **Step 2: Write the baseline harness**

```bash
python3 - <<'PY'
src = open('index.html').read()
inject = '''
<script>
(function () {
  Object.assign(state, {
    d: 8, g: 4, nx: 8, ny: 12,
    matrixX: 4, matrixY: 4,
    spanX: Number(new URLSearchParams(location.search).get('span') || 1),
    spanY: Number(new URLSearchParams(location.search).get('span') || 1),
    view: 'fit',
    innerMarginTop: 0.75, innerMarginRight: 0.75,
    innerMarginBottom: 0.75, innerMarginLeft: 0.75,
    outerMarginTop: 0, outerMarginRight: 0, outerMarginBottom: 0, outerMarginLeft: 0,
    borderWidth: 2, borderGap: 2, borderColor: '#ffffff', borderOpacity: 1,
    baseColor: '#000000', baseOpacity: 1,
    innerColor: '#3366aa', innerColorOpacity: 1, innerFill: 'solid',
    outerColor: '#222222', outerColorOpacity: 1, outerFill: 'solid',
    crops: {}, outerCrop: { scale: 1, offsetX: 0, offsetY: 0 },
    innerCrop: { scale: 1, offsetX: 0, offsetY: 0 },
    images: [], outerImage: null, innerImage: null,
  });
  const img = new Image();
  img.onload = () => { state.images = [img]; syncInputsFromState(); renderPreview(); };
  img.src = 'doc/plan/img/input.png';
})();
</script>
'''
open('_test.html','w').write(src.replace('<script src="index.js"></script>',
                                         '<script src="index.js"></script>' + inject))
PY
```

- [ ] **Step 3: Render both baselines**

```bash
SP=/tmp/claude-1000/-home-marjune-stamp-it/e1d1f951-fdfd-4093-95d3-837ffb0f6f66/scratchpad
for s in 1 2; do
  chromium --headless --disable-gpu --no-sandbox --hide-scrollbars \
    --window-size=1000,720 --virtual-time-budget=3000 \
    --screenshot="$SP/baseline-${s}x${s}.png" "file://$PWD/_test.html?span=$s"
done
ls -l "$SP"/baseline-*.png
```

- [ ] **Step 4: Verify the two baselines actually differ**

If `span=1` and `span=2` produced the same image, the harness is not driving state and every later assertion would pass vacuously.

```bash
compare -metric AE "$SP/baseline-1x1.png" "$SP/baseline-2x2.png" null: 2>&1; echo
```

Expected: a large non-zero pixel count (the 2×2 render has four photos instead of sixteen and fewer inner margins).

- [ ] **Step 5: Clean up and record the baseline path**

```bash
rm -f _test.html
```

Tasks 2 and 3 read the baselines from `/tmp/claude-1000/-home-marjune-stamp-it/e1d1f951-fdfd-4093-95d3-837ffb0f6f66/scratchpad`. Nothing to commit.

---

### Task 1: The `merges` data model

Introduce the state field and the pure function that derives a full region list from it. Nothing consumes it yet, so the app's rendering is unchanged.

**Files:**
- Modify: `index.js` — `PERSISTED` (line ~29), `state` (line ~45), and a new 几何 section block above `computeGeometry` (line ~111)
- Test: `_test.html` (temporary)

**Interfaces:**
- Consumes: nothing
- Produces:
  - `state.merges: Array<{c:number, r:number, w:number, h:number, big:boolean}>` — only regions covering more than one cell
  - `computeGroups(X, Y, merges) -> Array<{c0, r0, cw, ch, big}>` sorted by `(r0, c0)`
  - `cellGroupIndex(X, Y, groups) -> Int32Array` of length `X*Y`, cell → region index
  - `uniformMerges(X, Y, spanX, spanY) -> Array<{c, r, w, h, big}>`

- [ ] **Step 1: Write the failing assertion harness**

```bash
python3 - <<'PY'
src = open('index.html').read()
inject = '''
<script>
(function () {
  const results = [];
  const eq = (name, got, want) => results.push(
    JSON.stringify(got) === JSON.stringify(want) ? 'ok ' + name : 'FAIL ' + name + ' got=' + JSON.stringify(got));

  // 空列表 → 全 1×1，行优先
  eq('empty', computeGroups(2, 2, []).map(g => [g.c0, g.r0, g.cw, g.ch]),
     [[0,0,1,1],[1,0,1,1],[0,1,1,1],[1,1,1,1]]);

  // 一个 2×2 合并落在 4×4 中央，其余补 1×1，总数 = 16 - 4 + 1 = 13
  eq('merge-count', computeGroups(4, 4, [{c:1,r:1,w:2,h:2}]).length, 13);

  // 排序后，中央合并排在 (r0=1, c0=1) 的位置上
  eq('merge-order', computeGroups(4, 4, [{c:1,r:1,w:2,h:2}]).map(g => g.c0 + ',' + g.r0).join(' '),
     '0,0 1,0 2,0 3,0 0,1 1,1 3,1 0,2 3,2 0,3 1,3 2,3 3,3');

  // 重叠：先到先得，后者整个忽略
  eq('overlap', computeGroups(4, 4, [{c:0,r:0,w:2,h:2},{c:1,r:1,w:2,h:2}])
       .filter(g => g.cw > 1).map(g => [g.c0, g.r0, g.cw, g.ch]), [[0,0,2,2]]);

  // 越界：裁剪到矩阵内
  eq('clip', computeGroups(3, 3, [{c:2,r:0,w:3,h:2}]).filter(g => g.cw > 1 || g.ch > 1)
       .map(g => [g.c0, g.r0, g.cw, g.ch]), [[2,0,1,2]]);

  // 裁剪后退化为单格 → 忽略，该格成为隐式 1×1
  eq('clip-to-single', computeGroups(3, 3, [{c:2,r:2,w:3,h:3}]).every(g => g.cw === 1 && g.ch === 1), true);

  // big 标志透传
  eq('big-flag', computeGroups(2, 2, [{c:0,r:0,w:2,h:1,big:true}])[0].big, true);

  // cellGroupIndex：2×2 合并的四个格都指向同一区域下标
  const gs = computeGroups(4, 4, [{c:1,r:1,w:2,h:2}]);
  const map = cellGroupIndex(4, 4, gs);
  const gi = map[1 * 4 + 1];
  eq('cell-map', [map[1*4+2], map[2*4+1], map[2*4+2]], [gi, gi, gi]);

  // uniformMerges：4×4 按 2×2 切 → 四个 2×2，不产出单格
  eq('uniform', uniformMerges(4, 4, 2, 2).map(m => [m.c, m.r, m.w, m.h]),
     [[0,0,2,2],[2,0,2,2],[0,2,2,2],[2,2,2,2]]);

  // uniformMerges：不整除时残块中 w*h===1 的不产出
  eq('uniform-remnant', uniformMerges(3, 3, 2, 2).map(m => [m.c, m.r, m.w, m.h]),
     [[0,0,2,2],[2,0,1,2],[0,2,2,1]]);

  // computeGroups 是纯函数：越界的合并被裁剪渲染，但输入列表一字不改
  const kept = [{ c: 2, r: 2, w: 2, h: 2, big: true }];
  const snapshot = JSON.stringify(kept);
  computeGroups(3, 3, kept);                     // 矩阵缩到 3×3，该合并被裁成 1×1 → 忽略
  eq('no-mutate', JSON.stringify(kept), snapshot);
  // 矩阵放大回 4×4 后原样复活
  eq('revive', computeGroups(4, 4, kept).filter(g => g.cw > 1)
       .map(g => [g.c0, g.r0, g.cw, g.ch, g.big]), [[2,2,2,2,true]]);

  const bad = results.filter(r => r.startsWith('FAIL'));
  document.title = bad.length ? bad.join(' | ') : 'ALL PASS (' + results.length + ')';
})();
</script>
'''
open('_test.html','w').write(src.replace('<script src="index.js"></script>',
                                         '<script src="index.js"></script>' + inject))
PY
```

- [ ] **Step 2: Run it to verify it fails**

```bash
chromium --headless --disable-gpu --no-sandbox --hide-scrollbars \
  --window-size=1000,720 --virtual-time-budget=3000 \
  --dump-dom "file://$PWD/_test.html" 2>/dev/null | grep -o '<title>[^<]*</title>'
```

Expected: the title is unchanged (`<title>邮票化小工具</title>` or similar), because the injected IIFE throws `computeGroups is not defined` before it can set the title.

- [ ] **Step 3: Add `merges` to `state` and `PERSISTED`**

In `index.js`, add to `PERSISTED` (line ~29) right after `'spanX', 'spanY',`:

```js
  'merges',
```

In `state` (line ~45), replace the `spanX`/`spanY` comments so they no longer claim to drive geometry:

```js
  spanX: 1,                              // 「均匀分块」输入框的记忆值，不参与几何
  spanY: 1,
  merges: [],                            // 跨格区域（只存跨多格的）：{c,r,w,h,big}；空 = 全部逐格
```

`DEFAULTS` is a `structuredClone(state)` snapshot taken later in the file, so `resetScheme` picks up `merges: []` with no further change.

- [ ] **Step 4: Add the three functions**

In `index.js`, insert immediately above `function computeGeometry(s) {` (line ~111):

```js
// 由「合并区域」派生完整区域列表：按顺序落位每个合并（越界裁剪、与已占格重叠则整个忽略），
// 未被占用的格各自成 1×1 区域；最后按 (r0,c0) 行优先排序 —— 这个顺序也是照片填充顺序。
// 裁剪后退化为单格的合并被忽略：该格会作为隐式 1×1 补回，结果一致。
function computeGroups(X, Y, merges) {
  const taken = new Uint8Array(X * Y);
  const groups = [];
  for (const m of (merges || [])) {
    const c0 = Math.round(m.c);
    const r0 = Math.round(m.r);
    if (!(c0 >= 0 && r0 >= 0 && c0 < X && r0 < Y)) continue;
    const cw = Math.min(Math.round(m.w), X - c0);
    const ch = Math.min(Math.round(m.h), Y - r0);
    if (cw < 1 || ch < 1 || cw * ch < 2) continue;
    let free = true;
    for (let r = r0; r < r0 + ch && free; r++) {
      for (let c = c0; c < c0 + cw; c++) if (taken[r * X + c]) { free = false; break; }
    }
    if (!free) continue;
    for (let r = r0; r < r0 + ch; r++) {
      for (let c = c0; c < c0 + cw; c++) taken[r * X + c] = 1;
    }
    groups.push({ c0, r0, cw, ch, big: !!m.big });
  }
  for (let r = 0; r < Y; r++) {
    for (let c = 0; c < X; c++) {
      if (!taken[r * X + c]) groups.push({ c0: c, r0: r, cw: 1, ch: 1, big: false });
    }
  }
  groups.sort((a, b) => a.r0 - b.r0 || a.c0 - b.c0);
  return groups;
}

// 格 → 区域下标的查找表：命中测试每个拖拽帧都跑，必须 O(1)
function cellGroupIndex(X, Y, groups) {
  const map = new Int32Array(X * Y);
  groups.forEach((g, i) => {
    for (let r = g.r0; r < g.r0 + g.ch; r++) {
      for (let c = g.c0; c < g.c0 + g.cw; c++) map[r * X + c] = i;
    }
  });
  return map;
}

// 「均匀分块」生成器：按 spanX×spanY 切分矩阵，只产出跨多格的区域
//（w*h===1 的残块不产出，由 computeGroups 补成隐式 1×1，结果与旧的均匀 span 模型一致）
function uniformMerges(X, Y, spanX, spanY) {
  const sx = clamp(Math.round(spanX), 1, X);
  const sy = clamp(Math.round(spanY), 1, Y);
  const out = [];
  for (let r = 0; r < Y; r += sy) {
    for (let c = 0; c < X; c += sx) {
      const w = Math.min(sx, X - c);
      const h = Math.min(sy, Y - r);
      if (w * h > 1) out.push({ c, r, w, h, big: false });
    }
  }
  return out;
}
```

- [ ] **Step 5: Run the assertions to verify they pass**

```bash
chromium --headless --disable-gpu --no-sandbox --hide-scrollbars \
  --window-size=1000,720 --virtual-time-budget=3000 \
  --dump-dom "file://$PWD/_test.html" 2>/dev/null | grep -o '<title>[^<]*</title>'
```

Expected: `<title>ALL PASS (12)</title>`

- [ ] **Step 6: Confirm the app still renders unchanged**

`state.merges` exists but nothing reads it yet.

```bash
rm -f _test.html
git stash && chromium --headless --disable-gpu --no-sandbox --hide-scrollbars \
  --window-size=1000,720 --virtual-time-budget=3000 --screenshot=/tmp/before.png "file://$PWD/index.html"
git stash pop && chromium --headless --disable-gpu --no-sandbox --hide-scrollbars \
  --window-size=1000,720 --virtual-time-budget=3000 --screenshot=/tmp/after.png "file://$PWD/index.html"
compare -metric AE /tmp/before.png /tmp/after.png null: 2>&1; echo
```

Expected: `0`

- [ ] **Step 7: Commit**

```bash
rm -f /tmp/before.png /tmp/after.png
git add index.js
git commit -m "feat: add merges state and region derivation helpers"
```

---

### Task 2: Switch geometry, rendering, and hit-testing to the region list

Replace all `(gc, gr)` index math with iteration over `geo.groups`. This is a pure refactor plus the new data path: with `merges: []` the output must be byte-identical to today's 1×1 mode, and with `uniformMerges(X, Y, 2, 2)` byte-identical to today's `spanX=spanY=2`.

**Files:**
- Modify: `index.js` — `computeGeometry` (~111), `groupRect`/`groupFrame`/`groupContent`/`groupImage` (~144-171), `clampCropGroup` (~215), `clampAllCrops` (~242), photo loop (~362), border loop (~381), `groupAt` (~1111), `hitTarget` (~1130), `cropContext` (~1155)
- Test: `_test.html` (temporary)

**Interfaces:**
- Consumes: `computeGroups`, `cellGroupIndex`, `uniformMerges` from Task 1
- Produces:
  - `geo.groups: Array<{c0, r0, cw, ch, big}>` and `geo.cellGroup: Int32Array` on the geometry object; `geo.spanX`, `geo.spanY`, `geo.groupsX`, `geo.groupsY` are **removed**
  - `groupFrame(geo, g)`, `groupContent(geo, g)`, `groupOuterRect(geo, g)` — all take a region object
  - `groupImage(i)` — takes a region index
  - `clampCropGroup(geo, g, i)`
  - `groupAt(geo, gx, gy) -> number` (region index)
  - `hitTarget` returns `{ type: 'group', gi }` for photos

- [ ] **Step 1: Write the failing pixel-diff harness**

```bash
python3 - <<'PY'
src = open('index.html').read()
inject = '''
<script>
(function () {
  const q = new URLSearchParams(location.search);
  const span = Number(q.get('span') || 1);
  Object.assign(state, {
    d: 8, g: 4, nx: 8, ny: 12,
    matrixX: 4, matrixY: 4,
    spanX: 1, spanY: 1,
    merges: span > 1 ? uniformMerges(4, 4, span, span) : [],
    view: 'fit',
    innerMarginTop: 0.75, innerMarginRight: 0.75,
    innerMarginBottom: 0.75, innerMarginLeft: 0.75,
    outerMarginTop: 0, outerMarginRight: 0, outerMarginBottom: 0, outerMarginLeft: 0,
    borderWidth: 2, borderGap: 2, borderColor: '#ffffff', borderOpacity: 1,
    baseColor: '#000000', baseOpacity: 1,
    innerColor: '#3366aa', innerColorOpacity: 1, innerFill: 'solid',
    outerColor: '#222222', outerColorOpacity: 1, outerFill: 'solid',
    crops: {}, outerCrop: { scale: 1, offsetX: 0, offsetY: 0 },
    innerCrop: { scale: 1, offsetX: 0, offsetY: 0 },
    images: [], outerImage: null, innerImage: null,
  });
  const img = new Image();
  img.onload = () => { state.images = [img]; syncInputsFromState(); renderPreview(); };
  img.src = 'doc/plan/img/input.png';
})();
</script>
'''
open('_test.html','w').write(src.replace('<script src="index.js"></script>',
                                         '<script src="index.js"></script>' + inject))
PY
```

- [ ] **Step 2: Run it to verify the 2×2 case fails**

```bash
SP=/tmp/claude-1000/-home-marjune-stamp-it/e1d1f951-fdfd-4093-95d3-837ffb0f6f66/scratchpad
for s in 1 2; do
  chromium --headless --disable-gpu --no-sandbox --hide-scrollbars \
    --window-size=1000,720 --virtual-time-budget=3000 \
    --screenshot="out-${s}.png" "file://$PWD/_test.html?span=$s"
done
echo -n "1x1 diff: "; compare -metric AE "$SP/baseline-1x1.png" out-1.png null: 2>&1; echo
echo -n "2x2 diff: "; compare -metric AE "$SP/baseline-2x2.png" out-2.png null: 2>&1; echo
```

Expected: `1x1 diff: 0` (merges is empty and geometry still uses `spanX=1`), but `2x2 diff:` a large non-zero number — `state.merges` is set yet the renderer still reads `spanX=spanY=1`, so it draws sixteen photos instead of four.

- [ ] **Step 3: Replace the geometry fields**

In `computeGeometry`, delete these four lines:

```js
  const spanX = clamp(Math.round(s.spanX), 1, X);   // 跨格单元不超过矩阵尺寸
  const spanY = clamp(Math.round(s.spanY), 1, Y);
  const groupsX = Math.ceil(X / spanX);             // 跨格组数；不整除时末列/末行为残组
  const groupsY = Math.ceil(Y / spanY);
```

and replace with:

```js
  const groups = computeGroups(X, Y, s.merges);     // 跨格区域：合并区域 + 隐式 1×1，(r0,c0) 行优先
  const cellGroup = cellGroupIndex(X, Y, groups);   // 格 → 区域下标，供命中测试 O(1) 查表
```

In the returned object, replace `spanX, spanY, groupsX, groupsY,` with:

```js
    groups, cellGroup,
```

- [ ] **Step 4: Replace the four region accessor functions**

Delete `groupRect` entirely and replace the `groupRect` / `groupFrame` / `groupContent` / `groupImage` block (lines ~143-171) with:

```js
// 区域的整格矩形（不含内边距）：用于齿孔抑制判定
function groupOuterRect(geo, g) {
  return { x: geo.mL + g.c0 * geo.Sw, y: geo.mT + g.r0 * geo.Sh, w: g.cw * geo.Sw, h: g.ch * geo.Sh };
}

// 区域的边框矩形（= 内边距内缘）：内边距只作用于区域外缘，区域内相邻格贴合 → 画面连续（连票）
function groupFrame(geo, g) {
  return {
    x: geo.mL + g.c0 * geo.Sw + geo.iL,
    y: geo.mT + g.r0 * geo.Sh + geo.iT,
    w: g.cw * geo.Sw - geo.iL - geo.iR,
    h: g.ch * geo.Sh - geo.iT - geo.iB,
  };
}

// 区域的图片内容区：边框矩形再内缩「边框粗细 + 边框间距」
function groupContent(geo, g) {
  const f = groupFrame(geo, g);
  const inset = geo.bw + geo.bg;
  return { x: f.x + inset, y: f.y + inset, w: f.w - 2 * inset, h: f.h - 2 * inset };
}

// 第 i 个区域用哪张图：区域已按 (r0,c0) 行优先排序，故按下标重复填充
function groupImage(i) {
  return state.images[i % state.images.length];
}
```

- [ ] **Step 5: Replace the two clamp functions**

Replace `clampCropGroup` (lines ~215-224) with:

```js
// 钳制单个区域 crop 的 offset：保证该区域图片铺满内容区
function clampCropGroup(geo, g, i) {
  if (!state.images.length) return;
  const content = groupContent(geo, g);
  if (content.w <= 0 || content.h <= 0) return;   // 内边距过大挤没内容区时跳过钳制
  clampCropTo(groupCrop(g.c0, g.r0), groupImage(i), content.w, content.h);
}
```

Replace the loop body of `clampAllCrops` (lines ~242-250) with:

```js
function clampAllCrops() {
  const geo = computeGeometry(state);
  geo.groups.forEach((g, i) => {
    if (state.crops[g.c0 + ',' + g.r0]) clampCropGroup(geo, g, i);
  });
  clampOuterCrop();
  clampInnerCrop();
}
```

- [ ] **Step 6: Replace the two render loops**

Replace the photo loop (lines ~362-377) with:

```js
  if (s.images.length) {
    geo.groups.forEach((g, i) => {
      const content = groupContent(geo, g);
      if (content.w <= 0 || content.h <= 0) return;   // 内边距挤没内容区
      const img = groupImage(i);
      deco.save();
      deco.beginPath(); deco.rect(content.x, content.y, content.w, content.h); deco.clip();
      const dr = imageDrawRect(img, content, getCrop(g.c0, g.r0));   // 每区域独立 cover + 裁剪
      deco.drawImage(img, dr.x, dr.y, dr.w, dr.h);
      deco.restore();
    });
  }
```

Replace the border loop (lines ~382-390) with:

```js
    for (const g of geo.groups) {
      const f = groupFrame(geo, g);
      if (f.w <= 0 || f.h <= 0) continue;              // 内边距挤没整个区域
      const t = Math.min(geo.bw, f.w / 2, f.h / 2);    // 过粗时退化为实心块，不越界
      deco.lineWidth = t;
      deco.strokeRect(f.x + t / 2, f.y + t / 2, f.w - t, f.h - t);
    }
```

- [ ] **Step 7: Replace hit-testing and crop context**

Replace `groupAt` (lines ~1111-1115) with:

```js
// 由几何坐标定位所在跨格区域的下标（O(1) 查表）
function groupAt(geo, gx, gy) {
  const c = clamp(Math.floor((gx - geo.mL) / geo.Sw), 0, geo.X - 1);
  const r = clamp(Math.floor((gy - geo.mT) / geo.Sh), 0, geo.Y - 1);
  return geo.cellGroup[r * geo.X + c];
}
```

In `hitTarget`, replace both `{ type: 'group', ...groupAt(geo, gx, gy) }` occurrences with:

```js
{ type: 'group', gi: groupAt(geo, gx, gy) }
```

Replace the tail of `cropContext` (lines ~1155-1162) with:

```js
  const g = geo.groups[t.gi];
  return {
    crop: groupCrop(g.c0, g.r0),
    img: groupImage(t.gi),
    content: groupContent(geo, g),
    doClamp: () => clampCropGroup(geo, g, t.gi),
  };
```

- [ ] **Step 8: Verify both pixel diffs are zero**

```bash
for s in 1 2; do
  chromium --headless --disable-gpu --no-sandbox --hide-scrollbars \
    --window-size=1000,720 --virtual-time-budget=3000 \
    --screenshot="out-${s}.png" "file://$PWD/_test.html?span=$s"
done
echo -n "1x1 diff: "; compare -metric AE "$SP/baseline-1x1.png" out-1.png null: 2>&1; echo
echo -n "2x2 diff: "; compare -metric AE "$SP/baseline-2x2.png" out-2.png null: 2>&1; echo
```

Expected: both `0`. A non-zero 2×2 diff means the region order or the frame math diverged from the old uniform model — do not proceed.

- [ ] **Step 9: Verify gestures hit one crop key per region**

All four cells of a 2×2 region must resolve to the same crop key.

```bash
python3 - <<'PY'
src = open('index.html').read()
inject = '''
<script>
(function () {
  Object.assign(state, {
    d: 8, g: 4, nx: 8, ny: 12, matrixX: 4, matrixY: 4,
    merges: [{ c: 1, r: 1, w: 2, h: 2 }], view: 'fit', crops: {},
    images: [], dragTarget: 'auto',
  });
  const img = new Image();
  img.onload = () => {
    state.images = [img];
    syncInputsFromState();
    renderPreview();
    const geo = computeGeometry(state);
    const key = (c, r) => {
      const gi = groupAt(geo, geo.mL + (c + 0.5) * geo.Sw, geo.mT + (r + 0.5) * geo.Sh);
      const g = geo.groups[gi];
      return g.c0 + ',' + g.r0;
    };
    const merged = [key(1,1), key(2,1), key(1,2), key(2,2)];
    const outside = [key(0,0), key(3,3)];
    const ok = merged.every(k => k === '1,1') && outside[0] === '0,0' && outside[1] === '3,3';
    document.title = ok ? 'PASS' : 'FAIL merged=' + merged.join('/') + ' outside=' + outside.join('/');
  };
  img.src = 'doc/plan/img/input.png';
})();
</script>
'''
open('_test.html','w').write(src.replace('<script src="index.js"></script>',
                                         '<script src="index.js"></script>' + inject))
PY

chromium --headless --disable-gpu --no-sandbox --hide-scrollbars \
  --window-size=1000,720 --virtual-time-budget=3000 \
  --dump-dom "file://$PWD/_test.html" 2>/dev/null | grep -o '<title>[^<]*</title>'
```

Expected: `<title>PASS</title>`

- [ ] **Step 10: Commit**

```bash
rm -f _test.html out-1.png out-2.png
git add index.js
git commit -m "refactor: drive geometry, render and hit-test from the region list"
```

---

### Task 3: 大票 — suppress perforations inside a region

**Files:**
- Modify: `index.js` — `holeCenters` (lines ~185-199)
- Test: `_test.html` (temporary)

**Interfaces:**
- Consumes: `geo.groups` and `groupOuterRect(geo, g)` from Task 2
- Produces: `holeCenters(geo)` now omits holes strictly inside any region with `big === true`; its signature is unchanged

- [ ] **Step 1: Write the failing assertion harness**

The assertion is geometric, not a magic number: every hole position on a 大票's perimeter must still be present, and no hole may lie strictly inside it.

```bash
python3 - <<'PY'
src = open('index.html').read()
inject = '''
<script>
(function () {
  Object.assign(state, {
    d: 8, g: 4, nx: 8, ny: 12, matrixX: 4, matrixY: 4, view: 'fit',
    merges: [{ c: 1, r: 1, w: 2, h: 2, big: true }],
    crops: {}, images: [],
  });
  syncInputsFromState();
  renderPreview();

  const geo = computeGeometry(state);
  const big = geo.groups.find(g => g.big);
  const R = groupOuterRect(geo, big);
  const holes = holeCenters(geo);
  const E = 1e-6;
  const has = (x, y) => holes.some(h => Math.abs(h.x - x) < E && Math.abs(h.y - y) < E);

  // 1. 外缘一圈孔必须完整：上下边各 cw*nx+1 个，左右边各 ch*ny+1 个
  const missing = [];
  for (let k = 0; k <= big.cw * state.nx; k++) {
    const x = R.x + k * geo.pitch;
    if (!has(x, R.y)) missing.push('top@' + k);
    if (!has(x, R.y + R.h)) missing.push('bottom@' + k);
  }
  for (let k = 0; k <= big.ch * state.ny; k++) {
    const y = R.y + k * geo.pitch;
    if (!has(R.x, y)) missing.push('left@' + k);
    if (!has(R.x + R.w, y)) missing.push('right@' + k);
  }

  // 2. 严格内部必须一个孔都没有
  const interior = holes.filter(h =>
    h.x > R.x + E && h.x < R.x + R.w - E && h.y > R.y + E && h.y < R.y + R.h - E);

  // 3. 关掉 big 时孔数必须变多（证明抑制确实生效）
  const before = holeCenters(geo).length;
  state.merges = [{ c: 1, r: 1, w: 2, h: 2, big: false }];
  const after = holeCenters(computeGeometry(state)).length;

  document.title = (missing.length === 0 && interior.length === 0 && after > before)
    ? 'PASS ring-intact interior=0 ' + before + '<' + after
    : 'FAIL missing=' + missing.slice(0, 5).join(',') + ' interior=' + interior.length +
      ' counts=' + before + '/' + after;
})();
</script>
'''
open('_test.html','w').write(src.replace('<script src="index.js"></script>',
                                         '<script src="index.js"></script>' + inject))
PY
```

- [ ] **Step 2: Run it to verify it fails**

```bash
chromium --headless --disable-gpu --no-sandbox --hide-scrollbars \
  --window-size=1000,720 --virtual-time-budget=3000 \
  --dump-dom "file://$PWD/_test.html" 2>/dev/null | grep -o '<title>[^<]*</title>'
```

Expected: `FAIL missing= interior=<non-zero> counts=N/N` — the ring is intact (nothing is suppressed yet), but interior holes exist and the two counts are equal.

- [ ] **Step 3: Add the suppression filter**

Replace `holeCenters` (lines ~185-199) with:

```js
function holeCenters(geo) {
  const out = [];
  const { mT, mL, pitch, Sw, Sh, X, Y } = geo;
  const nx = state.nx, ny = state.ny;
  // 大票：抑制区域内部的齿孔，只保留外缘一圈。
  // 用严格不等式 + EPS：边界上的孔全部保留，内部齿孔线的端点正落在边界上，故边缘无缺口。
  // EPS 是必需的 —— 边界 y = mT + r0*(ny*pitch) 与孔位 y = mT + k*pitch 在
  // k = r0*ny 时数学上相等，但浮点乘法不满足结合律，可能差一个 ULP。
  const EPS = 1e-6;
  const bigs = geo.groups.filter((g) => g.big).map((g) => groupOuterRect(geo, g));
  const inside = (x, y) => bigs.some((R) =>
    x > R.x + EPS && x < R.x + R.w - EPS && y > R.y + EPS && y < R.y + R.h - EPS);

  const vTotal = Y * ny;     // 全高 = blockH / pitch
  for (let c = 0; c <= X; c++) {            // 垂直齿孔线
    const x = mL + c * Sw;
    for (let k = 0; k <= vTotal; k++) {
      const y = mT + k * pitch;
      if (!inside(x, y)) out.push({ x, y });
    }
  }
  const hTotal = X * nx;     // 全宽 = blockW / pitch
  for (let r = 0; r <= Y; r++) {            // 水平齿孔线
    const y = mT + r * Sh;
    for (let k = 0; k <= hTotal; k++) {
      const x = mL + k * pitch;
      if (!inside(x, y)) out.push({ x, y });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
chromium --headless --disable-gpu --no-sandbox --hide-scrollbars \
  --window-size=1000,720 --virtual-time-budget=3000 \
  --dump-dom "file://$PWD/_test.html" 2>/dev/null | grep -o '<title>[^<]*</title>'
```

Expected: `<title>PASS ring-intact interior=0 N<M</title>` with `N < M`.

- [ ] **Step 5: Re-confirm no 大票 means no change**

The Task 2 baselines must still match byte-for-byte, since neither uses `big`.

```bash
python3 - <<'PY'
src = open('index.html').read()
inject = '''
<script>
(function () {
  const span = Number(new URLSearchParams(location.search).get('span') || 1);
  Object.assign(state, {
    d: 8, g: 4, nx: 8, ny: 12, matrixX: 4, matrixY: 4, spanX: 1, spanY: 1,
    merges: span > 1 ? uniformMerges(4, 4, span, span) : [],
    view: 'fit',
    innerMarginTop: 0.75, innerMarginRight: 0.75,
    innerMarginBottom: 0.75, innerMarginLeft: 0.75,
    outerMarginTop: 0, outerMarginRight: 0, outerMarginBottom: 0, outerMarginLeft: 0,
    borderWidth: 2, borderGap: 2, borderColor: '#ffffff', borderOpacity: 1,
    baseColor: '#000000', baseOpacity: 1,
    innerColor: '#3366aa', innerColorOpacity: 1, innerFill: 'solid',
    outerColor: '#222222', outerColorOpacity: 1, outerFill: 'solid',
    crops: {}, outerCrop: { scale: 1, offsetX: 0, offsetY: 0 },
    innerCrop: { scale: 1, offsetX: 0, offsetY: 0 },
    images: [], outerImage: null, innerImage: null,
  });
  const img = new Image();
  img.onload = () => { state.images = [img]; syncInputsFromState(); renderPreview(); };
  img.src = 'doc/plan/img/input.png';
})();
</script>
'''
open('_test.html','w').write(src.replace('<script src="index.js"></script>',
                                         '<script src="index.js"></script>' + inject))
PY

for s in 1 2; do
  chromium --headless --disable-gpu --no-sandbox --hide-scrollbars \
    --window-size=1000,720 --virtual-time-budget=3000 \
    --screenshot="out-${s}.png" "file://$PWD/_test.html?span=$s"
done
echo -n "1x1 diff: "; compare -metric AE "$SP/baseline-1x1.png" out-1.png null: 2>&1; echo
echo -n "2x2 diff: "; compare -metric AE "$SP/baseline-2x2.png" out-2.png null: 2>&1; echo
```

Expected: both `0`.

- [ ] **Step 6: Commit**

```bash
rm -f _test.html out-1.png out-2.png
git add index.js
git commit -m "feat: suppress perforations inside large-format regions"
```

---

### Task 4: Replace the span inputs with 均匀分块 + a read-only region grid

The layout is now driven by `state.merges`, but nothing in the UI can see or set it. This task replaces the two dead `跨格宽`/`跨格高` inputs with an 均匀分块 action and renders the current regions as a mini grid. Editing comes in Task 5.

**Files:**
- Modify: `index.html` — the `tab-matrix` panel, lines 42-51
- Modify: `index.css` — append a region-grid block after the `.seg` rules (~line 307)
- Modify: `index.js` — `els` (~462), `syncInputsFromState` (~650), `bindControls` (~1028), `renderPreview` (~line of `updateDragTargetSeg()`)

**Interfaces:**
- Consumes: `uniformMerges`, `computeGeometry`, `geo.groups`
- Produces:
  - `els.spanX`, `els.spanY` (repurposed as the 均匀分块 inputs), `els.applySpanBtn`, `els.regionGrid`
  - `renderRegionGrid()` — rebuilds the mini grid from the current geometry; called from `renderPreview()`

- [ ] **Step 1: Replace the markup**

In `index.html`, replace lines 42-51 (the `跨格宽`/`跨格高` field row and its hint) with:

```html
            <div class="field-row">
              <label>均匀分块宽
                <input type="number" id="spanX" value="1" min="1" step="1">
              </label>
              <label>均匀分块高
                <input type="number" id="spanY" value="1" min="1" step="1">
              </label>
              <button type="button" id="applySpanBtn" class="ghost small" >应用</button>
            </div>
            <p class="hint">应用后按「均匀分块宽×高」重切整个矩阵，会清掉已有的手工合并</p>
            <div class="region-grid" id="regionGrid"></div>
            <p class="hint">格内数字 = 该区域取第几张照片</p>
```

- [ ] **Step 2: Add the mini grid styles**

Append to `index.css`:

```css
/* 跨格区域网格：按真实邮票比例排布，一格一区域 */
.region-grid {
  display: grid;
  gap: 2px;
  width: 100%;
  margin: 8px 0;
  touch-action: none;           /* 触摸端拖选不被页面滚动抢走 */
  user-select: none;
}
.region-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 0;
  font-size: 11px;
  color: var(--muted);
  background: #2a2f37;
  border: 1px solid #3a4049;
  border-radius: 3px;
  cursor: pointer;
}
.region-cell.merged { background: #33404f; color: var(--text); }
.region-cell.big { border-style: dashed; border-color: #6f8fb0; }
```

- [ ] **Step 3: Register the new elements**

In `index.js`, add to `els` right after the existing `spanY` entry:

```js
  applySpanBtn: document.getElementById('applySpanBtn'),
  regionGrid: document.getElementById('regionGrid'),
```

- [ ] **Step 4: Write `renderRegionGrid`**

Insert above `function renderPreview()`:

```js
// 重建跨格区域网格：一区域一格子，用 grid-column/row 的 span 拼出不规则版式。
// 每次 renderPreview 都会调用，故用签名串去重，避免每个拖拽帧都重建 DOM。
let lastRegionSig = '';

function renderRegionGrid(geo) {
  const sig = geo.X + 'x' + geo.Y + '|' + geo.Sw.toFixed(3) + 'x' + geo.Sh.toFixed(3) + '|' +
    geo.groups.map((g) => [g.c0, g.r0, g.cw, g.ch, g.big ? 1 : 0].join(',')).join(';');
  if (sig === lastRegionSig) return;
  lastRegionSig = sig;

  const grid = els.regionGrid;
  grid.style.gridTemplateColumns = 'repeat(' + geo.X + ', 1fr)';
  grid.style.aspectRatio = (geo.X * geo.Sw) + ' / ' + (geo.Y * geo.Sh);
  grid.textContent = '';
  geo.groups.forEach((g, i) => {
    const cell = document.createElement('div');
    cell.className = 'region-cell' +
      (g.cw * g.ch > 1 ? ' merged' : '') + (g.big ? ' big' : '');
    cell.style.gridColumn = (g.c0 + 1) + ' / span ' + g.cw;
    cell.style.gridRow = (g.r0 + 1) + ' / span ' + g.ch;
    cell.dataset.gi = String(i);
    cell.textContent = String(i + 1);
    grid.appendChild(cell);
  });
}
```

- [ ] **Step 5: Call it from `renderPreview`**

In `renderPreview`, add the call after `updateDragTargetSeg();`:

```js
  renderRegionGrid(geo);
```

- [ ] **Step 6: Wire the 均匀分块 button**

In `bindControls`, `numField(els.spanX, 'spanX', 1)` and `numField(els.spanY, 'spanY', 1)` already persist the two values; leave them. Add after the `numField(els.spanY, ...)` line:

```js
  els.applySpanBtn.addEventListener('click', () => {
    const X = Math.max(1, Math.round(state.matrixX));
    const Y = Math.max(1, Math.round(state.matrixY));
    state.merges = uniformMerges(X, Y, state.spanX, state.spanY);
    clampAllCrops();
    renderPreview();
    saveOptions();
  });
```

- [ ] **Step 7: Verify the grid reflects the regions**

```bash
python3 - <<'PY'
src = open('index.html').read()
inject = '''
<script>
(function () {
  Object.assign(state, {
    d: 8, g: 4, nx: 8, ny: 12, matrixX: 4, matrixY: 4, view: 'fit',
    spanX: 2, spanY: 2, merges: [], crops: {}, images: [],
  });
  syncInputsFromState();
  renderPreview();
  // 断言几何区域而非读回 CSS 简写 —— 浏览器会把 grid-column 规范化，读回值不可靠
  const before = els.regionGrid.children.length;
  els.applySpanBtn.click();
  const after = els.regionGrid.children.length;
  const rects = JSON.stringify(computeGeometry(state).groups.map(g => [g.c0, g.r0, g.cw, g.ch]));
  const gis = [...els.regionGrid.children].map(c => c.dataset.gi).join(',');
  const ok = before === 16 && after === 4 &&
    rects === '[[0,0,2,2],[2,0,2,2],[0,2,2,2],[2,2,2,2]]' && gis === '0,1,2,3';
  document.title = ok
    ? 'PASS 16->4'
    : 'FAIL before=' + before + ' after=' + after + ' rects=' + rects + ' gis=' + gis;
})();
</script>
'''
open('_test.html','w').write(src.replace('<script src="index.js"></script>',
                                         '<script src="index.js"></script>' + inject))
PY

chromium --headless --disable-gpu --no-sandbox --hide-scrollbars \
  --window-size=1000,720 --virtual-time-budget=3000 \
  --dump-dom "file://$PWD/_test.html" 2>/dev/null | grep -o '<title>[^<]*</title>'
```

Expected: `<title>PASS 16->4</title>`

- [ ] **Step 8: Screenshot the panel at mobile width**

Per `AGENTS.md`, headless Chromium clamps windows to ≥500px, so use the iframe wrapper.

```bash
cat > _frame.html <<'EOF'
<body style="margin:0"><iframe src="_test.html" width="390" height="844" style="border:0"></iframe></body>
EOF
chromium --headless --disable-gpu --no-sandbox --hide-scrollbars \
  --window-size=420,940 --virtual-time-budget=4000 --screenshot=out-mobile.png "file://$PWD/_frame.html"
```

Read `out-mobile.png` and confirm the region grid is visible, sized to the panel width, and not overflowing.

- [ ] **Step 9: Commit**

```bash
rm -f _test.html _frame.html out-mobile.png
git add index.html index.css index.js
git commit -m "feat: show span regions as a mini grid, replace span fields with a uniform-split action"
```

---

### Task 5: Merge, split, and 大票/连票 editing

**Files:**
- Modify: `index.html` — add the action row and the 大票/连票 toggle under `#regionGrid`
- Modify: `index.css` — append selection styles
- Modify: `index.js` — new `bindRegionGrid()` called from the 启动 block, and `renderRegionGrid` gains selection rendering

**Interfaces:**
- Consumes: `renderRegionGrid`, `els.regionGrid`, `state.merges`, `computeGeometry`
- Produces:
  - `els.mergeBtn`, `els.splitBtn`, `els.resetRegionsBtn`, `els.regionKind` (the 大票/连票 `.seg` container)
  - `selection: {c0, r0, cw, ch} | null` — module-level, not persisted
  - `expandSelection(geo, sel)` — grows a cell rect to the bounding box of every region it touches, repeating until stable
  - `bindRegionGrid()` — pointer handlers + button handlers

- [ ] **Step 1: Write the failing assertion harness for `expandSelection`**

```bash
python3 - <<'PY'
src = open('index.html').read()
inject = '''
<script>
(function () {
  Object.assign(state, {
    d: 8, g: 4, nx: 8, ny: 12, matrixX: 4, matrixY: 4, view: 'fit',
    merges: [{ c: 1, r: 1, w: 2, h: 2 }], crops: {}, images: [],
  });
  syncInputsFromState();
  renderPreview();
  const geo = computeGeometry(state);
  const box = (s) => [s.c0, s.r0, s.cw, s.ch].join(',');
  const results = [];
  const eq = (n, got, want) => results.push(got === want ? 'ok ' + n : 'FAIL ' + n + ' got=' + got);

  // 完全在合并区域外：不扩张
  eq('outside', box(expandSelection(geo, { c0: 0, r0: 0, cw: 1, ch: 1 })), '0,0,1,1');
  // 只碰到合并区域的一个角：扩张到整个合并区域
  eq('touch-corner', box(expandSelection(geo, { c0: 2, r0: 2, cw: 1, ch: 1 })), '1,1,2,2');
  // 横跨合并区域一半 + 左侧一格：扩张到并集外接矩形
  eq('partial', box(expandSelection(geo, { c0: 0, r0: 1, cw: 2, ch: 1 })), '0,1,3,2');
  // 已经覆盖整个合并区域：不再变化（幂等）
  eq('stable', box(expandSelection(geo, { c0: 1, r0: 1, cw: 2, ch: 2 })), '1,1,2,2');

  const bad = results.filter(r => r.startsWith('FAIL'));
  document.title = bad.length ? bad.join(' | ') : 'ALL PASS (' + results.length + ')';
})();
</script>
'''
open('_test.html','w').write(src.replace('<script src="index.js"></script>',
                                         '<script src="index.js"></script>' + inject))
PY

chromium --headless --disable-gpu --no-sandbox --hide-scrollbars \
  --window-size=1000,720 --virtual-time-budget=3000 \
  --dump-dom "file://$PWD/_test.html" 2>/dev/null | grep -o '<title>[^<]*</title>'
```

Expected: the title is unchanged — `expandSelection is not defined` throws.

- [ ] **Step 2: Add the action markup**

In `index.html`, directly after `<div class="region-grid" id="regionGrid"></div>`:

```html
            <div class="field-row region-actions">
              <button type="button" id="mergeBtn" class="ghost small"  disabled>合并</button>
              <button type="button" id="splitBtn" class="ghost small"  disabled>拆分</button>
              <button type="button" id="resetRegionsBtn" class="ghost small" >全部还原</button>
            </div>
            <div class="seg" id="regionKind" hidden>
              <button class="seg-btn active" type="button" data-kind="strip">连票</button>
              <button class="seg-btn" type="button" data-kind="big">大票</button>
            </div>
```

- [ ] **Step 3: Add the selection styles**

Append to `index.css`:

```css
.region-cell.selected { background: #4a6fa5; color: #fff; border-color: #7fa8d8; }
.region-actions { gap: 6px; }
```

- [ ] **Step 4: Register the new elements**

In `index.js`, add to `els` after `regionGrid`:

```js
  mergeBtn: document.getElementById('mergeBtn'),
  splitBtn: document.getElementById('splitBtn'),
  resetRegionsBtn: document.getElementById('resetRegionsBtn'),
  regionKind: document.getElementById('regionKind'),
```

- [ ] **Step 5: Implement `expandSelection`**

Insert above `renderRegionGrid`:

```js
// 选区扩张到它碰到的每个区域的外接矩形，反复直到稳定。
// 这样拖选永远不会「咬掉半个」已合并区域 —— 部分覆盖一个 2×2 会把整块拉进选区。
function expandSelection(geo, sel) {
  let { c0, r0, cw, ch } = sel;
  for (;;) {
    let c1 = c0 + cw, r1 = r0 + ch, grew = false;
    for (const g of geo.groups) {
      const gx1 = g.c0 + g.cw, gy1 = g.r0 + g.ch;
      if (g.c0 >= c1 || gx1 <= c0 || g.r0 >= r1 || gy1 <= r0) continue;   // 不相交
      if (g.c0 < c0) { c0 = g.c0; grew = true; }
      if (g.r0 < r0) { r0 = g.r0; grew = true; }
      if (gx1 > c1) { c1 = gx1; grew = true; }
      if (gy1 > r1) { r1 = gy1; grew = true; }
    }
    cw = c1 - c0; ch = r1 - r0;
    if (!grew) return { c0, r0, cw, ch };
  }
}
```

- [ ] **Step 6: Run the `expandSelection` assertions**

```bash
chromium --headless --disable-gpu --no-sandbox --hide-scrollbars \
  --window-size=1000,720 --virtual-time-budget=3000 \
  --dump-dom "file://$PWD/_test.html" 2>/dev/null | grep -o '<title>[^<]*</title>'
```

Expected: `<title>ALL PASS (4)</title>`

- [ ] **Step 7: Render the selection**

Add a module-level `let selection = null;` next to `let lastRegionSig = '';`.

In `renderRegionGrid`, include the selection in the signature and mark the cells. Replace the `sig` line with:

```js
  const selSig = selection ? [selection.c0, selection.r0, selection.cw, selection.ch].join(',') : '-';
  const sig = geo.X + 'x' + geo.Y + '|' + geo.Sw.toFixed(3) + 'x' + geo.Sh.toFixed(3) + '|' + selSig + '|' +
    geo.groups.map((g) => [g.c0, g.r0, g.cw, g.ch, g.big ? 1 : 0].join(',')).join(';');
```

and inside the `forEach`, after `cell.className = ...`, add:

```js
    if (selection && g.c0 >= selection.c0 && g.c0 + g.cw <= selection.c0 + selection.cw &&
        g.r0 >= selection.r0 && g.r0 + g.ch <= selection.r0 + selection.ch) {
      cell.classList.add('selected');
    }
```

At the end of `renderRegionGrid`, add the control-state update:

```js
  const covered = selection ? geo.groups.filter((g) =>
    g.c0 >= selection.c0 && g.c0 + g.cw <= selection.c0 + selection.cw &&
    g.r0 >= selection.r0 && g.r0 + g.ch <= selection.r0 + selection.ch) : [];
  const soleMerged = covered.length === 1 && covered[0].cw * covered[0].ch > 1;
  els.mergeBtn.disabled = !(selection && selection.cw * selection.ch > 1 && !soleMerged);
  els.splitBtn.disabled = !soleMerged;
  els.regionKind.hidden = !soleMerged;
  if (soleMerged) {
    const kind = covered[0].big ? 'big' : 'strip';
    for (const b of els.regionKind.querySelectorAll('.seg-btn')) {
      b.classList.toggle('active', b.dataset.kind === kind);
    }
  }
```

- [ ] **Step 8: Implement `bindRegionGrid`**

Insert after `renderRegionGrid`:

```js
// 跨格区域网格的编辑交互：拖选 → 合并 / 拆分 / 大票连票切换。
// 用 pointer 事件（非 mouse）以便触摸端可用；网格的 touch-action:none 由 CSS 提供。
function bindRegionGrid() {
  const grid = els.regionGrid;
  let anchor = null;   // 拖选起点格 {c, r}

  // 由指针位置反推格坐标：网格是 X 列 Y 行的等分 CSS Grid
  const cellAt = (e) => {
    const geo = computeGeometry(state);
    const rect = grid.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const c = clamp(Math.floor((e.clientX - rect.left) / rect.width * geo.X), 0, geo.X - 1);
    const r = clamp(Math.floor((e.clientY - rect.top) / rect.height * geo.Y), 0, geo.Y - 1);
    return { c, r };
  };

  const setSelection = (from, to) => {
    const geo = computeGeometry(state);
    selection = expandSelection(geo, {
      c0: Math.min(from.c, to.c), r0: Math.min(from.r, to.r),
      cw: Math.abs(from.c - to.c) + 1, ch: Math.abs(from.r - to.r) + 1,
    });
    renderRegionGrid(geo);
  };

  grid.addEventListener('pointerdown', (e) => {
    const cell = cellAt(e);
    if (!cell) return;
    anchor = cell;
    grid.setPointerCapture(e.pointerId);
    setSelection(anchor, anchor);
  });
  grid.addEventListener('pointermove', (e) => {
    if (!anchor) return;
    const cell = cellAt(e);
    if (cell) setSelection(anchor, cell);
  });
  const endDrag = (e) => {
    if (!anchor) return;
    anchor = null;
    if (grid.hasPointerCapture(e.pointerId)) grid.releasePointerCapture(e.pointerId);
  };
  grid.addEventListener('pointerup', endDrag);
  grid.addEventListener('pointercancel', endDrag);

  // 区域变更后统一收尾：重新钳制裁剪、重绘、落盘
  const applyRegions = () => {
    clampAllCrops();
    renderPreview();
    saveOptions();
  };

  els.mergeBtn.addEventListener('click', () => {
    if (!selection) return;
    const s = selection;
    // 被完全覆盖的旧合并全部丢弃，换成一个新区域
    state.merges = state.merges.filter((m) =>
      !(m.c >= s.c0 && m.c + m.w <= s.c0 + s.cw && m.r >= s.r0 && m.r + m.h <= s.r0 + s.ch));
    state.merges.push({ c: s.c0, r: s.r0, w: s.cw, h: s.ch, big: false });
    applyRegions();
  });

  els.splitBtn.addEventListener('click', () => {
    if (!selection) return;
    const s = selection;
    state.merges = state.merges.filter((m) => !(m.c === s.c0 && m.r === s.r0));
    applyRegions();
  });

  els.resetRegionsBtn.addEventListener('click', () => {
    state.merges = [];
    selection = null;
    applyRegions();
  });

  els.regionKind.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn || !selection) return;
    const m = state.merges.find((x) => x.c === selection.c0 && x.r === selection.r0);
    if (!m) return;
    m.big = btn.dataset.kind === 'big';
    applyRegions();
  });
}
```

- [ ] **Step 9: Call `bindRegionGrid` from startup**

In the 启动 block at the bottom of `index.js`, add the call next to the other `bind*()` calls, before `registerServiceWorker()`:

```js
bindRegionGrid();
```

- [ ] **Step 10: Verify the full edit cycle**

```bash
python3 - <<'PY'
src = open('index.html').read()
inject = '''
<script>
(function () {
  Object.assign(state, {
    d: 8, g: 4, nx: 8, ny: 12, matrixX: 4, matrixY: 4, view: 'fit',
    merges: [], crops: {}, images: [],
  });
  syncInputsFromState();
  renderPreview();
  const grid = els.regionGrid;
  grid.setPointerCapture = () => {};      // 合成 pointerId 不是活动指针，真捕获会抛
  grid.hasPointerCapture = () => false;
  const rect = grid.getBoundingClientRect();
  const geo0 = computeGeometry(state);
  const at = (c, r) => ({
    clientX: rect.left + (c + 0.5) / geo0.X * rect.width,
    clientY: rect.top + (r + 0.5) / geo0.Y * rect.height,
  });
  const pd = (c, r) => grid.dispatchEvent(new PointerEvent('pointerdown',
    { ...at(c, r), pointerId: 1, bubbles: true }));
  const pm = (c, r) => grid.dispatchEvent(new PointerEvent('pointermove',
    { ...at(c, r), pointerId: 1, bubbles: true }));
  const pu = () => grid.dispatchEvent(new PointerEvent('pointerup',
    { pointerId: 1, bubbles: true }));

  const results = [];
  const eq = (n, got, want) => results.push(got === want ? 'ok ' + n : 'FAIL ' + n + ' got=' + got);

  // 拖选 (1,1)→(2,2) 后合并 → 一个 2×2
  pd(1, 1); pm(2, 2); pu();
  els.mergeBtn.click();
  eq('merge', JSON.stringify(state.merges), '[{"c":1,"r":1,"w":2,"h":2,"big":false}]');
  eq('grid-count', els.regionGrid.children.length, 13);

  // 点合并区域内任意一格 → 选区扩张到整块，大票开关出现
  pd(2, 2); pu();
  eq('reselect', JSON.stringify(selection), '{"c0":1,"r0":1,"cw":2,"ch":2}');
  eq('kind-shown', els.regionKind.hidden, false);

  // 切到大票
  els.regionKind.querySelector('[data-kind="big"]').click();
  eq('big', state.merges[0].big, true);

  // 拆分
  pd(1, 1); pm(2, 2); pu();
  els.splitBtn.click();
  eq('split', state.merges.length, 0);
  eq('grid-restored', els.regionGrid.children.length, 16);

  // 部分覆盖已有合并 → 选区扩张，合并吞掉整块
  state.merges = [{ c: 1, r: 1, w: 2, h: 2, big: false }];
  renderPreview();
  pd(0, 1); pm(1, 1); pu();
  eq('expand', JSON.stringify(selection), '{"c0":0,"r0":1,"cw":3,"ch":2}');
  els.mergeBtn.click();
  eq('swallow', JSON.stringify(state.merges), '[{"c":0,"r":1,"w":3,"h":2,"big":false}]');

  // 全部还原
  els.resetRegionsBtn.click();
  eq('reset', state.merges.length, 0);

  const bad = results.filter(r => r.startsWith('FAIL'));
  document.title = bad.length ? bad.join(' | ') : 'ALL PASS (' + results.length + ')';
})();
</script>
'''
open('_test.html','w').write(src.replace('<script src="index.js"></script>',
                                         '<script src="index.js"></script>' + inject))
PY

chromium --headless --disable-gpu --no-sandbox --hide-scrollbars \
  --window-size=1000,720 --virtual-time-budget=3000 \
  --dump-dom "file://$PWD/_test.html" 2>/dev/null | grep -o '<title>[^<]*</title>'
```

Expected: `<title>ALL PASS (10)</title>`

- [ ] **Step 11: Reproduce the reference souvenir sheet**

```bash
python3 - <<'PY'
src = open('index.html').read()
inject = '''
<script>
(function () {
  Object.assign(state, {
    d: 6, g: 3, nx: 10, ny: 14, matrixX: 4, matrixY: 4, view: 'fit',
    merges: [
      { c: 1, r: 0, w: 2, h: 1, big: false },   // 顶部连票（保留内部齿孔）
      { c: 1, r: 2, w: 2, h: 2, big: true },    // 中央大票（无内部齿孔）
    ],
    innerMarginTop: 0.75, innerMarginRight: 0.75,
    innerMarginBottom: 0.75, innerMarginLeft: 0.75,
    outerMarginTop: 2, outerMarginRight: 2, outerMarginBottom: 2, outerMarginLeft: 2,
    borderWidth: 0, baseColor: '#ffffff', baseOpacity: 1,
    innerColor: '#ffffff', innerColorOpacity: 1, innerFill: 'solid',
    outerColor: '#cfe0ee', outerColorOpacity: 1, outerFill: 'solid',
    crops: {}, images: [],
  });
  const img = new Image();
  img.onload = () => { state.images = [img]; syncInputsFromState(); renderPreview(); };
  img.src = 'doc/plan/img/input.png';
})();
</script>
'''
open('_test.html','w').write(src.replace('<script src="index.js"></script>',
                                         '<script src="index.js"></script>' + inject))
PY

chromium --headless --disable-gpu --no-sandbox --hide-scrollbars \
  --window-size=1000,720 --virtual-time-budget=3000 \
  --screenshot=out-sheet.png "file://$PWD/_test.html"
```

Read `out-sheet.png` and confirm: the top 2×1 region shows one continuous photo **with** a perforation line down its middle; the central 2×2 region shows one continuous photo **without** interior perforations, and its outer perforation ring is unbroken at all four corners.

- [ ] **Step 12: Commit**

```bash
rm -f _test.html out-sheet.png
git add index.html index.css index.js
git commit -m "feat: merge, split and toggle large-format on span regions"
```

---

### Task 6: Update `AGENTS.md`

`AGENTS.md` is the file every future agent reads first. Three of its sections now describe code that no longer exists.

**Files:**
- Modify: `AGENTS.md` — the "Span groups (连票)" paragraph under Geometry, the Persistence section, and the Gotchas list

Note: `CLAUDE.md` and `GEMINI.md` are symlinks to `AGENTS.md`. Edit `AGENTS.md`.

- [ ] **Step 1: Rewrite the span-groups paragraph**

Replace the paragraph beginning **"Span groups (连票) are the unit of photo layout, not cells."** with:

```markdown
**Span regions are the unit of photo layout, not cells.** `state.merges` holds only the
regions that cover more than one cell (`{c, r, w, h, big}`); `computeGroups(X, Y, merges)`
places each one (clamped to the matrix, **first-wins** on overlap, ignored if clipping
leaves it a single cell), fills every unclaimed cell with a 1×1 region, and sorts by
`(r0, c0)` — which is also the photo-fill order. `geo.groups` is that list and
`geo.cellGroup` is an `Int32Array` cell→index lookup so `groupAt` stays O(1) during drags.
An empty `merges` is the per-cell mode. `uniformMerges(X, Y, spanX, spanY)` regenerates the
list as a uniform split (the 均匀分块 button); `state.spanX`/`spanY` are now **only** that
button's remembered inputs and do not affect geometry. Out-of-bounds merges are clipped for
rendering but **kept in `state.merges` unmodified**, so shrinking and re-growing the matrix
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
```

- [ ] **Step 2: Update the crop-key sentence**

In the "Photos & per-group crop" paragraph, replace `Because `1×1` groups start at their own cell, existing per-cell crop keys keep working unchanged.` with:

```markdown
Crop keys are the region's **start cell**, which stays unique under an irregular tiling and
survives a clip (clipping shrinks `cw`/`ch`, never the origin), so crop data carries across
layout changes untouched.
```

- [ ] **Step 3: Update Persistence**

In the Persistence section, add `merges` to the list of `PERSISTED` keys and note:

```markdown
`merges` rides in `PERSISTED`, so scheme export/import and `resetScheme` cover it for free.
There is no migration from the pre-region format: `spanX`/`spanY` in an old saved state no
longer affect geometry, so an old profile opens in per-cell mode until 均匀分块 is applied.
```

- [ ] **Step 4: Add a Gotchas entry**

Append to the Gotchas list:

```markdown
- **`renderRegionGrid`'s signature dedup is load-bearing**: it runs from `renderPreview`,
  which fires every drag frame; rebuilding the grid's DOM each frame would thrash the panel
  and drop the selection. The `lastRegionSig` comparison (which includes the selection) is
  what keeps it to one rebuild per actual change.
- **The 大票 hole filter needs its epsilon.** Comparing a hole's `mT + k*pitch` against a
  region boundary's `mT + r0*(ny*pitch)` is exact in maths and off by a ULP in floating
  point. Without `EPS`, a boundary hole is occasionally judged interior and dropped, leaving
  a visible gap in a large-format stamp's perforation ring.
```

- [ ] **Step 5: Verify the symlinks still resolve**

```bash
ls -l CLAUDE.md GEMINI.md
head -3 CLAUDE.md
```

Expected: both are symlinks to `AGENTS.md` and `head` shows the updated file's first lines.

- [ ] **Step 6: Commit**

```bash
git add AGENTS.md
git commit -m "docs: describe span regions and large-format perforation suppression"
```

---

## Final verification

- [ ] `git status --short` is clean — no `_test.html`, `_frame.html`, or `out*.png` left in the repo
- [ ] Open `index.html` over `file://` in a real browser: merge a 2×2, toggle 大票, reload, and confirm the layout persists
- [ ] Confirm the PWA still registers: `grep -n "registerServiceWorker" index.js` and check `sw.js`'s precache list still names only files that exist
- [ ] Per `AGENTS.md`, image persistence cannot be verified under `--virtual-time-budget`; if IndexedDB behavior is in doubt, verify over `http://localhost` with a throwaway `--user-data-dir` (the service worker caches edits otherwise)
