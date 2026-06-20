'use strict';

/*
 * 邮票化小工具 —— Canvas 2D 实现
 *
 * 几何模型（统一单位 pitch = 孔直径 d + 孔间距 g）：
 *   - 邮票矩形：Sw = nx*pitch, Sh = ny*pitch
 *   - 外边距 = d/2：画布 W = Sw+d, H = Sh+d，邮票矩形偏移 (d/2, d/2)
 *   - 齿孔：半径 d/2 的整圆，圆心落在邮票矩形边线上，按 pitch 间隔；边角圆形成四分之一孔
 *   - 内边距 = pitch：内容区四边各内缩 pitch → Cw=(nx-2)*pitch, Ch=(ny-2)*pitch
 *
 * 渲染顺序（离屏分层、自底向上合成，天然支持半透明导出）：
 *   1. base 底色层（baseColor@baseOpacity）—— 最底层，齿孔镂空处透出它
 *   2. sheet 外边距层（outerColor + outerImage cover，各自独立透明度）
 *   3. stamp 邮票层（内边距填充 纯色/线性/径向渐变 + innerImage cover + 各格照片），叠入 deco
 *   4. destination-out 在 deco 上打孔，穿透 sheet + stamp，露出底色 → 真实镂空
 *   5. 合成到目标：先 base，再叠 deco
 * 改用离屏分层（而非单次 destination-over）是为了让 outerOpacity/baseOpacity 保持均匀、
 * 渐变在用户坐标系内渲染，并让齿孔能透出一个可控的底色层。
 */

const DPR_LIMIT = 8;      // 预览缩放上限
const ZOOM_STEP = 1.1;    // 每格滚轮缩放系数
const MIN_PERF = 3;       // 齿孔数下限
const STORAGE_PREFIX = 'stampit_';   // localStorage key 前缀
const PERSISTED = ['d', 'g', 'nx', 'ny', 'matrixX', 'matrixY', 'baseColor', 'baseOpacity',
  'outerColor', 'outerColorOpacity', 'outerImageOpacity',
  'outerMarginTop', 'outerMarginRight', 'outerMarginBottom', 'outerMarginLeft',
  'innerColor', 'innerColorOpacity', 'innerImageOpacity', 'innerFill', 'innerStops', 'innerAngle', 'innerOriginX', 'innerOriginY',
  'exportScale', 'view',
  'crops', 'outerCrop', 'innerCrop'];   // 裁剪元数据随选项落盘；图片本体走 IndexedDB

const state = {
  d: 8,
  g: 4,
  nx: 20,
  ny: 14,
  matrixX: 1,                            // 矩阵列数
  matrixY: 1,                            // 矩阵行数
  baseColor: '#000000',                  // 最底层底色：齿孔镂空处透出它
  baseOpacity: 1,                        // 底色透明度（调低可导出透明/半透明 PNG）
  outerColor: '#000000',
  outerColorOpacity: 0,                  // 外边距背景色透明度（默认 0：露出底色）
  outerImageOpacity: 1,                  // 外边距背景图透明度
  outerMarginTop: 0,                     // 外边距步进（四向独立）：0=半孔，每+1 增加一个 pitch
  outerMarginRight: 0,
  outerMarginBottom: 0,
  outerMarginLeft: 0,
  outerImage: null,                      // 外边距背景图（session 态，不持久化）
  innerImage: null,                      // 内边距背景图（session 态，不持久化）
  innerColor: '#d4af37',                 // 纯色模式用色
  innerColorOpacity: 1,                  // 内边距背景色/渐变透明度（不含照片）
  innerImageOpacity: 1,                  // 内边距背景图透明度
  innerFill: 'solid',                    // 'solid' | 'linear' | 'radial'
  innerStops: [{ pos: 0, color: '#f0d979' }, { pos: 1, color: '#a67c1a' }],
  innerAngle: 90,                        // 线性渐变角度（度）
  innerOriginX: 0.5,                     // 径向渐变原点 X（0–1，相对邮票矩形宽）
  innerOriginY: 0.5,                     // 径向渐变原点 Y（0–1，相对邮票矩形高）
  exportScale: 2,
  view: 'fit',              // 'fit' 适应窗口 | 'actual' 1:1 实际像素
  images: [],               // 多图数组（session 态，不持久化）；按行优先顺序重复填充矩阵
  crops: {},                // 每格独立裁剪：键 "c,r" → {scale, offsetX, offsetY}（session 态）
  outerCrop: { scale: 1, offsetX: 0, offsetY: 0 },   // 外背景图缩放/平移（session 态）
  innerCrop: { scale: 1, offsetX: 0, offsetY: 0 },   // 内背景图缩放/平移（session 态）
};

