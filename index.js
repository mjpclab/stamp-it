'use strict';

/*
 * 邮票化小工具 —— Canvas 2D 实现
 *
 * 几何模型（统一单位 pitch = 孔直径 d + 孔间距 g）：
 *   - 邮票矩形：Sw = nx*pitch, Sh = ny*pitch
 *   - 外边距 = d/2：画布 W = Sw+d, H = Sh+d，邮票矩形偏移 (d/2, d/2)
 *   - 齿孔：半径 d/2 的整圆，圆心落在邮票矩形边线上，按 pitch 间隔；边角圆形成四分之一孔
 *   - 内边距 = 四向各 N 个 pitch（默认 0.75），作用于每个「区域」的外缘
 *   - 边框 = 内边距内缘的实线框（粗细/间距均为像素）；图片再内缩「粗细 + 间距」
 *   - 区域 = state.merges 描述的矩形集合（越界裁剪、先到先得，裁剪后退化为单格则整条忽略），
 *     未被占用的格各自补成隐式 1×1 区域；区域内部相邻格无内边距、画面连续，仅被齿孔打断（连票）。
 *     大票区域（big:true）额外抑制内部齿孔，只保留外缘一圈
 *
 * 渲染顺序（离屏分层、自底向上合成，天然支持半透明导出）：
 *   1. base 底色层（baseColor@baseOpacity）—— 最底层，齿孔镂空处透出它
 *   2. sheet 外边距层（外边距填充 纯色/线性/径向渐变（横跨整幅画布） + outerImage cover，各自独立透明度）
 *   3. stamp 邮票层（内边距填充 纯色/线性/径向渐变 + innerImage cover + 各区域照片 + 各区域边框），叠入 deco
 *   4. destination-out 在 deco 上打孔，穿透 sheet + stamp，露出底色 → 真实镂空
 *   5. 合成到目标：先 base，再叠 deco
 * 改用离屏分层（而非单次 destination-over）是为了让 outerOpacity/baseOpacity 保持均匀、
 * 渐变在用户坐标系内渲染，并让齿孔能透出一个可控的底色层。
 */

const DPR_LIMIT = 8;      // 预览缩放上限
const ZOOM_STEP = 1.1;    // 每格滚轮缩放系数
const MIN_PERF = 3;       // 齿孔数下限
const STORAGE_PREFIX = 'stampit_';   // localStorage key 前缀
const PERSISTED = ['d', 'g', 'nx', 'ny', 'matrixX', 'matrixY', 'spanX', 'spanY',
  'merges', 'baseColor', 'baseOpacity',
  'outerColor', 'outerColorOpacity', 'outerImageOpacity', 'outerFill', 'outerStops', 'outerAngle', 'outerOriginX', 'outerOriginY',
  'outerMarginTop', 'outerMarginRight', 'outerMarginBottom', 'outerMarginLeft',
  'innerMarginTop', 'innerMarginRight', 'innerMarginBottom', 'innerMarginLeft',
  'borderWidth', 'borderGap', 'borderColor', 'borderOpacity',
  'innerColor', 'innerColorOpacity', 'innerImageOpacity', 'innerFill', 'innerStops', 'innerAngle', 'innerOriginX', 'innerOriginY',
  'exportScale', 'view', 'stampTab', 'layerTab', 'dragTarget',
  'crops', 'outerCrop', 'innerCrop', 'picks'];   // 裁剪/用图元数据随选项落盘；图片本体走 IndexedDB

const state = {
  d: 8,
  g: 4,
  nx: 16,
  ny: 24,
  matrixX: 1,                            // 矩阵列数
  matrixY: 1,                            // 矩阵行数
  spanX: 1,                              // 「均匀分块」输入框的记忆值，不参与几何
  spanY: 1,
  merges: [],                            // 跨格区域（只存跨多格的）：{c,r,w,h,big}；空 = 全部逐格
  baseColor: '#000000',                  // 最底层底色：齿孔镂空处透出它
  baseOpacity: 1,                        // 底色透明度（调低可导出透明/半透明 PNG）
  outerColor: '#000000',                 // 纯色模式用色
  outerColorOpacity: 0,                  // 外边距背景色/渐变透明度（默认 0：露出底色）
  outerImageOpacity: 1,                  // 外边距背景图透明度
  outerFill: 'solid',                    // 'solid' | 'linear' | 'radial'
  outerStops: [{ pos: 0, color: '#ffffff' }, { pos: 1, color: '#666666' }],
  outerAngle: 90,                        // 线性渐变角度（度）
  outerOriginX: 0.5,                     // 径向渐变原点 X（0–1，相对整幅画布宽）
  outerOriginY: 0.5,                     // 径向渐变原点 Y（0–1，相对整幅画布高）
  outerMarginTop: 0,                     // 外边距步进（四向独立）：0=半孔，每+1 增加一个 pitch
  outerMarginRight: 0,
  outerMarginBottom: 0,
  outerMarginLeft: 0,
  innerMarginTop: 0.75,                  // 内边距步进（四向独立）：每格 N 个 pitch
  innerMarginRight: 0.75,
  innerMarginBottom: 0.75,
  innerMarginLeft: 0.75,
  borderWidth: 0,                        // 组边框粗细（像素）：0 = 不画边框
  borderGap: 0,                          // 边框到图片的留白（像素）：内边距里的另一层内边距
  borderColor: '#ffffff',
  borderOpacity: 1,
  outerImage: null,                      // 外边距背景图（session 态，不持久化）
  innerImage: null,                      // 内边距背景图（session 态，不持久化）
  innerColor: '#ffffff',                 // 纯色模式用色
  innerColorOpacity: 1,                  // 内边距背景色/渐变透明度（不含照片）
  innerImageOpacity: 1,                  // 内边距背景图透明度
  innerFill: 'solid',                    // 'solid' | 'linear' | 'radial'
  innerStops: [{ pos: 0, color: '#f0d979' }, { pos: 1, color: '#a67c1a' }],
  innerAngle: 90,                        // 线性渐变角度（度）
  innerOriginX: 0.5,                     // 径向渐变原点 X（0–1，相对邮票矩形宽）
  innerOriginY: 0.5,                     // 径向渐变原点 Y（0–1，相对邮票矩形高）
  exportScale: 2,
  view: 'fit',              // 'fit' 适应窗口 | 'actual' 1:1 实际像素
  stampTab: 'matrix',       // 照片与齿孔标签页：'matrix' | 'perf'
  layerTab: 'inner',        // 图层设置标签页：'inner' | 'outer' | 'base'
  // 拖拽/缩放作用对象：'auto' 按位置与 Alt 键推断（原行为）| 'photo' | 'inner' | 'outer' 强制锁定
  // 触摸设备没有 Alt 键，锁定项是访问内背景图的唯一入口
  dragTarget: 'auto',
  images: [],               // 多图数组（session 态，不持久化）；按行优先顺序重复填充矩阵
  imageMeta: [],            // 与 images 同序等长的来源文件记录 {blob, name, key}：去重靠 key，blob 供持久化/导出
  crops: {},                // 每区域独立裁剪：键 "c0,r0"（区域起始格）→ {scale, offsetX, offsetY}
  picks: {},                // 每区域指定用图：键 "c0,r0"（同 crops）→ images 下标；缺省 = 按顺序循环
  outerCrop: { scale: 1, offsetX: 0, offsetY: 0 },   // 外背景图缩放/平移（session 态）
  innerCrop: { scale: 1, offsetX: 0, offsetY: 0 },   // 内背景图缩放/平移（session 态）
};

// 出厂默认值快照（在 loadOptions 改写 state 之前拍下），供“重置方案”还原最初始状态
const DEFAULTS = structuredClone(state);

const IDENTITY_CROP = { scale: 1, offsetX: 0, offsetY: 0 };
// 裁剪按「区域」存储，键为区域的起始格坐标 "c0,r0"；空 merges（逐格模式）下即等价于逐格键。
// 编辑区域（合并大票/合并连票/拆分/均匀分块/拆分全部）后落单的旧键保留不删，撤销编辑后自动复活。
function getCrop(c0, r0) { return state.crops[c0 + ',' + r0] || IDENTITY_CROP; }   // 只读，缺省返回共享单位裁剪
function groupCrop(c0, r0) {                                                       // 取（并按需创建）可编辑的组裁剪
  const k = c0 + ',' + r0;
  return state.crops[k] || (state.crops[k] = { scale: 1, offsetX: 0, offsetY: 0 });
}

const canvas = document.getElementById('preview');
const ctx = canvas.getContext('2d');

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* ---------- 几何 ---------- */

// 合并记录的最基本合法性：非 null 且为对象。state.merges 来自方案导入/localStorage，
// 可能含损坏项（如 null）。computeGroups 不是唯一遍历 state.merges 的地方 —— 区域网格
// 的合并/拆分/大票点击处理器也直接读它，所以两边共用这一个谓词，不各自假设合法性、
// 逐渐失去同步。
function isValidMergeRecord(m) {
  return !!m && typeof m === 'object';
}