// 出厂默认值快照（在 loadOptions 改写 state 之前拍下），供“重置方案”还原最初始状态
const DEFAULTS = structuredClone(state);

const IDENTITY_CROP = { scale: 1, offsetX: 0, offsetY: 0 };
function getCrop(c, r) { return state.crops[c + ',' + r] || IDENTITY_CROP; }   // 只读，缺省返回共享单位裁剪
function cellCrop(c, r) {                                                       // 取（并按需创建）可编辑的格裁剪
  const k = c + ',' + r;
  return state.crops[k] || (state.crops[k] = { scale: 1, offsetX: 0, offsetY: 0 });
}

const canvas = document.getElementById('preview');
const ctx = canvas.getContext('2d');

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* ---------- 几何 ---------- */

function computeGeometry(s) {
  const pitch = s.d + s.g;
  const Sw = s.nx * pitch;            // 单张邮票
  const Sh = s.ny * pitch;
  const X = Math.max(1, Math.round(s.matrixX));
  const Y = Math.max(1, Math.round(s.matrixY));
  const blockW = X * Sw;              // 整个矩阵块
  const blockH = Y * Sh;
  const half = s.d / 2;                          // 半孔基准
  const mT = half + s.outerMarginTop * pitch;    // 四向外边距：半孔 + N 个 pitch
  const mR = half + s.outerMarginRight * pitch;
  const mB = half + s.outerMarginBottom * pitch;
  const mL = half + s.outerMarginLeft * pitch;
  const inner = pitch;        // 内边距
  return {
    d: s.d, pitch, Sw, Sh, X, Y, blockW, blockH,
    W: blockW + mL + mR, H: blockH + mT + mB,
    mT, mR, mB, mL, inner,
    blockX: mL, blockY: mT,
    contentX: mL + inner, contentY: mT + inner,   // (0,0) 格内容区，供单图模式复用
    Cw: Sw - 2 * inner, Ch: Sh - 2 * inner,     // 单格内容区尺寸
  };
}

// 第 (c,r) 格的内容区矩形
function cellContent(geo, c, r) {
  return {
    x: geo.mL + c * geo.Sw + geo.inner,
    y: geo.mT + r * geo.Sh + geo.inner,
    w: geo.Cw, h: geo.Ch,
  };
}

function holeCenters(geo) {
  const out = [];
  const { mT, mL, pitch, Sw, Sh, X, Y } = geo;
  const nx = state.nx, ny = state.ny;
  const vTotal = Y * ny;     // 全高 = blockH / pitch
  for (let c = 0; c <= X; c++) {            // 垂直齿孔线
    const x = mL + c * Sw;
    for (let k = 0; k <= vTotal; k++) out.push({ x, y: mT + k * pitch });
  }
  const hTotal = X * nx;     // 全宽 = blockW / pitch
  for (let r = 0; r <= Y; r++) {            // 水平齿孔线
    const y = mT + r * Sh;
    for (let k = 0; k <= hTotal; k++) out.push({ x: mL + k * pitch, y });
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

// 钳制单格 crop 的 offset：保证该格图片铺满内容区
function clampCropCell(c, r) {
  if (!state.images.length) return;
  const geo = computeGeometry(state);
  const img = state.images[(r * geo.X + c) % state.images.length];
  clampCropTo(cellCrop(c, r), img, geo.Cw, geo.Ch);
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

// 几何变化后重新钳制所有已编辑过的格
function clampAllCrops() {
  const X = Math.max(1, Math.round(state.matrixX));
  const Y = Math.max(1, Math.round(state.matrixY));
  for (let r = 0; r < Y; r++) {
    for (let c = 0; c < X; c++) {
      if (state.crops[c + ',' + r]) clampCropCell(c, r);
    }
  }
  clampOuterCrop();
  clampInnerCrop();
}

/* ---------- 内边距填充（纯色 / 线性 / 径向渐变） ---------- */

function innerFillStyle(targetCtx, geo) {
  const s = state;
  if (s.innerFill === 'solid' || !Array.isArray(s.innerStops) || s.innerStops.length === 0) {
    return s.innerColor;
  }
  const stops = s.innerStops
    .map((st) => ({ pos: clamp(st.pos, 0, 1), color: st.color }))
    .sort((a, b) => a.pos - b.pos);

  // 渐变横跨整个矩阵块（而非单张邮票）
  const bx = geo.blockX, by = geo.blockY, bw = geo.blockW, bh = geo.blockH;
  const cx = bx + bw / 2;
  const cy = by + bh / 2;
  let grad;
  if (s.innerFill === 'radial') {
    // 原点由百分比指定，半径取到最远角点的距离以保证铺满
    const ox = bx + bw * s.innerOriginX;
    const oy = by + bh * s.innerOriginY;
    const r = Math.max(
      Math.hypot(ox - bx, oy - by),
      Math.hypot(ox - (bx + bw), oy - by),
      Math.hypot(ox - bx, oy - (by + bh)),
      Math.hypot(ox - (bx + bw), oy - (by + bh)),
    );
    grad = targetCtx.createRadialGradient(ox, oy, 0, ox, oy, r);
  } else {                       // linear
    const th = (s.innerAngle * Math.PI) / 180;
    const co = Math.cos(th), si = Math.sin(th);
    const L = (Math.abs(bw * co) + Math.abs(bh * si)) / 2;
    grad = targetCtx.createLinearGradient(cx - L * co, cy - L * si, cx + L * co, cy + L * si);
  }
  for (const st of stops) grad.addColorStop(st.pos, st.color);
  return grad;
}

/* ---------- 渲染 ---------- */

// 建一个与目标等尺寸、已套好 scale 变换的离屏图层
function layerCanvas(geo, scale) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(geo.W * scale));
  c.height = Math.max(1, Math.round(geo.H * scale));
  const cx = c.getContext('2d');
  cx.setTransform(scale, 0, 0, scale, 0, 0);
  return cx;
}

function render(targetCtx, scale) {
  const s = state;
  const geo = computeGeometry(s);
  const cv = targetCtx.canvas;
  cv.width = Math.max(1, Math.round(geo.W * scale));
  cv.height = Math.max(1, Math.round(geo.H * scale));

  // --- 外边距层 sheet：外色(@outerColorOpacity) + 外背景图 cover(@outerImageOpacity) 各自独立透明度 ---
  const sheet = layerCanvas(geo, scale);
  sheet.globalAlpha = s.outerColorOpacity;
  sheet.fillStyle = s.outerColor;
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
  inner.fillStyle = innerFillStyle(inner, geo);
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
  // 各格照片：按行优先顺序重复填充
  const imgs = s.images;
  if (imgs.length && geo.Cw > 0 && geo.Ch > 0) {
    for (let r = 0; r < geo.Y; r++) {
      for (let c = 0; c < geo.X; c++) {
        const img = imgs[(r * geo.X + c) % imgs.length];
        const cell = cellContent(geo, c, r);
        deco.save();
        deco.beginPath(); deco.rect(cell.x, cell.y, cell.w, cell.h); deco.clip();
        const dr = imageDrawRect(img, cell, getCrop(c, r));   // 每格独立 cover + 裁剪
        deco.drawImage(img, dr.x, dr.y, dr.w, dr.h);
        deco.restore();
      }
    }
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

function previewScale(geo) {
  if (state.view === 'actual') return 1;     // 1:1 实际几何像素
  const availW = Math.max(50, window.innerWidth - 280 - 80);
  const availH = Math.max(50, window.innerHeight - 140);
  // 适应窗口：始终缩放到可视区域内（不设下限，避免大尺寸出现滚动条），仅限制放大上限
  return Math.min(Math.min(availW / geo.W, availH / geo.H), DPR_LIMIT);
}

function renderPreview() {
  const geo = computeGeometry(state);
  render(ctx, previewScale(geo));
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
  baseColor: document.getElementById('baseColor'),
  baseOpacity: document.getElementById('baseOpacity'),
  baseOpacityVal: document.getElementById('baseOpacityVal'),
  outerColor: document.getElementById('outerColor'),
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
  outerImgBtn: document.getElementById('outerImgBtn'),
  outerImgClear: document.getElementById('outerImgClear'),
  outerImgInput: document.getElementById('outerImgInput'),
  outerImgInfo: document.getElementById('outerImgInfo'),
  innerImgBtn: document.getElementById('innerImgBtn'),
  innerImgClear: document.getElementById('innerImgClear'),
  innerImgInput: document.getElementById('innerImgInput'),
  innerImgInfo: document.getElementById('innerImgInfo'),
  innerColor: document.getElementById('innerColor'),
  innerColorRow: document.getElementById('innerColorRow'),
  innerColorOpacity: document.getElementById('innerColorOpacity'),
  innerColorOpacityVal: document.getElementById('innerColorOpacityVal'),
  innerImageOpacity: document.getElementById('innerImageOpacity'),
  innerImageOpacityVal: document.getElementById('innerImageOpacityVal'),
  innerFill: document.getElementById('innerFill'),
  gradientControls: document.getElementById('gradientControls'),
  stopsEditor: document.getElementById('stopsEditor'),
  addStop: document.getElementById('addStop'),
  angleRow: document.getElementById('angleRow'),
  innerAngle: document.getElementById('innerAngle'),
  innerAngleVal: document.getElementById('innerAngleVal'),
  originRow: document.getElementById('originRow'),
  originX: document.getElementById('originX'),
  originY: document.getElementById('originY'),
  originXVal: document.getElementById('originXVal'),
  originYVal: document.getElementById('originYVal'),
  exportScale: document.getElementById('exportScale'),
  exportBtn: document.getElementById('exportBtn'),
  exportSchemeBtn: document.getElementById('exportSchemeBtn'),
  importSchemeBtn: document.getElementById('importSchemeBtn'),
  resetSchemeBtn: document.getElementById('resetSchemeBtn'),
  schemeInput: document.getElementById('schemeInput'),
  schemeInfo: document.getElementById('schemeInfo'),
  viewToggle: document.getElementById('viewToggle'),
};

const MARGIN_SIDES = ['outerMarginTop', 'outerMarginRight', 'outerMarginBottom', 'outerMarginLeft'];

// 四向边距是否一致
function marginsUniform() {
  return MARGIN_SIDES.every((k) => state[k] === state.outerMarginTop);
}

function updateOuterMarginHint() {
  const pitch = state.d + state.g;
  const px = (k) => Math.round(state.d / 2 + state[k] * pitch);
  els.outerMarginHint.textContent = marginsUniform()
    ? `≈ ${px('outerMarginTop')}px`
    : `≈ 上${px('outerMarginTop')} 右${px('outerMarginRight')} 下${px('outerMarginBottom')} 左${px('outerMarginLeft')}px`;
}

// “全”输入框：四向一致时显示统一值，否则留空（占位提示“统一”）
function updateMarginAllField() {
  els.outerMarginAll.value = marginsUniform() ? state.outerMarginTop : '';
}

// 把四向边距完整写回输入盘（用于载入 / 程序化变更）
function syncMarginPad() {
  els.outerMarginTop.value = state.outerMarginTop;
  els.outerMarginRight.value = state.outerMarginRight;
  els.outerMarginBottom.value = state.outerMarginBottom;
  els.outerMarginLeft.value = state.outerMarginLeft;
  updateMarginAllField();
}

function syncInputsFromState() {
  els.holeD.value = state.d;
  els.holeG.value = state.g;
  els.nx.value = state.nx;
  els.ny.value = state.ny;
  els.matrixX.value = state.matrixX;
  els.matrixY.value = state.matrixY;
  els.baseColor.value = state.baseColor;
  els.baseOpacity.value = state.baseOpacity;
  els.baseOpacityVal.textContent = Number(state.baseOpacity).toFixed(2);
  els.outerColor.value = state.outerColor;
  els.outerColorOpacity.value = state.outerColorOpacity;
  els.outerColorOpacityVal.textContent = Number(state.outerColorOpacity).toFixed(2);
  els.outerImageOpacity.value = state.outerImageOpacity;
  els.outerImageOpacityVal.textContent = Number(state.outerImageOpacity).toFixed(2);
  syncMarginPad();
  updateOuterMarginHint();
  els.innerColor.value = state.innerColor;
  els.innerColorOpacity.value = state.innerColorOpacity;
  els.innerColorOpacityVal.textContent = Number(state.innerColorOpacity).toFixed(2);
  els.innerImageOpacity.value = state.innerImageOpacity;
  els.innerImageOpacityVal.textContent = Number(state.innerImageOpacity).toFixed(2);
  els.innerFill.value = state.innerFill;
  els.innerAngle.value = state.innerAngle;
  els.innerAngleVal.textContent = `${state.innerAngle}°`;
  els.originX.value = state.innerOriginX;
  els.originY.value = state.innerOriginY;
  els.originXVal.textContent = state.innerOriginX.toFixed(2);
  els.originYVal.textContent = state.innerOriginY.toFixed(2);
  els.exportScale.value = String(state.exportScale);
  els.viewToggle.textContent = state.view === 'fit' ? '1:1 视图' : '适应窗口';
  els.viewToggle.classList.toggle('active', state.view === 'actual');
  renderStopsEditor();
  updateInnerControlsVisibility();
}

/* ---------- 内边距渐变控件 ---------- */

function updateInnerControlsVisibility() {
  const mode = state.innerFill;
  els.innerColorRow.hidden = mode !== 'solid';
  els.gradientControls.hidden = mode === 'solid';
  els.angleRow.hidden = mode !== 'linear';     // 角度仅线性渐变有意义
  els.originRow.hidden = mode !== 'radial';     // 原点仅径向渐变有意义
}

function renderStopsEditor() {
  const editor = els.stopsEditor;
  editor.textContent = '';
  state.innerStops.forEach((stop, i) => {
    const row = document.createElement('div');
    row.className = 'stop-row';

    const color = document.createElement('input');
    color.type = 'color';
    color.value = stop.color;
    color.addEventListener('input', () => {
      state.innerStops[i].color = color.value;
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
      state.innerStops[i].pos = parseInt(pos.value, 10) / 100;
      renderPreview();
      saveOptions();
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'stop-del';
    del.textContent = '✕';
    del.disabled = state.innerStops.length <= 1;   // 至少保留 1 档
    del.addEventListener('click', () => {
      if (state.innerStops.length <= 1) return;
      state.innerStops.splice(i, 1);
      renderStopsEditor();
      renderPreview();
      saveOptions();
    });

    row.append(color, pos, del);
    editor.appendChild(row);
  });
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
      const imgs = (await Promise.all(grid.items.map((it) => blobToImage(it.blob)))).filter(Boolean);
      if (imgs.length) {
        state.images = imgs;
        els.imgInfo.textContent = imgs.length === 1
          ? `${grid.items[0].name} (${imgs[0].naturalWidth}×${imgs[0].naturalHeight})`
          : `${imgs.length} 张图片`;
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

// 多图载入（多选 / 多文件拖放），按序存入 state.images
function loadPhotos(fileList) {
  const files = Array.from(fileList || []).filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;
  els.imgInfo.textContent = '加载中…';
  Promise.all(files.map((f) => new Promise((res) => {
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(img.src); res({ img, file: f }); };
    img.onerror = () => { URL.revokeObjectURL(img.src); res({ img: null, file: f }); };
    img.src = URL.createObjectURL(f);
  }))).then((pairs) => {
    const ok = pairs.filter((p) => p.img);   // 保留 文件↔图片 对齐，仅成功项
    if (!ok.length) { els.imgInfo.textContent = '图片加载失败'; return; }
    state.images = ok.map((p) => p.img);
    els.imgInfo.textContent = ok.length === 1
      ? `${ok[0].file.name} (${ok[0].img.naturalWidth}×${ok[0].img.naturalHeight})`
      : `${ok.length} 张图片`;
    state.crops = {};   // 新图重置所有裁剪；齿孔数由用户手动调整
    idbPut('grid', { items: ok.map((p) => ({ blob: p.file, name: p.file.name })) });   // 持久化原始 Blob
    saveOptions();      // 用空 crops 覆盖旧持久值，避免残留
    renderPreview();
  });
}

function clearImage() {
  state.images = [];
  state.crops = {};
  els.fileInput.value = '';                       // 允许重新选择同一文件
  els.imgInfo.textContent = '未选择图片';
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

// 外边距十字输入盘：改“全”同步四向；单独改某向后，四向一致则“全”回填该值，否则留空
function bindMarginPad() {
  const afterChange = () => {
    clampAllCrops();
    updateOuterMarginHint();
    renderPreview();
    saveOptions();
  };
  // 单独改某一向：不回填正在输入的格，只刷新“全”框（空 / 统一值）
  const sideField = (el, key) => {
    el.addEventListener('input', () => {
      const v = parseFloat(el.value);
      if (Number.isNaN(v)) return;
      state[key] = Math.max(0, v);
      updateMarginAllField();
      afterChange();
    });
  };
  sideField(els.outerMarginTop, 'outerMarginTop');
  sideField(els.outerMarginRight, 'outerMarginRight');
  sideField(els.outerMarginBottom, 'outerMarginBottom');
  sideField(els.outerMarginLeft, 'outerMarginLeft');

  // 改“全”：同步四向并回填四个格
  els.outerMarginAll.addEventListener('input', () => {
    const v = parseFloat(els.outerMarginAll.value);
    if (Number.isNaN(v)) return;
    const m = Math.max(0, v);
    for (const k of MARGIN_SIDES) state[k] = m;
    syncMarginPad();
    afterChange();
  });
}

function bindControls() {
  els.pickBtn.addEventListener('click', () => els.fileInput.click());
  els.clearBtn.addEventListener('click', clearImage);
  els.fileInput.addEventListener('change', (e) => loadPhotos(e.target.files));
  bindBgImagePicker(els.outerImgBtn, els.outerImgClear, els.outerImgInput, els.outerImgInfo, 'outerImage');
  bindBgImagePicker(els.innerImgBtn, els.innerImgClear, els.innerImgInput, els.innerImgInfo, 'innerImage');

  const numField = (el, key, lo) => {
    el.addEventListener('input', () => {
      const v = parseFloat(el.value);
      if (Number.isNaN(v)) return;
      state[key] = Math.max(lo, v);
      clampAllCrops();
      updateOuterMarginHint();
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
  bindMarginPad();

  els.baseColor.addEventListener('input', () => { state.baseColor = els.baseColor.value; renderPreview(); saveOptions(); });
  els.baseOpacity.addEventListener('input', () => {
    state.baseOpacity = parseFloat(els.baseOpacity.value);
    els.baseOpacityVal.textContent = state.baseOpacity.toFixed(2);
    renderPreview();
    saveOptions();
  });
  els.outerColor.addEventListener('input', () => { state.outerColor = els.outerColor.value; renderPreview(); saveOptions(); });
  els.innerColor.addEventListener('input', () => { state.innerColor = els.innerColor.value; renderPreview(); saveOptions(); });

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

  els.innerFill.addEventListener('change', () => {
    state.innerFill = els.innerFill.value;
    updateInnerControlsVisibility();
    renderPreview();
    saveOptions();
  });
  els.addStop.addEventListener('click', () => {
    const last = state.innerStops[state.innerStops.length - 1];
    state.innerStops.push({ pos: 1, color: last ? last.color : '#ffffff' });
    renderStopsEditor();
    renderPreview();
    saveOptions();
  });
  els.innerAngle.addEventListener('input', () => {
    state.innerAngle = parseInt(els.innerAngle.value, 10);
    els.innerAngleVal.textContent = `${state.innerAngle}°`;
    renderPreview();
    saveOptions();
  });
  els.originX.addEventListener('input', () => {
    state.innerOriginX = parseFloat(els.originX.value);
    els.originXVal.textContent = state.innerOriginX.toFixed(2);
    renderPreview();
    saveOptions();
  });
  els.originY.addEventListener('input', () => {
    state.innerOriginY = parseFloat(els.originY.value);
    els.originYVal.textContent = state.innerOriginY.toFixed(2);
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

function eventToGeo(e, geo) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) / rect.width * geo.W,
    y: (e.clientY - rect.top) / rect.height * geo.H,
  };
}

// 由几何坐标定位所在格 {c, r}
function cellAt(geo, gx, gy) {
  return {
    c: clamp(Math.floor((gx - geo.mL) / geo.Sw), 0, geo.X - 1),
    r: clamp(Math.floor((gy - geo.mT) / geo.Sh), 0, geo.Y - 1),
  };
}

// 命中目标：块外→外图；块内按 Alt / 是否有照片 → 内图或某格；否则 null（不响应）
// wantInner（按住 Alt）在块内优先指向内背景图，便于在照片之上调整内图
function hitTarget(geo, gx, gy, wantInner) {
  const inBlock = gx >= geo.blockX && gx <= geo.blockX + geo.blockW &&
                  gy >= geo.blockY && gy <= geo.blockY + geo.blockH;
  if (!inBlock) return state.outerImage ? { type: 'outer' } : null;
  if (wantInner && state.innerImage) return { type: 'inner' };
  if (state.images.length) return { type: 'cell', ...cellAt(geo, gx, gy) };
  return state.innerImage ? { type: 'inner' } : null;   // 无照片时块内直接调内图
}

// 目标 → {crop, img, content, doClamp}：统一 cell / outer / inner 三种拖拽缩放对象
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
  return {
    crop: cellCrop(t.c, t.r),
    img: state.images[(t.r * geo.X + t.c) % state.images.length],
    content: cellContent(geo, t.c, t.r),
    doClamp: () => clampCropCell(t.c, t.r),
  };
}

function bindCanvasInteractions() {
  let dragging = false;
  let dragTarget = null;
  let last = null;

  canvas.addEventListener('pointerdown', (e) => {
    const geo = computeGeometry(state);
    const cur = eventToGeo(e, geo);
    const t = hitTarget(geo, cur.x, cur.y, e.altKey);
    if (!t) return;
    dragTarget = t;                              // 拖动光标命中的对象（格 / 外图 / 内图）
    dragging = true;
    last = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const geo = computeGeometry(state);
    const rect = canvas.getBoundingClientRect();
    const ratio = geo.W / rect.width;            // CSS px → 几何 px
    const { crop, doClamp } = cropContext(geo, dragTarget);
    crop.offsetX += (e.clientX - last.x) * ratio;
    crop.offsetY += (e.clientY - last.y) * ratio;
    last = { x: e.clientX, y: e.clientY };
    doClamp();
    renderPreview();
  });

  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    saveOptions();   // 拖拽结束落盘最终裁剪（避免 pointermove 每帧写盘）
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  canvas.addEventListener('wheel', (e) => {
    const geo = computeGeometry(state);
    const cursor = eventToGeo(e, geo);
    const t = hitTarget(geo, cursor.x, cursor.y, e.altKey);   // 只缩放光标命中的对象
    if (!t) return;
    e.preventDefault();
    const { crop, img, content, doClamp } = cropContext(geo, t);
    const newScale = clamp(crop.scale * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP), 1, 5);
    if (newScale === crop.scale) return;

    const base = coverScale(img, content.w, content.h);
    const before = imageDrawRect(img, content, crop);
    const effOld = base * crop.scale;
    const imgX = (cursor.x - before.x) / effOld;     // 光标处对应的图片自身坐标
    const imgY = (cursor.y - before.y) / effOld;

    crop.scale = newScale;
    const effNew = base * newScale;
    // 反推 offset，使光标下像素保持不动
    const w = img.naturalWidth * effNew;
    const h = img.naturalHeight * effNew;
    crop.offsetX = (cursor.x + w / 2 - imgX * effNew) - (content.x + content.w / 2);
    crop.offsetY = (cursor.y + h / 2 - imgY * effNew) - (content.y + content.h / 2);

    doClamp();
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

  // 2. 应用图片（与设置同源；缺失槽位则清空）
  const imgs = scheme.images || {};
  const gridItems = Array.isArray(imgs.grid) ? imgs.grid : [];
  const gridBlobs = gridItems
    .map((it) => ({ blob: dataUrlToBlob(it.dataUrl), name: it.name }))
    .filter((it) => it.blob);
  if (gridBlobs.length) {
    const decoded = (await Promise.all(gridBlobs.map((it) => blobToImage(it.blob)))).filter(Boolean);
    state.images = decoded;
    els.imgInfo.textContent = decoded.length === 1
      ? `${gridBlobs[0].name} (${decoded[0].naturalWidth}×${decoded[0].naturalHeight})`
      : `${decoded.length} 张图片`;
    await idbPut('grid', { items: gridBlobs });
  } else {
    state.images = [];
    els.imgInfo.textContent = '未选择图片';
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
  els.imgInfo.textContent = '未选择图片';
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

/* ---------- 启动 ---------- */

loadOptions();
bindControls();
bindCanvasInteractions();
bindDragDrop();
syncInputsFromState();
renderPreview();
restoreImages();   // 异步从 IndexedDB 还原图片，就绪后重渲染
window.addEventListener('resize', renderPreview);