// 由「合并区域」派生完整区域列表：按顺序落位每个合并（越界裁剪、与已占格重叠则整个忽略），
// 未被占用的格各自成 1×1 区域；最后按 (r0,c0) 行优先排序 —— 这个顺序也是照片填充顺序。
// 裁剪后退化为单格的合并被忽略：该格会作为隐式 1×1 补回，结果一致。
function computeGroups(X, Y, merges) {
  const taken = new Uint8Array(X * Y);
  const groups = [];
  for (const m of (Array.isArray(merges) ? merges : [])) {
    if (!isValidMergeRecord(m)) continue;   // 外部数据（方案文件/localStorage）可能损坏，跳过而非抛错
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

// 判断合并记录 m 的起点是否为 (c0, r0)：与 computeGroups 用同一套取整规则，
// 否则手工写入 / 导入方案里的非整数坐标能正常落位显示，却永远匹配不上，拆分/大票开关会失灵。
// 对损坏记录（如 null）返回 false 而非抛错，本身即安全，调用方不必再各自判断合法性一遍。
function mergeOriginMatches(m, c0, r0) {
  return isValidMergeRecord(m) && Math.round(m.c) === c0 && Math.round(m.r) === r0;
}

// 判断合并记录 m（取整后）是否与矩形 rect={c0,r0,cw,ch} 相交（半开区间，贴边不算相交）。
// 用于合并前清场：即使 m 因越界/与更早的合并冲突而被 computeGroups 整条跳过、
// 不出现在 geo.groups 里，它依然留在 state.merges 中 —— 只按「完全覆盖」过滤会漏掉
// 这类不可见的合并，让它在之后抢先命中、悄悄吞掉用户刚建立的新合并。
// 对损坏记录返回 false（不相交）而非抛错，同上，调用方不必再各自判断合法性一遍。
function mergeIntersectsRect(m, rect) {
  if (!isValidMergeRecord(m)) return false;
  const mc0 = Math.round(m.c), mr0 = Math.round(m.r);
  const mc1 = mc0 + Math.round(m.w), mr1 = mr0 + Math.round(m.h);
  const rc1 = rect.c0 + rect.cw, rr1 = rect.r0 + rect.ch;
  return mc0 < rc1 && mc1 > rect.c0 && mr0 < rr1 && mr1 > rect.r0;
}

// groups 中完整落在 rect 内的区域（起点与终点都不越出 rect）。区域网格用它算选区
// 覆盖了哪些已有区域：判断拆分按钮是否可用，以及用图选择条该写哪些区域。
function regionsWithin(groups, rect) {
  return groups.filter((g) =>
    g.c0 >= rect.c0 && g.c0 + g.cw <= rect.c0 + rect.cw &&
    g.r0 >= rect.r0 && g.r0 + g.ch <= rect.r0 + rect.ch);
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

function computeGeometry(s) {
  const pitch = s.d + s.g;
  const Sw = s.nx * pitch;            // 单张邮票
  const Sh = s.ny * pitch;
  const X = Math.max(1, Math.round(s.matrixX));
  const Y = Math.max(1, Math.round(s.matrixY));
  const groups = computeGroups(X, Y, s.merges);     // 跨格区域：合并区域 + 隐式 1×1，(r0,c0) 行优先
  const cellGroup = cellGroupIndex(X, Y, groups);   // 格 → 区域下标，供命中测试 O(1) 查表
  const blockW = X * Sw;              // 整个矩阵块
  const blockH = Y * Sh;
  const half = s.d / 2;                          // 半孔基准
  const mT = half + s.outerMarginTop * pitch;    // 四向外边距：半孔 + N 个 pitch
  const mR = half + s.outerMarginRight * pitch;
  const mB = half + s.outerMarginBottom * pitch;
  const mL = half + s.outerMarginLeft * pitch;
  const iT = s.innerMarginTop * pitch;           // 四向内边距：N 个 pitch
  const iR = s.innerMarginRight * pitch;
  const iB = s.innerMarginBottom * pitch;
  const iL = s.innerMarginLeft * pitch;
  const bw = Math.max(0, s.borderWidth);         // 边框粗细（像素）
  const bg = Math.max(0, s.borderGap);           // 边框到图片的留白（像素）
  return {
    d: s.d, pitch, Sw, Sh, X, Y, blockW, blockH,
    groups, cellGroup,
    W: blockW + mL + mR, H: blockH + mT + mB,
    mT, mR, mB, mL, iT, iR, iB, iL, bw, bg,
    blockX: mL, blockY: mT,
  };
}

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

// 单条用图指定是否可用，可用则返回下标，否则 null。同 isValidMergeRecord：合法性判断放在
// 读取该记录的函数内部，不要求调用方先自己判一遍 —— 否则总有一处会忘了判，导致界面显示
// 与实际渲染各说各话。越界（图片变少）与损坏（方案导入未逐条校验）都归为不可用。
function validPick(c0, r0) {
  const p = state.picks[c0 + ',' + r0];
  return Number.isInteger(p) && p >= 0 && p < state.images.length ? p : null;
}

// 第 i 个区域用哪张图（返回 images 下标）：优先取用户显式指定的，否则按区域的行优先顺序
// 重复填充。不可用的指定只是回退，记录本身不删 —— 与孤儿裁剪键、越界 merges 同一政策，
// 图片加回来后指定自动复活。
function groupImageIndex(i, g) {
  const p = validPick(g.c0, g.r0);
  return p === null ? i % state.images.length : p;
}

function groupImage(i, g) {
  return state.images[groupImageIndex(i, g)];
}

function holeCenters(geo) {
  const out = [];
  const { mT, mL, pitch, Sw, Sh, X, Y } = geo;
  const nx = state.nx, ny = state.ny;
  // 大票：抑制区域内部的齿孔，只保留外缘一圈。
  // 用严格不等式 + EPS：边界上的孔全部保留，内部齿孔线的端点正落在边界上，故边缘无缺口。
  // EPS 是必需的 —— 边界 y = mT + r0*(ny*pitch) 与孔位 y = mT + k*pitch 在
  // k = r0*ny 时数学上相等，但浮点乘法不满足结合律，可能差一个 ULP。
  const EPS = 1e-6;
  const bigRects = geo.groups.filter((g) => g.big).map((g) => groupOuterRect(geo, g));
  const inside = (x, y) => bigRects.some((R) =>
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

/* ---------- 照片 cover 裁剪 ---------- */

function coverScale(img, cw, ch) {
  return Math.max(cw / img.naturalWidth, ch / img.naturalHeight);
}

// 把 img 以 cover + 指定 crop（scale/offset，offset 相对内容区中心）绘入内容矩形 content={x,y,w,h}
function imageDrawRect(img, content, crop) {
  const eff = coverScale(img, content.w, content.h) * crop.scale;
  const w = img.naturalWidth * eff;
  const h = img.naturalHeight * eff;
  const cx = content.x + content.w / 2 + crop.offsetX;
  const cy = content.y + content.h / 2 + crop.offsetY;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

// 钳制 crop 的 offset：保证 img 始终铺满 w×h 的内容区（通用）
function clampCropTo(crop, img, w, h) {
  if (!img) return;
  const eff = coverScale(img, w, h) * crop.scale;
  const ox = Math.max(0, (img.naturalWidth * eff - w) / 2);
  const oy = Math.max(0, (img.naturalHeight * eff - h) / 2);
  crop.offsetX = clamp(crop.offsetX, -ox, ox);
  crop.offsetY = clamp(crop.offsetY, -oy, oy);
}

// 钳制单个区域 crop 的 offset：保证该区域图片铺满内容区
function clampCropGroup(geo, g, i) {
  if (!state.images.length) return;
  const content = groupContent(geo, g);
  if (content.w <= 0 || content.h <= 0) return;   // 内边距过大挤没内容区时跳过钳制
  clampCropTo(groupCrop(g.c0, g.r0), groupImage(i, g), content.w, content.h);
}

// 钳制外背景图 crop：内容区为整张画布
function clampOuterCrop() {
  if (!state.outerImage) return;
  const geo = computeGeometry(state);
  clampCropTo(state.outerCrop, state.outerImage, geo.W, geo.H);
}

// 钳制内背景图 crop：内容区为矩阵块
function clampInnerCrop() {
  if (!state.innerImage) return;
  const geo = computeGeometry(state);
  clampCropTo(state.innerCrop, state.innerImage, geo.blockW, geo.blockH);
}

// 几何变化后重新钳制所有已编辑过的组
function clampAllCrops() {
  const geo = computeGeometry(state);
  geo.groups.forEach((g, i) => {
    if (state.crops[g.c0 + ',' + g.r0]) clampCropGroup(geo, g, i);
  });
  clampOuterCrop();
  clampInnerCrop();
}

/* ---------- 填充（纯色 / 线性 / 径向渐变） ---------- */

// 内边距与外边距共用同一套填充逻辑：分组即 state 键 / 控件 id 的前缀（innerFill、outerAngle…），
// 差别只在渐变的参考矩形——内边距横跨整个矩阵块，外边距横跨整幅画布。
const FILL_RECTS = {
  inner: (geo) => ({ x: geo.blockX, y: geo.blockY, w: geo.blockW, h: geo.blockH }),
  outer: (geo) => ({ x: 0, y: 0, w: geo.W, h: geo.H }),
};
const FILL_GROUPS = Object.keys(FILL_RECTS);

function fillStyle(targetCtx, geo, p) {
  const s = state;
  const rawStops = s[p + 'Stops'];
  if (s[p + 'Fill'] === 'solid' || !Array.isArray(rawStops) || rawStops.length === 0) {
    return s[p + 'Color'];
  }
  const stops = rawStops
    .map((st) => ({ pos: clamp(st.pos, 0, 1), color: st.color }))
    .sort((a, b) => a.pos - b.pos);

  const { x: bx, y: by, w: bw, h: bh } = FILL_RECTS[p](geo);
  const cx = bx + bw / 2;
  const cy = by + bh / 2;
  let grad;
  if (s[p + 'Fill'] === 'radial') {
    // 原点由百分比指定，半径取到最远角点的距离以保证铺满
    const ox = bx + bw * s[p + 'OriginX'];
    const oy = by + bh * s[p + 'OriginY'];
    const r = Math.max(
      Math.hypot(ox - bx, oy - by),
      Math.hypot(ox - (bx + bw), oy - by),
      Math.hypot(ox - bx, oy - (by + bh)),
      Math.hypot(ox - (bx + bw), oy - (by + bh)),
    );
    grad = targetCtx.createRadialGradient(ox, oy, 0, ox, oy, r);
  } else {                       // linear
    const th = (s[p + 'Angle'] * Math.PI) / 180;
    const co = Math.cos(th), si = Math.sin(th);
    const L = (Math.abs(bw * co) + Math.abs(bh * si)) / 2;
    grad = targetCtx.createLinearGradient(cx - L * co, cy - L * si, cx + L * co, cy + L * si);
  }
  for (const st of stops) grad.addColorStop(st.pos, st.color);
  return grad;
}

/* ---------- 渲染 ---------- */

// 建一个与目标等尺寸、已套好 scale 变换的离屏图层
// 照片/背景图的 drawImage 全在离屏层上发生，故重采样质量设在这里即可覆盖三处
function layerCanvas(geo, scale) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(geo.W * scale));
  c.height = Math.max(1, Math.round(geo.H * scale));
  const cx = c.getContext('2d');
  cx.imageSmoothingQuality = 'high';
  cx.setTransform(scale, 0, 0, scale, 0, 0);
  return cx;
}

function render(targetCtx, scale) {
  const s = state;
  const geo = computeGeometry(s);
  const cv = targetCtx.canvas;
  cv.width = Math.max(1, Math.round(geo.W * scale));
  cv.height = Math.max(1, Math.round(geo.H * scale));
  targetCtx.imageSmoothingQuality = 'high';   // 必须在改 canvas 尺寸之后设：改尺寸会重置上下文状态

  // --- 外边距层 sheet：外色/渐变(@outerColorOpacity) + 外背景图 cover(@outerImageOpacity) 各自独立透明度 ---
  const sheet = layerCanvas(geo, scale);
  sheet.globalAlpha = s.outerColorOpacity;
  sheet.fillStyle = fillStyle(sheet, geo, 'outer');
  sheet.fillRect(0, 0, geo.W, geo.H);
  sheet.globalAlpha = 1;
  if (s.outerImage) {
    sheet.save();
    sheet.globalAlpha = s.outerImageOpacity;
    sheet.beginPath(); sheet.rect(0, 0, geo.W, geo.H); sheet.clip();
    const full = { x: 0, y: 0, w: geo.W, h: geo.H };
    const dr = imageDrawRect(s.outerImage, full, state.outerCrop);   // cover + 缩放/平移
    sheet.drawImage(s.outerImage, dr.x, dr.y, dr.w, dr.h);
    sheet.restore();
  }

  // --- 装饰层 deco = 外边距层 + 邮票层，最后一并打孔 ---
  const deco = layerCanvas(geo, scale);
  deco.setTransform(1, 0, 0, 1, 0, 0);                 // 先以设备像素叠入 sheet
  deco.drawImage(sheet.canvas, 0, 0);
  deco.setTransform(scale, 0, 0, scale, 0, 0);          // 恢复几何坐标绘制邮票

  // 内边距层：背景色/渐变(@innerColorOpacity) + 背景图 cover(@innerImageOpacity) 各自独立透明度
  const inner = layerCanvas(geo, scale);
  inner.globalAlpha = s.innerColorOpacity;
  inner.fillStyle = fillStyle(inner, geo, 'inner');
  inner.fillRect(geo.blockX, geo.blockY, geo.blockW, geo.blockH);
  inner.globalAlpha = 1;
  if (s.innerImage) {
    inner.save();
    inner.globalAlpha = s.innerImageOpacity;
    inner.beginPath(); inner.rect(geo.blockX, geo.blockY, geo.blockW, geo.blockH); inner.clip();
    const block = { x: geo.blockX, y: geo.blockY, w: geo.blockW, h: geo.blockH };
    const idr = imageDrawRect(s.innerImage, block, state.innerCrop);   // cover + 缩放/平移
    inner.drawImage(s.innerImage, idr.x, idr.y, idr.w, idr.h);
    inner.restore();
  }
  deco.setTransform(1, 0, 0, 1, 0, 0);                 // 以设备像素叠入内边距层
  deco.drawImage(inner.canvas, 0, 0);
  deco.setTransform(scale, 0, 0, scale, 0, 0);          // 恢复几何坐标绘制照片
  // 各区域照片：按区域的行优先顺序重复填充，一张图铺满整个区域（区域内跨格连续）
  if (s.images.length) {
    geo.groups.forEach((g, i) => {
      const content = groupContent(geo, g);
      if (content.w <= 0 || content.h <= 0) return;   // 内边距挤没内容区
      const img = groupImage(i, g);
      deco.save();
      deco.beginPath(); deco.rect(content.x, content.y, content.w, content.h); deco.clip();
      const dr = imageDrawRect(img, content, getCrop(g.c0, g.r0));   // 每区域独立 cover + 裁剪
      deco.drawImage(img, dr.x, dr.y, dr.w, dr.h);
      deco.restore();
    });
  }
  // 各区域边框：实线，贴内边距内缘向内画（图片已内缩「粗细 + 间距」，故不会被覆盖）
  if (geo.bw > 0 && s.borderOpacity > 0) {
    deco.save();
    deco.globalAlpha = s.borderOpacity;
    deco.strokeStyle = s.borderColor;
    for (const g of geo.groups) {
      const f = groupFrame(geo, g);
      if (f.w <= 0 || f.h <= 0) continue;              // 内边距挤没整个区域
      const t = Math.min(geo.bw, f.w / 2, f.h / 2);    // 过粗时退化为实心块，不越界
      deco.lineWidth = t;
      deco.strokeRect(f.x + t / 2, f.y + t / 2, f.w - t, f.h - t);
    }
    deco.restore();
  }
  // 打孔：穿透外边距层 + 邮票层 → 透明，露出底层底色（完整镂空）
  deco.globalCompositeOperation = 'destination-out';
  deco.fillStyle = '#000';
  const radius = geo.d / 2;
  for (const c of holeCenters(geo)) {
    deco.beginPath();
    deco.arc(c.x, c.y, radius, 0, Math.PI * 2);
    deco.fill();
  }
  deco.globalCompositeOperation = 'source-over';

  // --- 合成到目标：最底层底色(@baseOpacity) + 装饰层 ---
  targetCtx.setTransform(1, 0, 0, 1, 0, 0);
  targetCtx.globalCompositeOperation = 'source-over';
  targetCtx.clearRect(0, 0, cv.width, cv.height);
  targetCtx.globalAlpha = s.baseOpacity;
  targetCtx.fillStyle = s.baseColor;
  targetCtx.fillRect(0, 0, cv.width, cv.height);
  targetCtx.globalAlpha = 1;
  targetCtx.drawImage(deco.canvas, 0, 0);
}

// 画布可视区实测尺寸（.canvas-area 由 flex 撑开，与面板宽度/抽屉高度无关）
function stageAvail() {
  return {
    w: Math.max(50, els.canvasArea.clientWidth),
    h: Math.max(50, els.canvasArea.clientHeight),
  };
}

let lastAvail = null;   // 上次渲染所用的可视区尺寸，供 ResizeObserver 去重（见 bindStageResize）

function previewScale(geo) {
  if (state.view === 'actual') return 1;     // 1:1 实际几何像素
  const { w, h } = stageAvail();
  // 适应窗口：始终缩放到可视区域内（不设下限，避免大尺寸出现滚动条），仅限制放大上限
  return Math.min(w / geo.W, h / geo.H, DPR_LIMIT);
}

function renderPreview() {
  const geo = computeGeometry(state);
  lastAvail = stageAvail();
  updateDragTargetSeg();
  renderRegionGrid(geo);
  render(ctx, previewScale(geo));
}

// 可视区尺寸变化即重渲染：涵盖窗口缩放、横竖屏切换、抽屉开合、软键盘弹出
// 去重是必需的：1:1 视图下重渲染可能引起滚动条出现/消失，进而改变 content-box 尺寸，形成回调环
function bindStageResize() {
  new ResizeObserver(() => {
    const { w, h } = stageAvail();
    if (lastAvail && lastAvail.w === w && lastAvail.h === h) return;
    renderPreview();
  }).observe(els.canvasArea);
}

/* ---------- 控件 ---------- */

const els = {
  fileInput: document.getElementById('fileInput'),
  pickBtn: document.getElementById('pickBtn'),
  clearBtn: document.getElementById('clearBtn'),
  imgInfo: document.getElementById('imgInfo'),
  holeD: document.getElementById('holeD'),
  holeG: document.getElementById('holeG'),
  nx: document.getElementById('nx'),
  ny: document.getElementById('ny'),
  matrixX: document.getElementById('matrixX'),
  matrixY: document.getElementById('matrixY'),
  spanX: document.getElementById('spanX'),
  spanY: document.getElementById('spanY'),
  applySpanBtn: document.getElementById('applySpanBtn'),
  regionGrid: document.getElementById('regionGrid'),
  mergeBigBtn: document.getElementById('mergeBigBtn'),
  mergeStripBtn: document.getElementById('mergeStripBtn'),
  splitBtn: document.getElementById('splitBtn'),
  resetRegionsBtn: document.getElementById('resetRegionsBtn'),
  regionPicks: document.getElementById('regionPicks'),
  pickStrip: document.getElementById('pickStrip'),
  resetPicksBtn: document.getElementById('resetPicksBtn'),
  baseColor: document.getElementById('baseColor'),
  baseOpacity: document.getElementById('baseOpacity'),
  baseOpacityVal: document.getElementById('baseOpacityVal'),
  outerColorOpacity: document.getElementById('outerColorOpacity'),
  outerColorOpacityVal: document.getElementById('outerColorOpacityVal'),
  outerImageOpacity: document.getElementById('outerImageOpacity'),
  outerImageOpacityVal: document.getElementById('outerImageOpacityVal'),
  outerMarginTop: document.getElementById('outerMarginTop'),
  outerMarginRight: document.getElementById('outerMarginRight'),
  outerMarginBottom: document.getElementById('outerMarginBottom'),
  outerMarginLeft: document.getElementById('outerMarginLeft'),
  outerMarginAll: document.getElementById('outerMarginAll'),
  outerMarginHint: document.getElementById('outerMarginHint'),
  innerMarginTop: document.getElementById('innerMarginTop'),
  innerMarginRight: document.getElementById('innerMarginRight'),
  innerMarginBottom: document.getElementById('innerMarginBottom'),
  innerMarginLeft: document.getElementById('innerMarginLeft'),
  innerMarginAll: document.getElementById('innerMarginAll'),
  innerMarginHint: document.getElementById('innerMarginHint'),
  borderWidth: document.getElementById('borderWidth'),
  borderGap: document.getElementById('borderGap'),
  borderColor: document.getElementById('borderColor'),
  borderOpacity: document.getElementById('borderOpacity'),
  borderOpacityVal: document.getElementById('borderOpacityVal'),
  stampTabs: document.getElementById('stampTabs'),
  tabMatrix: document.getElementById('tab-matrix'),
  tabPerf: document.getElementById('tab-perf'),
  layerTabs: document.getElementById('layerTabs'),
  tabBorder: document.getElementById('tab-border'),
  tabInner: document.getElementById('tab-inner'),
  tabOuter: document.getElementById('tab-outer'),
  tabBase: document.getElementById('tab-base'),
  outerImgBtn: document.getElementById('outerImgBtn'),
  outerImgClear: document.getElementById('outerImgClear'),
  outerImgInput: document.getElementById('outerImgInput'),
  outerImgInfo: document.getElementById('outerImgInfo'),
  innerImgBtn: document.getElementById('innerImgBtn'),
  innerImgClear: document.getElementById('innerImgClear'),
  innerImgInput: document.getElementById('innerImgInput'),
  innerImgInfo: document.getElementById('innerImgInfo'),
  innerColorOpacity: document.getElementById('innerColorOpacity'),
  innerColorOpacityVal: document.getElementById('innerColorOpacityVal'),
  innerImageOpacity: document.getElementById('innerImageOpacity'),
  innerImageOpacityVal: document.getElementById('innerImageOpacityVal'),
  exportScale: document.getElementById('exportScale'),
  exportBtn: document.getElementById('exportBtn'),
  exportSchemeBtn: document.getElementById('exportSchemeBtn'),
  importSchemeBtn: document.getElementById('importSchemeBtn'),
  resetSchemeBtn: document.getElementById('resetSchemeBtn'),
  schemeInput: document.getElementById('schemeInput'),
  schemeInfo: document.getElementById('schemeInfo'),
  viewToggle: document.getElementById('viewToggle'),
  canvasArea: document.getElementById('canvasArea'),
  drawerHandle: document.getElementById('drawerHandle'),
  dragTargetSeg: document.getElementById('dragTargetSeg'),
};

// 两组填充控件的 id 一律「前缀 + 后缀」，逐组补进 els（内/外各一套，结构完全对称）
const FILL_EL_SUFFIXES = ['Fill', 'Color', 'ColorRow', 'GradientControls', 'StopsEditor', 'AddStop',
  'AngleRow', 'Angle', 'AngleVal', 'AngleArrow', 'OriginRow', 'OriginX', 'OriginY', 'OriginXVal', 'OriginYVal'];
for (const p of FILL_GROUPS) {
  for (const suffix of FILL_EL_SUFFIXES) els[p + suffix] = document.getElementById(p + suffix);
}

// 内外边距十字盘共用一套控件逻辑；toPx 是各自的“步进 → 像素”换算
const MARGIN_PADS = [
  { sides: ['outerMarginTop', 'outerMarginRight', 'outerMarginBottom', 'outerMarginLeft'],
    all: 'outerMarginAll', hint: 'outerMarginHint',
    toPx: (v, pitch) => Math.round(state.d / 2 + v * pitch) },   // 外：半孔 + N 个 pitch
  { sides: ['innerMarginTop', 'innerMarginRight', 'innerMarginBottom', 'innerMarginLeft'],
    all: 'innerMarginAll', hint: 'innerMarginHint',
    toPx: (v, pitch) => Math.round(v * pitch) },                 // 内：N 个 pitch
];

// 某盘四向边距是否一致
function marginsUniform(pad) {
  return pad.sides.every((k) => state[k] === state[pad.sides[0]]);
}

function updateMarginHints() {
  const pitch = state.d + state.g;
  for (const pad of MARGIN_PADS) {
    const px = (k) => pad.toPx(state[k], pitch);
    const [t, r, b, l] = pad.sides;
    els[pad.hint].textContent = marginsUniform(pad)
      ? `≈ ${px(t)}px`
      : `≈ 上${px(t)} 右${px(r)} 下${px(b)} 左${px(l)}px`;
  }
}

// “全”输入框：四向一致时显示统一值，否则留空（占位提示“统一”）
function updateMarginAllField(pad) {
  els[pad.all].value = marginsUniform(pad) ? state[pad.sides[0]] : '';
}

// 把四向边距完整写回输入盘（用于载入 / 程序化变更）
function syncMarginPad(pad) {
  for (const k of pad.sides) els[k].value = state[k];
  updateMarginAllField(pad);
}

function syncMarginPads() {
  for (const pad of MARGIN_PADS) syncMarginPad(pad);
}

/* ---------- 标签页组（矩阵/齿孔、内边距/外边距/底色） ---------- */

// 每组：选中态存在哪个 state 键、页签栏元素、各页签 → 面板元素；新增一组只需在此登记
const TAB_GROUPS = [
  { key: 'stampTab', bar: 'stampTabs', fallback: 'matrix', panels: { matrix: 'tabMatrix', perf: 'tabPerf' } },
  { key: 'layerTab', bar: 'layerTabs', fallback: 'inner', panels: { border: 'tabBorder', inner: 'tabInner', outer: 'tabOuter', base: 'tabBase' } },
];

function updateTabs() {
  for (const g of TAB_GROUPS) {
    if (!g.panels[state[g.key]]) state[g.key] = g.fallback;   // 持久化/导入的非法值兜底
    for (const btn of els[g.bar].querySelectorAll('.tab-btn')) {
      btn.classList.toggle('active', btn.dataset.tab === state[g.key]);
    }
    for (const [tab, el] of Object.entries(g.panels)) els[el].hidden = tab !== state[g.key];
  }
}

function bindTabs() {
  for (const g of TAB_GROUPS) {
    els[g.bar].addEventListener('click', (e) => {
      const btn = e.target.closest('.tab-btn');
      if (!btn) return;
      state[g.key] = btn.dataset.tab;
      updateTabs();
      saveOptions();
    });
  }
}

/* ---------- 拖拽/缩放目标切换器 ---------- */

// 各目标是否可用（对应图片存在才可锁定）；'auto' 恒可用
const DRAG_TARGET_READY = {
  auto: () => true,
  photo: () => state.images.length > 0,
  inner: () => !!state.innerImage,
  outer: () => !!state.outerImage,
};

let dragSegSig = null;   // 上次写入 DOM 的状态签名，避免逐帧重复写（renderPreview 每帧都会调用）

function updateDragTargetSeg() {
  if (!DRAG_TARGET_READY[state.dragTarget]) state.dragTarget = 'auto';   // 持久化/导入的非法值兜底
  const sig = [state.dragTarget, state.images.length > 0, !!state.innerImage, !!state.outerImage].join('|');
  if (sig === dragSegSig) return;
  dragSegSig = sig;
  for (const btn of els.dragTargetSeg.querySelectorAll('.seg-btn')) {
    const t = btn.dataset.target;
    btn.classList.toggle('active', t === state.dragTarget);
    btn.disabled = !DRAG_TARGET_READY[t]();
  }
}

function bindDragTargetSeg() {
  els.dragTargetSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn || btn.disabled) return;
    state.dragTarget = btn.dataset.target;
    updateDragTargetSeg();
    saveOptions();
  });
}

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

// 重建跨格区域网格：一区域一格子，用 grid-column/row 的 span 拼出不规则版式。
// 每次 renderPreview 都会调用，故用签名串去重，避免每个拖拽帧都重建 DOM。
let lastRegionSig = '';
let selection = null;   // 当前拖选范围 {c0,r0,cw,ch} | null，仅供编辑交互使用，不持久化

// 选区覆盖的各区域的用图指定值；顺序与 regionsWithin 一致
function coveredPickKeys(geo) {
  if (!selection) return [];
  return regionsWithin(geo.groups, selection).map((g) => g.c0 + ',' + g.r0);
}

const THUMB_PX = 88;     // 缩略图位图边长（40 CSS px 的 2 倍，兼顾高 DPR 清晰度）
let lastPickImgs = [];   // 已建缩略图对应的 Image 列表，用于跳过无谓的重绘

// 把 img 以 cover 方式画进一个方形缩略图 canvas。
// 不能复用 Image 的 src 做 <img> —— blobToImage/loadPhotos 解码后立即 revoke 了 blob URL，
// 那个地址已经取不到数据；但 Image 本身仍可绘制，所以直接画进 canvas。
function makeThumb(img) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = THUMB_PX;
  const c = cv.getContext('2d');
  c.imageSmoothingQuality = 'high';
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  c.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side,
    0, 0, THUMB_PX, THUMB_PX);
  return cv;
}

// 用图选择条：一张图一个缩略图按钮，点击把选区内每个区域都指定为该图。
// 取消指定只有「重置顺序」一个全局入口（清空 state.picks），没有逐区域的「自动」档 ——
// 于是「全部未指定」不再是一个需要高亮的档位，高亮判断塌缩成一次数值比较。
function renderPickStrip(geo) {
  const imgs = state.images;
  els.regionPicks.hidden = imgs.length === 0;   // 有无照片是一次性模式切换，可以用 [hidden] 退出布局
  if (!imgs.length) return;
  const strip = els.pickStrip;

  const same = imgs.length === lastPickImgs.length && imgs.every((im, k) => im === lastPickImgs[k]);
  if (!same) {
    lastPickImgs = imgs.slice();
    strip.textContent = '';
    imgs.forEach((im, idx) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pick-thumb';
      b.dataset.pick = String(idx);
      b.title = '第 ' + (idx + 1) + ' 张';
      b.appendChild(makeThumb(im));
      strip.appendChild(b);
    });
  }

  // 选区内各区域的指定值全都相同才高亮对应缩略图；混选、空选区、全部未指定都不高亮
  const picked = coveredPickKeys(geo).map((k) => state.picks[k]);
  const uniform = picked.length && picked.every((v) => v === picked[0]) ? picked[0] : null;
  for (const b of strip.children) {
    b.disabled = picked.length === 0;
    b.classList.toggle('active', uniform === Number(b.dataset.pick));
  }
  // 只在确有生效中的指定时可点：损坏/越界的残留记录不该让按钮看起来有事可做
  els.resetPicksBtn.disabled = !geo.groups.some((g) => validPick(g.c0, g.r0) !== null);
}

function renderRegionGrid(geo) {
  // 矩阵变小（或选区来自变动前的手势）可能让旧选区越界：整体丢弃而不是截断，
  // 因为截断会切开一个完整区域，破坏 expandSelection 保证的「整区域覆盖」不变式。
  if (selection && (selection.c0 < 0 || selection.r0 < 0 ||
      selection.c0 + selection.cw > geo.X || selection.r0 + selection.ch > geo.Y)) {
    selection = null;
  }
  // 区域列表可能被网格拖选之外的操作改变（均匀分块、导入方案…），重新扩张保持
  // 「选区始终整块覆盖区域」不变式；已稳定的选区扩张后值不变，不会打乱下面的签名去重
  if (selection) selection = expandSelection(geo, selection);
  const selSig = selection ? [selection.c0, selection.r0, selection.cw, selection.ch].join(',') : '-';
  const hasImgs = state.images.length > 0;
  // 每格显示的编号 = 该区域最终使用的照片序号；无照片时退回填充顺序（此时两者本就一致）
  const label = (g, i) => (hasImgs ? groupImageIndex(i, g) : i) + 1;
  const sig = geo.X + 'x' + geo.Y + '|' + geo.Sw.toFixed(3) + 'x' + geo.Sh.toFixed(3) + '|' + selSig + '|' +
    geo.groups.map((g, i) => [g.c0, g.r0, g.cw, g.ch, g.big ? 1 : 0, label(g, i)].join(',')).join(';');

  const grid = els.regionGrid;
  // 网格内容（数字标签）会让 width:auto 撑成内容自身的宽度而不是填满容器，
  // 于是改为显式换算 max-width：按视口高度算出与 CSS max-height:40dvh 相同的像素上限，
  // 乘以宽高比得到宽度上限，宽高一起收缩、比例不失真。视口尺寸不进签名，每次都要重算。
  const ratio = (geo.X * geo.Sw) / (geo.Y * geo.Sh);
  grid.style.maxWidth = (window.innerHeight * 0.4 * ratio) + 'px';
  // 选择条的缩略图依赖 state.images，而图片本体不进签名（换一批张数相同的图时签名可能
  // 不变），所以和 maxWidth 一样放在提前返回之前；它自己按 Image 对象身份去重重建。
  renderPickStrip(geo);
  if (sig === lastRegionSig) return;
  lastRegionSig = sig;

  grid.style.gridTemplateColumns = 'repeat(' + geo.X + ', 1fr)';
  grid.style.gridTemplateRows = 'repeat(' + geo.Y + ', 1fr)';
  grid.style.aspectRatio = (geo.X * geo.Sw) + ' / ' + (geo.Y * geo.Sh);
  grid.textContent = '';
  geo.groups.forEach((g, i) => {
    const cell = document.createElement('div');
    cell.className = 'region-cell' +
      (g.cw * g.ch > 1 ? ' merged' : '') + (g.big ? ' big' : '');
    cell.style.gridColumn = (g.c0 + 1) + ' / span ' + g.cw;
    cell.style.gridRow = (g.r0 + 1) + ' / span ' + g.ch;
    // 连票区域内部分隔虚线的周期（见 index.css 的 .region-cell.merged:not(.big)::before）
    cell.style.setProperty('--cw', String(g.cw));
    cell.style.setProperty('--ch', String(g.ch));
    cell.dataset.gi = String(i);
    cell.textContent = String(label(g, i));
    if (selection && g.c0 >= selection.c0 && g.c0 + g.cw <= selection.c0 + selection.cw &&
        g.r0 >= selection.r0 && g.r0 + g.ch <= selection.r0 + selection.ch) {
      cell.classList.add('selected');
    }
    grid.appendChild(cell);
  });

  // 按选区更新按钮可用状态。合并大票/合并连票对「已是单个跨格区域」的选区同样可用 ——
  // 同边界重新合并即切换该区域的档位，不再需要单独的大票/连票开关。
  const covered = selection ? regionsWithin(geo.groups, selection) : [];
  const soleMerged = covered.length === 1 && covered[0].cw * covered[0].ch > 1;
  const canMerge = !!selection && selection.cw * selection.ch > 1;
  els.mergeBigBtn.disabled = !canMerge;
  els.mergeStripBtn.disabled = !canMerge;
  els.splitBtn.disabled = !soleMerged;
}

// 跨格区域网格的编辑交互：拖选 → 合并成大票 / 合并成连票 / 拆分。
// 用 pointer 事件（非 mouse）以便触摸端可用；网格的 touch-action:none 由 CSS 提供。
function bindRegionGrid() {
  const grid = els.regionGrid;
  let anchor = null;   // 拖选起点格 {c, r}

  // 由指针位置反推格坐标：网格是 X 列 Y 行的等分 CSS Grid。只要矩阵尺寸，不要几何。
  const cellAt = (e, X, Y) => {
    const rect = grid.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      c: clamp(Math.floor((e.clientX - rect.left) / rect.width * X), 0, X - 1),
      r: clamp(Math.floor((e.clientY - rect.top) / rect.height * Y), 0, Y - 1),
    };
  };

  const setSelection = (geo, from, to) => {
    selection = expandSelection(geo, {
      c0: Math.min(from.c, to.c), r0: Math.min(from.r, to.r),
      cw: Math.abs(from.c - to.c) + 1, ch: Math.abs(from.r - to.r) + 1,
    });
    renderRegionGrid(geo);
  };

  // 两个处理器各自只算一次几何往下传：computeGeometry 是 O(X*Y)（computeGroups +
  // cellGroupIndex），拖选时每个 pointermove 都会跑，没必要重复。
  grid.addEventListener('pointerdown', (e) => {
    const geo = computeGeometry(state);
    const cell = cellAt(e, geo.X, geo.Y);
    if (!cell) return;
    anchor = cell;
    grid.setPointerCapture(e.pointerId);
    setSelection(geo, anchor, anchor);
  });
  grid.addEventListener('pointermove', (e) => {
    if (!anchor) return;
    const geo = computeGeometry(state);
    const cell = cellAt(e, geo.X, geo.Y);
    if (cell) setSelection(geo, anchor, cell);
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

  // 按选区建一个跨格区域，档位由按钮直接给出（不再有继承/默认推断）。选区本来就是
  // 单个跨格区域时，等价于原地切换它的大票/连票。
  const mergeSelection = (big) => {
    if (!selection) return;
    const s = selection;
    // 丢弃所有与选区相交的旧合并，而不仅是被完全覆盖的 —— computeGroups 对越界/
    // 冲突的合并会整条跳过（见 computeGroups），跳过的合并不出现在 geo.groups 里，
    // 但仍留在 state.merges 中，只做「完全覆盖」判断会漏掉这类不可见的合并；
    // 它们会在之后与新合并相交时抢先命中，把用户刚建的合并悄悄吞掉。损坏项（外部数据
    // 可能含 null）由 mergeIntersectsRect 自己判断并返回 false，这里不用再判断一遍。
    state.merges = state.merges.filter((m) => !mergeIntersectsRect(m, s));
    state.merges.push({ c: s.c0, r: s.r0, w: s.cw, h: s.ch, big });
    applyRegions();
  };
  els.mergeBigBtn.addEventListener('click', () => mergeSelection(true));
  els.mergeStripBtn.addEventListener('click', () => mergeSelection(false));

  els.splitBtn.addEventListener('click', () => {
    if (!selection) return;
    const s = selection;
    state.merges = state.merges.filter((m) => !mergeOriginMatches(m, s.c0, s.r0));
    applyRegions();
  });

  els.resetRegionsBtn.addEventListener('click', () => {
    state.merges = [];
    selection = null;
    applyRegions();
  });

  els.pickStrip.addEventListener('click', (e) => {
    const btn = e.target.closest('.pick-thumb');
    if (!btn || btn.disabled) return;
    const keys = coveredPickKeys(computeGeometry(state));
    if (!keys.length) return;
    for (const k of keys) state.picks[k] = Number(btn.dataset.pick);
    applyRegions();   // 换图后原裁剪未必还能铺满，交给 clampAllCrops 重新钳制
  });

  els.resetPicksBtn.addEventListener('click', () => {
    state.picks = {};   // 全部回到按区域顺序循环填充
    applyRegions();
  });
}

/* ---------- 底部抽屉（窄屏） ---------- */

// 抽屉开合改变 .panel 高度 → .canvas-area 尺寸变化 → ResizeObserver 自动重渲染
function bindDrawer() {
  els.drawerHandle.addEventListener('click', () => {
    const open = document.body.classList.toggle('drawer-open');
    els.drawerHandle.setAttribute('aria-expanded', String(open));
  });
}

function syncInputsFromState() {
  els.holeD.value = state.d;
  els.holeG.value = state.g;
  els.nx.value = state.nx;
  els.ny.value = state.ny;
  els.matrixX.value = state.matrixX;
  els.matrixY.value = state.matrixY;
  els.spanX.value = state.spanX;
  els.spanY.value = state.spanY;
  els.baseColor.value = state.baseColor;
  els.baseOpacity.value = state.baseOpacity;
  els.baseOpacityVal.textContent = Number(state.baseOpacity).toFixed(2);
  els.outerColorOpacity.value = state.outerColorOpacity;
  els.outerColorOpacityVal.textContent = Number(state.outerColorOpacity).toFixed(2);
  els.outerImageOpacity.value = state.outerImageOpacity;
  els.outerImageOpacityVal.textContent = Number(state.outerImageOpacity).toFixed(2);
  syncMarginPads();
  updateMarginHints();
  els.borderWidth.value = state.borderWidth;
  els.borderGap.value = state.borderGap;
  els.borderColor.value = state.borderColor;
  els.borderOpacity.value = state.borderOpacity;
  els.borderOpacityVal.textContent = Number(state.borderOpacity).toFixed(2);
  els.innerColorOpacity.value = state.innerColorOpacity;
  els.innerColorOpacityVal.textContent = Number(state.innerColorOpacity).toFixed(2);
  els.innerImageOpacity.value = state.innerImageOpacity;
  els.innerImageOpacityVal.textContent = Number(state.innerImageOpacity).toFixed(2);
  for (const p of FILL_GROUPS) syncFillGroup(p);
  els.exportScale.value = String(state.exportScale);
  els.viewToggle.textContent = state.view === 'fit' ? '1:1 视图' : '适应窗口';
  els.viewToggle.classList.toggle('active', state.view === 'actual');
  updateTabs();
  updateDragTargetSeg();
}

/* ---------- 填充控件（内/外边距共用） ---------- */

function syncFillGroup(p) {
  els[p + 'Fill'].value = state[p + 'Fill'];
  els[p + 'Color'].value = state[p + 'Color'];
  els[p + 'Angle'].value = state[p + 'Angle'];
  syncAngleReadout(p);
  els[p + 'OriginX'].value = state[p + 'OriginX'];
  els[p + 'OriginY'].value = state[p + 'OriginY'];
  els[p + 'OriginXVal'].textContent = Number(state[p + 'OriginX']).toFixed(2);
  els[p + 'OriginYVal'].textContent = Number(state[p + 'OriginY']).toFixed(2);
  renderStopsEditor(p);
  updateFillControlsVisibility(p);
}

// 角度读数 + 指示箭头：↓ 字形本身指向 90°（画布向下），故旋转 角度 − 90° 即渐变推进方向
function syncAngleReadout(p) {
  const deg = state[p + 'Angle'];
  els[p + 'AngleVal'].textContent = `${deg}°`;
  els[p + 'AngleArrow'].style.transform = `rotate(${deg - 90}deg)`;
}

function updateFillControlsVisibility(p) {
  const mode = state[p + 'Fill'];
  els[p + 'ColorRow'].hidden = mode !== 'solid';
  els[p + 'GradientControls'].hidden = mode === 'solid';
  els[p + 'AngleRow'].hidden = mode !== 'linear';    // 角度仅线性渐变有意义
  els[p + 'OriginRow'].hidden = mode !== 'radial';   // 原点仅径向渐变有意义
}

function renderStopsEditor(p) {
  const editor = els[p + 'StopsEditor'];
  const stops = state[p + 'Stops'];
  editor.textContent = '';
  stops.forEach((stop, i) => {
    const row = document.createElement('div');
    row.className = 'stop-row';

    const color = document.createElement('input');
    color.type = 'color';
    color.value = stop.color;
    color.addEventListener('input', () => {
      stops[i].color = color.value;
      renderPreview();
      saveOptions();
    });

    const pos = document.createElement('input');
    pos.type = 'range';
    pos.min = '0';
    pos.max = '100';
    pos.step = '1';
    pos.value = String(Math.round(stop.pos * 100));
    pos.addEventListener('input', () => {
      stops[i].pos = parseInt(pos.value, 10) / 100;
      renderPreview();
      saveOptions();
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'stop-del';
    del.textContent = '✕';
    del.disabled = stops.length <= 1;   // 至少保留 1 档
    del.addEventListener('click', () => {
      if (stops.length <= 1) return;
      stops.splice(i, 1);
      renderStopsEditor(p);
      renderPreview();
      saveOptions();
    });

    row.append(color, pos, del);
    editor.appendChild(row);
  });
}

function bindFillGroup(p) {
  const apply = () => { renderPreview(); saveOptions(); };
  els[p + 'Fill'].addEventListener('change', () => {
    state[p + 'Fill'] = els[p + 'Fill'].value;
    updateFillControlsVisibility(p);
    apply();
  });
  els[p + 'Color'].addEventListener('input', () => { state[p + 'Color'] = els[p + 'Color'].value; apply(); });
  els[p + 'AddStop'].addEventListener('click', () => {
    const stops = state[p + 'Stops'];
    const last = stops[stops.length - 1];
    stops.push({ pos: 1, color: last ? last.color : '#ffffff' });
    renderStopsEditor(p);
    apply();
  });
  els[p + 'Angle'].addEventListener('input', () => {
    state[p + 'Angle'] = parseInt(els[p + 'Angle'].value, 10);
    syncAngleReadout(p);
    apply();
  });
  for (const axis of ['OriginX', 'OriginY']) {
    els[p + axis].addEventListener('input', () => {
      state[p + axis] = parseFloat(els[p + axis].value);
      els[p + axis + 'Val'].textContent = state[p + axis].toFixed(2);
      apply();
    });
  }
}

/* ---------- 图片持久化（IndexedDB） ---------- */
// 图片原始 Blob（用户选的 File 本身即 Blob）存 IndexedDB；裁剪元数据随 localStorage 落盘。
// 所有操作失败一律静默 resolve（不抛错），IDB 不可用时整体降级为“不持久化”，行为同旧版。

const IDB_NAME = 'stampit';
const IDB_STORE = 'images';
let idbPromise = null;   // 记忆化连接

function idbOpen() {
  if (idbPromise) return idbPromise;
  idbPromise = new Promise((resolve) => {
    try {
      if (!window.indexedDB) { resolve(null); return; }
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch (_) { resolve(null); }
  });
  return idbPromise;
}

function idbPut(key, value) {
  return idbOpen().then((db) => new Promise((resolve) => {
    if (!db) { resolve(); return; }
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch (_) { resolve(); }
  }));
}

function idbGet(key) {
  return idbOpen().then((db) => new Promise((resolve) => {
    if (!db) { resolve(null); return; }
    try {
      const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result == null ? null : req.result);
      req.onerror = () => resolve(null);
    } catch (_) { resolve(null); }
  }));
}

function idbDelete(key) {
  return idbOpen().then((db) => new Promise((resolve) => {
    if (!db) { resolve(); return; }
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch (_) { resolve(); }
  }));
}

// Blob → 解码后的 Image（失败 resolve(null)）；解码后即释放 object URL
function blobToImage(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

// 启动后异步从 IndexedDB 还原图片；裁剪状态已由 loadOptions() 同步还原，故此处不重置任何 crop
async function restoreImages() {
  try {
    const [grid, outer, inner] = await Promise.all([idbGet('grid'), idbGet('outer'), idbGet('inner')]);

    if (grid && Array.isArray(grid.items) && grid.items.length) {
      // 解码失败的条目整对丢弃，保证 images 与 imageMeta 同序等长
      const ok = (await Promise.all(grid.items.map(async (it) => ({ it, img: await blobToImage(it.blob) }))))
        .filter((p) => p.img);
      if (ok.length) {
        state.images = ok.map((p) => p.img);
        state.imageMeta = ok.map((p) => ({ blob: p.it.blob, name: p.it.name, key: itemKey(p.it) }));
        updateImgInfo();
      }
    }
    if (outer && outer.blob) {
      const img = await blobToImage(outer.blob);
      if (img) { state.outerImage = img; els.outerImgInfo.textContent = outer.name; }
    }
    if (inner && inner.blob) {
      const img = await blobToImage(inner.blob);
      if (img) { state.innerImage = img; els.innerImgInfo.textContent = inner.name; }
    }

    clampAllCrops();
    renderPreview();
  } catch (_) { /* 还原失败：保持无图默认态 */ }
}

/* ---------- 选项持久化（localStorage） ---------- */

function saveOptions() {
  try {
    for (const k of PERSISTED) {
      localStorage.setItem(STORAGE_PREFIX + k, JSON.stringify(state[k]));
    }
  } catch (_) { /* 隐私模式 / 配额异常时静默跳过 */ }
}

function loadOptions() {
  try {
    for (const k of PERSISTED) {
      const raw = localStorage.getItem(STORAGE_PREFIX + k);
      if (raw === null) continue;
      const v = JSON.parse(raw);
      if (v !== null && v !== undefined) state[k] = v;
    }
  } catch (_) { /* 读取失败时使用默认值 */ }
}

// 图片去重标识：同名 + 同大小 + 同修改时间即视为同一张（只看 File 元数据，不读内容）。
// 导入方案 / 早于本改动的持久化记录没有 lastModified，退化成 名字+大小。
function photoKey(name, size, lastModified) {
  return name + '|' + size + '|' + (lastModified || 0);
}
const fileItem = (f) => ({ blob: f, name: f.name, key: photoKey(f.name, f.size, f.lastModified) });
const itemKey = (it) => it.key || photoKey(it.name, it.blob.size, it.blob.lastModified);

// 图片信息栏：只报张数（单张也不显示文件名），附带本次跳过的重复张数
function updateImgInfo(skipped = 0) {
  const n = state.images.length;
  els.imgInfo.textContent = (n ? `${n} 张图片` : '未选择图片') +
    (skipped ? `（跳过 ${skipped} 张重复）` : '');
}

// 多图载入（多选 / 多文件拖放）：追加到已有图片之后，已在列表里的文件自动跳过。
// 下标只增不改，所以 crops/picks 全部保留（换掉整批图才需要重置，那是 clearImage 的事）。
function loadPhotos(fileList) {
  const incoming = Array.from(fileList || []).filter((f) => f.type.startsWith('image/'));
  const seen = new Set(state.imageMeta.map((it) => it.key));
  const files = incoming.filter((f) => {
    const key = photoKey(f.name, f.size, f.lastModified);
    if (seen.has(key)) return false;
    seen.add(key);   // 同一批里的重复也只留第一张
    return true;
  });
  const skipped = incoming.length - files.length;
  if (!files.length) { updateImgInfo(skipped); return; }

  els.imgInfo.textContent = '加载中…';
  Promise.all(files.map((f) => new Promise((res) => {
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(img.src); res({ img, file: f }); };
    img.onerror = () => { URL.revokeObjectURL(img.src); res({ img: null, file: f }); };
    img.src = URL.createObjectURL(f);
  }))).then((pairs) => {
    const ok = pairs.filter((p) => p.img);   // 保留 文件↔图片 对齐，仅成功项
    if (!ok.length) { els.imgInfo.textContent = '图片加载失败'; return; }
    state.images = state.images.concat(ok.map((p) => p.img));
    state.imageMeta = state.imageMeta.concat(ok.map((p) => fileItem(p.file)));
    updateImgInfo(skipped);
    idbPut('grid', { items: state.imageMeta });   // 持久化原始 Blob（整表写回）
    clampAllCrops();    // 张数变了 → i % len 变了，部分区域换了图，裁剪要重新钳制
    saveOptions();
    renderPreview();
  });
}

function clearImage() {
  state.images = [];
  state.imageMeta = [];
  state.crops = {};
  state.picks = {};
  els.fileInput.value = '';                       // 允许重新选择同一文件
  updateImgInfo();
  idbDelete('grid');
  saveOptions();                                  // 持久化清空后的 crops
  renderPreview();
}

// 通用背景图选择器（内/外边距），载入 Image 到 state[key]，不影响齿孔计算
function bindBgImagePicker(pickBtn, clearBtn, fileInput, infoEl, key) {
  const idbKey = key === 'outerImage' ? 'outer' : 'inner';
  pickBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file || !file.type.startsWith('image/')) return;
    const img = new Image();
    img.onload = () => {
      state[key] = img;
      if (key === 'outerImage') state.outerCrop = { scale: 1, offsetX: 0, offsetY: 0 };
      if (key === 'innerImage') state.innerCrop = { scale: 1, offsetX: 0, offsetY: 0 };
      infoEl.textContent = file.name;
      idbPut(idbKey, { blob: file, name: file.name });   // 持久化原始 Blob
      saveOptions();                                     // 持久化已重置的 crop
      renderPreview();
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => { infoEl.textContent = '加载失败'; };
    img.src = URL.createObjectURL(file);
  });
  clearBtn.addEventListener('click', () => {
    state[key] = null;
    if (key === 'outerImage') state.outerCrop = { scale: 1, offsetX: 0, offsetY: 0 };
    if (key === 'innerImage') state.innerCrop = { scale: 1, offsetX: 0, offsetY: 0 };
    fileInput.value = '';
    infoEl.textContent = '无';
    idbDelete(idbKey);
    saveOptions();
    renderPreview();
  });
}

// 内外边距十字输入盘：改“全”同步四向；单独改某向后，四向一致则“全”回填该值，否则留空
function bindMarginPads() {
  const afterChange = () => {
    clampAllCrops();
    updateMarginHints();
    renderPreview();
    saveOptions();
  };
  for (const pad of MARGIN_PADS) {
    // 单独改某一向：不回填正在输入的格，只刷新“全”框（空 / 统一值）
    for (const key of pad.sides) {
      els[key].addEventListener('input', () => {
        const v = parseFloat(els[key].value);
        if (Number.isNaN(v)) return;
        state[key] = Math.max(0, v);
        updateMarginAllField(pad);
        afterChange();
      });
    }
    // 改“全”：同步四向并回填四个格
    els[pad.all].addEventListener('input', () => {
      const v = parseFloat(els[pad.all].value);
      if (Number.isNaN(v)) return;
      const m = Math.max(0, v);
      for (const k of pad.sides) state[k] = m;
      syncMarginPad(pad);
      afterChange();
    });
  }
}

function bindControls() {
  els.pickBtn.addEventListener('click', () => els.fileInput.click());
  els.clearBtn.addEventListener('click', clearImage);
  els.fileInput.addEventListener('change', (e) => {
    loadPhotos(e.target.files);
    e.target.value = '';   // 允许再次选择同一文件（清空后重新加入）
  });
  bindBgImagePicker(els.outerImgBtn, els.outerImgClear, els.outerImgInput, els.outerImgInfo, 'outerImage');
  bindBgImagePicker(els.innerImgBtn, els.innerImgClear, els.innerImgInput, els.innerImgInfo, 'innerImage');

  const numField = (el, key, lo) => {
    el.addEventListener('input', () => {
      const v = parseFloat(el.value);
      if (Number.isNaN(v)) return;
      state[key] = Math.max(lo, v);
      clampAllCrops();
      updateMarginHints();
      renderPreview();
      saveOptions();
    });
  };
  numField(els.holeD, 'd', 1);
  numField(els.holeG, 'g', 0);
  numField(els.nx, 'nx', MIN_PERF);
  numField(els.ny, 'ny', MIN_PERF);
  numField(els.matrixX, 'matrixX', 1);
  numField(els.matrixY, 'matrixY', 1);
  numField(els.spanX, 'spanX', 1);
  numField(els.spanY, 'spanY', 1);
  els.applySpanBtn.addEventListener('click', () => {
    const X = Math.max(1, Math.round(state.matrixX));
    const Y = Math.max(1, Math.round(state.matrixY));
    state.merges = uniformMerges(X, Y, state.spanX, state.spanY);
    clampAllCrops();
    renderPreview();
    saveOptions();
  });
  numField(els.borderWidth, 'borderWidth', 0);   // 边框粗细/间距挤压图片内容区 → 需重新钳制裁剪
  numField(els.borderGap, 'borderGap', 0);
  bindMarginPads();
  bindTabs();

  els.baseColor.addEventListener('input', () => { state.baseColor = els.baseColor.value; renderPreview(); saveOptions(); });
  els.baseOpacity.addEventListener('input', () => {
    state.baseOpacity = parseFloat(els.baseOpacity.value);
    els.baseOpacityVal.textContent = state.baseOpacity.toFixed(2);
    renderPreview();
    saveOptions();
  });
  els.borderColor.addEventListener('input', () => { state.borderColor = els.borderColor.value; renderPreview(); saveOptions(); });
  els.borderOpacity.addEventListener('input', () => {
    state.borderOpacity = parseFloat(els.borderOpacity.value);
    els.borderOpacityVal.textContent = state.borderOpacity.toFixed(2);
    renderPreview();
    saveOptions();
  });
  for (const p of FILL_GROUPS) bindFillGroup(p);

  els.innerColorOpacity.addEventListener('input', () => {
    state.innerColorOpacity = parseFloat(els.innerColorOpacity.value);
    els.innerColorOpacityVal.textContent = state.innerColorOpacity.toFixed(2);
    renderPreview();
    saveOptions();
  });
  els.innerImageOpacity.addEventListener('input', () => {
    state.innerImageOpacity = parseFloat(els.innerImageOpacity.value);
    els.innerImageOpacityVal.textContent = state.innerImageOpacity.toFixed(2);
    renderPreview();
    saveOptions();
  });

  els.outerColorOpacity.addEventListener('input', () => {
    state.outerColorOpacity = parseFloat(els.outerColorOpacity.value);
    els.outerColorOpacityVal.textContent = state.outerColorOpacity.toFixed(2);
    renderPreview();
    saveOptions();
  });
  els.outerImageOpacity.addEventListener('input', () => {
    state.outerImageOpacity = parseFloat(els.outerImageOpacity.value);
    els.outerImageOpacityVal.textContent = state.outerImageOpacity.toFixed(2);
    renderPreview();
    saveOptions();
  });
  els.exportScale.addEventListener('change', () => { state.exportScale = parseFloat(els.exportScale.value); saveOptions(); });
  els.exportBtn.addEventListener('click', exportPng);
  els.exportSchemeBtn.addEventListener('click', exportScheme);
  els.importSchemeBtn.addEventListener('click', () => els.schemeInput.click());
  els.resetSchemeBtn.addEventListener('click', resetScheme);
  els.schemeInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) importScheme(file);
    els.schemeInput.value = '';   // 允许重复导入同一文件
  });

  els.viewToggle.addEventListener('click', () => {
    state.view = state.view === 'fit' ? 'actual' : 'fit';
    els.viewToggle.textContent = state.view === 'fit' ? '1:1 视图' : '适应窗口';
    els.viewToggle.classList.toggle('active', state.view === 'actual');
    renderPreview();
    saveOptions();
  });
}

/* ---------- 画布交互：拖拽 + 光标锚点缩放 ---------- */

function clientToGeo(clientX, clientY, geo) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left) / rect.width * geo.W,
    y: (clientY - rect.top) / rect.height * geo.H,
  };
}

function eventToGeo(e, geo) {
  return clientToGeo(e.clientX, e.clientY, geo);
}

// 由几何坐标定位所在跨格区域的下标（O(1) 查表）
function groupAt(geo, gx, gy) {
  const c = clamp(Math.floor((gx - geo.mL) / geo.Sw), 0, geo.X - 1);
  const r = clamp(Math.floor((gy - geo.mT) / geo.Sh), 0, geo.Y - 1);
  return geo.cellGroup[r * geo.X + c];
}

// 目标记的是区域的起始格坐标 {c0, r0}，不是数组下标 —— 下标在区域列表增减、
// 重排序后会失效或指向别的区域，起始格坐标是区域的稳定身份（同时也是裁剪的存储键）
function groupTarget(geo, gx, gy) {
  const g = geo.groups[groupAt(geo, gx, gy)];
  return { type: 'group', c0: g.c0, r0: g.r0 };
}

// 命中目标：块外→外图；块内按 Alt / 是否有照片 → 内图或某区域；否则 null（不响应）
// wantInner（按住 Alt）在块内优先指向内背景图，便于在照片之上调整内图
// state.dragTarget 非 'auto' 时强制锁定该对象（触摸设备无 Alt 键的替代入口）；
// 锁定对象的图片不存在时退回 'auto'，避免手势彻底失灵（图片回来后锁定自动生效）
function hitTarget(geo, gx, gy, wantInner) {
  const ready = DRAG_TARGET_READY[state.dragTarget];              // 非法值（导入的旧方案）当 'auto'
  const forced = ready && ready() ? state.dragTarget : 'auto';
  if (forced === 'outer') return { type: 'outer' };

  const inBlock = gx >= geo.blockX && gx <= geo.blockX + geo.blockW &&
                  gy >= geo.blockY && gy <= geo.blockY + geo.blockH;
  if (!inBlock) return state.outerImage ? { type: 'outer' } : null;
  if (forced === 'inner') return { type: 'inner' };
  if (forced === 'photo') return groupTarget(geo, gx, gy);

  if (wantInner && state.innerImage) return { type: 'inner' };
  if (state.images.length) return groupTarget(geo, gx, gy);
  return state.innerImage ? { type: 'inner' } : null;   // 无照片时块内直接调内图
}

// 目标 → {crop, img, content, doClamp}：统一 group / outer / inner 三种拖拽缩放对象
function cropContext(geo, t) {
  if (t.type === 'outer') {
    return {
      crop: state.outerCrop,
      img: state.outerImage,
      content: { x: 0, y: 0, w: geo.W, h: geo.H },
      doClamp: clampOuterCrop,
    };
  }
  if (t.type === 'inner') {
    return {
      crop: state.innerCrop,
      img: state.innerImage,
      content: { x: geo.blockX, y: geo.blockY, w: geo.blockW, h: geo.blockH },
      doClamp: clampInnerCrop,
    };
  }
  // 按起始格坐标重新查找区域，而非沿用手势开始时（pointerdown）捕获的下标：
  // geo 每帧重新计算，区域列表可能在手势途中收缩（合并吞并了目标）或增长
  // （拆分/拆分全部），两种情况下数组下标都可能失效或悄悄指向别的区域 ——
  // 起始格坐标是区域的稳定身份，找不到就说明该区域确实已不存在。
  const gi = geo.groups.findIndex((cand) => cand.c0 === t.c0 && cand.r0 === t.r0);
  const g = geo.groups[gi];
  if (!g) {
    // 目标区域已不存在（如被合并吞并）：退化为惰性空操作而不是抛错或误改到别的区域。
    // img 为 null 让 zoomAt 直接短路，pan 分支写入的是一次性对象、不影响 state，
    // 手势在下一次 pointerup 自然结束。
    return { crop: { offsetX: 0, offsetY: 0, scale: 1 }, img: null, content: { x: 0, y: 0, w: 0, h: 0 }, doClamp: () => {} };
  }
  return {
    crop: groupCrop(g.c0, g.r0),
    img: groupImage(gi, g),
    content: groupContent(geo, g),
    doClamp: () => clampCropGroup(geo, g, gi),
  };
}

// 以 anchor（几何坐标）为锚点把目标缩放 factor 倍，使锚点下的像素保持不动
// 返回是否真的变化（已到 1–5 倍钳位边界则不变，调用方据此跳过重渲染）
// 滚轮与双指捏合共用：前者 factor 是固定步进，后者是双指距离比值
function zoomAt(geo, t, factor, anchor) {
  const { crop, img, content, doClamp } = cropContext(geo, t);
  if (!img) return false;
  const newScale = clamp(crop.scale * factor, 1, 5);
  if (newScale === crop.scale) return false;

  const base = coverScale(img, content.w, content.h);
  const before = imageDrawRect(img, content, crop);
  const effOld = base * crop.scale;
  const imgX = (anchor.x - before.x) / effOld;     // 锚点处对应的图片自身坐标
  const imgY = (anchor.y - before.y) / effOld;

  crop.scale = newScale;
  const effNew = base * newScale;
  // 反推 offset，使锚点下像素保持不动
  const w = img.naturalWidth * effNew;
  const h = img.naturalHeight * effNew;
  crop.offsetX = (anchor.x + w / 2 - imgX * effNew) - (content.x + content.w / 2);
  crop.offsetY = (anchor.y + h / 2 - imgY * effNew) - (content.y + content.h / 2);

  doClamp();
  return true;
}

function bindCanvasInteractions() {
  const pointers = new Map();   // pointerId → {x, y}（clientX/Y）：1 指平移，2 指捏合缩放
  let target = null;            // 当前手势作用对象（区域 / 外图 / 内图）
  let last = null;              // 上一次单指位置，null = 当前不平移
  let pinchDist = 0;            // 上一次双指距离，0 = 未在捏合

  const twoPointers = () => {
    const [a, b] = [...pointers.values()];
    return { a, b };
  };
  const pinchMid = () => {
    const { a, b } = twoPointers();
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };
  const pinchSpan = () => {
    const { a, b } = twoPointers();
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  canvas.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const geo = computeGeometry(state);

    if (pointers.size === 1) {
      const cur = eventToGeo(e, geo);
      target = hitTarget(geo, cur.x, cur.y, e.altKey);
      last = target ? { x: e.clientX, y: e.clientY } : null;
      if (target) canvas.setPointerCapture(e.pointerId);   // 拖到画布外仍继续
      return;
    }
    // 第二指落下：按双指中点重新命中，进入捏合（期间不平移）
    // 三指及以上不做手势，但仍重算基准，抬回双指时不跳变
    const mid = pinchMid();
    const g = clientToGeo(mid.x, mid.y, geo);
    target = hitTarget(geo, g.x, g.y, e.altKey);
    pinchDist = pinchSpan();
    last = null;
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!target || pointers.size > 2) return;
    const geo = computeGeometry(state);

    if (pointers.size === 2) {
      const span = pinchSpan();
      if (!pinchDist || !span) { pinchDist = span; return; }
      const mid = pinchMid();
      if (zoomAt(geo, target, span / pinchDist, clientToGeo(mid.x, mid.y, geo))) renderPreview();
      pinchDist = span;
      return;
    }

    if (!last) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = geo.W / rect.width;            // CSS px → 几何 px
    const { crop, doClamp } = cropContext(geo, target);
    crop.offsetX += (e.clientX - last.x) * ratio;
    crop.offsetY += (e.clientY - last.y) * ratio;
    last = { x: e.clientX, y: e.clientY };
    doClamp();
    renderPreview();
  });

  const endPointer = (e) => {
    if (!pointers.delete(e.pointerId)) return;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    const had = target;

    if (pointers.size >= 2) {
      pinchDist = pinchSpan();   // 三指抬回双指：重算基准
      last = null;
      return;
    }
    if (pointers.size === 1) {
      // 捏合退回单指：以余下那指为新基准，避免图片跳跃
      const [p] = [...pointers.values()];
      last = target ? { x: p.x, y: p.y } : null;
      pinchDist = 0;
      return;
    }
    if (pointers.size === 0) {
      target = null;
      last = null;
      pinchDist = 0;
      if (had) saveOptions();   // 手势全部结束才落盘（避免 pointermove 每帧写盘）
    }
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  canvas.addEventListener('wheel', (e) => {
    const geo = computeGeometry(state);
    const cursor = eventToGeo(e, geo);
    const t = hitTarget(geo, cursor.x, cursor.y, e.altKey);   // 只缩放光标命中的对象
    if (!t) return;
    e.preventDefault();
    if (!zoomAt(geo, t, e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, cursor)) return;
    renderPreview();
    saveOptions();   // 滚轮缩放后落盘裁剪
  }, { passive: false });
}

/* ---------- 拖放打开图片 ---------- */

function bindDragDrop() {
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  ['dragenter', 'dragover'].forEach((t) => document.addEventListener(t, (e) => {
    stop(e);
    e.dataTransfer.dropEffect = 'copy';
    document.body.classList.add('dragging');
  }));
  document.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) document.body.classList.remove('dragging'); // 离开窗口
  });
  document.addEventListener('drop', (e) => {
    stop(e);
    document.body.classList.remove('dragging');
    loadPhotos(e.dataTransfer.files);
  });
}

/* ---------- 导出 ---------- */

function exportPng() {
  const off = document.createElement('canvas');
  const offCtx = off.getContext('2d');
  render(offCtx, state.exportScale);
  off.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'stamp.png';
    a.click();
    URL.revokeObjectURL(url);
  }, 'image/png');
}

/* ---------- 方案导出/导入（配置参数 + 图片，单 JSON 文件） ---------- */
// 设置取自 PERSISTED（含裁剪元数据）；图片本体内嵌为 base64 data URL。
// 优先从 IndexedDB 取原始 Blob（保留原格式/文件名）；IDB 不可用时回退到内存 Image 经 canvas 转 PNG。

const SCHEME_FORMAT = 'stampit-scheme';

function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => resolve(null);
    fr.readAsDataURL(blob);
  });
}

// 回退：把内存 Image 经离屏 canvas 转 PNG data URL（blob 同源不污染画布）
function imageToDataUrl(img) {
  try {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    return c.toDataURL('image/png');
  } catch (_) { return null; }
}

// data URL → Blob（手工解析，避免 file:// 下 fetch(data:) 受限）
function dataUrlToBlob(dataUrl) {
  const str = String(dataUrl || '');
  const comma = str.indexOf(',');
  if (comma < 0) return null;
  const head = str.slice(0, comma);
  const body = str.slice(comma + 1);
  const mime = (head.match(/^data:([^;,]+)/) || [])[1] || 'application/octet-stream';
  try {
    if (/;base64/i.test(head)) {
      const bin = atob(body);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return new Blob([arr], { type: mime });
    }
    return new Blob([decodeURIComponent(body)], { type: mime });
  } catch (_) { return null; }
}

// 取某图片槽位的 {name, dataUrl}：优先 IDB 原始 Blob，否则回退内存 Image
async function imageSlotToData(idbKey, memImg, fallbackName) {
  const rec = await idbGet(idbKey);
  if (rec && rec.blob) {
    const dataUrl = await blobToDataUrl(rec.blob);
    if (dataUrl) return { name: rec.name || fallbackName, dataUrl };
  }
  if (memImg) {
    const dataUrl = imageToDataUrl(memImg);
    if (dataUrl) return { name: fallbackName, dataUrl };
  }
  return null;
}

async function exportScheme() {
  els.schemeInfo.textContent = '导出中…';
  try {
    const settings = {};
    for (const k of PERSISTED) settings[k] = state[k];

    const images = { grid: [], outer: null, inner: null };

    const grid = await idbGet('grid');
    if (grid && Array.isArray(grid.items) && grid.items.length) {
      images.grid = (await Promise.all(grid.items.map(async (it) => {
        const dataUrl = await blobToDataUrl(it.blob);
        return dataUrl ? { name: it.name, dataUrl } : null;
      }))).filter(Boolean);
    } else if (state.images.length) {   // IDB 不可用时回退到内存图
      images.grid = state.images.map((img, i) => {
        const dataUrl = imageToDataUrl(img);
        return dataUrl ? { name: `image-${i + 1}.png`, dataUrl } : null;
      }).filter(Boolean);
    }

    images.outer = await imageSlotToData('outer', state.outerImage, 'outer.png');
    images.inner = await imageSlotToData('inner', state.innerImage, 'inner.png');

    const scheme = { format: SCHEME_FORMAT, version: 1, settings, images };
    const blob = new Blob([JSON.stringify(scheme)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'stamp-scheme.json';
    a.click();
    URL.revokeObjectURL(url);
    els.schemeInfo.textContent = '方案已导出';
  } catch (_) {
    els.schemeInfo.textContent = '方案导出失败';
  }
}

// 应用导入的背景图槽位（缺失则清空对应槽）
async function applyImportedBg(rec, stateKey, idbKey, infoEl) {
  const blob = rec && rec.dataUrl ? dataUrlToBlob(rec.dataUrl) : null;
  if (blob) {
    const img = await blobToImage(blob);
    if (img) {
      state[stateKey] = img;
      infoEl.textContent = rec.name || '已导入';
      await idbPut(idbKey, { blob, name: rec.name || idbKey });
      return;
    }
  }
  state[stateKey] = null;
  infoEl.textContent = '无';
  await idbDelete(idbKey);
}

async function importScheme(file) {
  let scheme;
  try {
    scheme = JSON.parse(await file.text());
  } catch (_) { els.schemeInfo.textContent = '方案文件解析失败'; return; }
  if (!scheme || scheme.format !== SCHEME_FORMAT || typeof scheme.settings !== 'object') {
    els.schemeInfo.textContent = '不是有效的方案文件';
    return;
  }
  els.schemeInfo.textContent = '导入中…';

  // 1. 应用设置（仅已知键，跳过空值）
  for (const k of PERSISTED) {
    const v = scheme.settings[k];
    if (v !== null && v !== undefined) state[k] = v;
  }
  // 方案文件早于本分支时没有 merges 键，上面的跳过空值逻辑会保留用户当前的区域布局，
  // 得到一个既非存档、也非原布局的混合态：没有迁移路径，直接重置为逐格模式
  if (!Array.isArray(scheme.settings.merges)) state.merges = [];
  // picks 同理：旧方案没有这个键，保留当前指定会让导入的照片顺序被上一套指定改写
  if (!scheme.settings.picks || typeof scheme.settings.picks !== 'object') state.picks = {};

  // 2. 应用图片（与设置同源；缺失槽位则清空）
  const imgs = scheme.images || {};
  const gridItems = Array.isArray(imgs.grid) ? imgs.grid : [];
  const gridBlobs = gridItems
    .map((it) => ({ blob: dataUrlToBlob(it.dataUrl), name: it.name }))
    .filter((it) => it.blob);
  if (gridBlobs.length) {
    const ok = (await Promise.all(gridBlobs.map(async (it) => ({ it, img: await blobToImage(it.blob) }))))
      .filter((p) => p.img);
    state.images = ok.map((p) => p.img);
    state.imageMeta = ok.map((p) => ({ blob: p.it.blob, name: p.it.name, key: itemKey(p.it) }));
    updateImgInfo();
    await idbPut('grid', { items: state.imageMeta });
  } else {
    // 这里不清 state.picks：它和图片来自同一个方案文件，本就是一致的一组数据，
    // 清掉会把文件里显式写着的指定丢掉（clearImage 那边清是因为用户在换图，来源不同）
    state.images = [];
    state.imageMeta = [];
    updateImgInfo();
    await idbDelete('grid');
  }
  await applyImportedBg(imgs.outer, 'outerImage', 'outer', els.outerImgInfo);
  await applyImportedBg(imgs.inner, 'innerImage', 'inner', els.innerImgInfo);

  // 3. 同步盘面 + 重新钳制裁剪 + 落盘 + 渲染
  clampAllCrops();
  syncInputsFromState();
  saveOptions();
  renderPreview();
  els.schemeInfo.textContent = '方案已导入';
}

// 重置方案：清空已保存的设置（localStorage）与图片（IndexedDB），回到出厂默认
async function resetScheme() {
  if (!window.confirm('确定要重置吗？将清空已保存的所有设置与图片，回到最初始状态。')) return;
  els.schemeInfo.textContent = '重置中…';

  // 1. 清空持久化存储
  try {
    for (const k of PERSISTED) localStorage.removeItem(STORAGE_PREFIX + k);
  } catch (_) { /* 隐私模式等异常静默 */ }
  await Promise.all([idbDelete('grid'), idbDelete('outer'), idbDelete('inner')]);

  // 2. state 恢复出厂默认（深拷贝，避免共享引用）
  Object.assign(state, structuredClone(DEFAULTS));

  // 3. 复位图片信息与文件框
  updateImgInfo();
  els.outerImgInfo.textContent = '无';
  els.innerImgInfo.textContent = '无';
  els.fileInput.value = '';
  els.outerImgInput.value = '';
  els.innerImgInput.value = '';

  // 4. 同步盘面 + 渲染
  syncInputsFromState();
  renderPreview();
  els.schemeInfo.textContent = '已重置为初始状态';
}

/* ---------- PWA ---------- */

// 注册 Service Worker，装机后可完全离线使用。
// file:// 下注册必然失败（origin 为 null），静默忽略即可——页面本身照常可用。
// 'sw.js' 按文档地址解析，所以站点挂在任何子目录（含 GitHub Pages 的 /stamp-it/）都不用改。
// 不必等 load：本脚本执行时首屏三件套已下载完，预缓存抢不到带宽，而 register 本身是异步的。
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

/* ---------- 启动 ---------- */

loadOptions();
bindControls();
bindCanvasInteractions();
bindDragDrop();
bindDragTargetSeg();
bindRegionGrid();
bindDrawer();
syncInputsFromState();
renderPreview();
bindStageResize();   // 取代 window.resize：可视区尺寸变化（含抽屉开合、横竖屏）即重渲染
restoreImages();     // 异步从 IndexedDB 还原图片，就绪后重渲染
registerServiceWorker();
