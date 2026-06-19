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
  'outerColor', 'outerColorOpacity', 'outerImageOpacity', 'outerMargin',
  'innerColor', 'innerColorOpacity', 'innerImageOpacity', 'innerFill', 'innerStops', 'innerAngle', 'innerOriginX', 'innerOriginY',
  'exportScale', 'view'];

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
  outerMargin: 0,                        // 外边距步进：0=半孔，每+1 增加一个 pitch
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
};

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
  const m = s.d / 2 + s.outerMargin * pitch;   // 外边距：半孔 + N 个 pitch
  const inner = pitch;        // 内边距
  return {
    d: s.d, pitch, Sw, Sh, X, Y, blockW, blockH,
    W: blockW + 2 * m, H: blockH + 2 * m,
    m, inner,
    blockX: m, blockY: m,
    contentX: m + inner, contentY: m + inner,   // (0,0) 格内容区，供单图模式复用
    Cw: Sw - 2 * inner, Ch: Sh - 2 * inner,     // 单格内容区尺寸
  };
}

// 第 (c,r) 格的内容区矩形
function cellContent(geo, c, r) {
  return {
    x: geo.m + c * geo.Sw + geo.inner,
    y: geo.m + r * geo.Sh + geo.inner,
    w: geo.Cw, h: geo.Ch,
  };
}

function holeCenters(geo) {
  const out = [];
  const { m, pitch, Sw, Sh, X, Y } = geo;
  const nx = state.nx, ny = state.ny;
  const vTotal = Y * ny;     // 全高 = blockH / pitch
  for (let c = 0; c <= X; c++) {            // 垂直齿孔线
    const x = m + c * Sw;
    for (let k = 0; k <= vTotal; k++) out.push({ x, y: m + k * pitch });
  }
  const hTotal = X * nx;     // 全宽 = blockW / pitch
  for (let r = 0; r <= Y; r++) {            // 水平齿孔线
    const y = m + r * Sh;
    for (let k = 0; k <= hTotal; k++) out.push({ x: m + k * pitch, y });
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

// 钳制单格 crop 的 offset：保证该格图片铺满内容区
function clampCropCell(c, r) {
  if (!state.images.length) return;
  const geo = computeGeometry(state);
  const img = state.images[(r * geo.X + c) % state.images.length];
  if (!img) return;
  const crop = cellCrop(c, r);
  const eff = coverScale(img, geo.Cw, geo.Ch) * crop.scale;
  const ox = Math.max(0, (img.naturalWidth * eff - geo.Cw) / 2);
  const oy = Math.max(0, (img.naturalHeight * eff - geo.Ch) / 2);
  crop.offsetX = clamp(crop.offsetX, -ox, ox);
  crop.offsetY = clamp(crop.offsetY, -oy, oy);
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

// object-fit: cover 居中绘制（调用方需先 clip 到目标矩形）
function drawCover(ctx, img, x, y, w, h) {
  const k = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const dw = img.naturalWidth * k, dh = img.naturalHeight * k;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
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
    drawCover(sheet, s.outerImage, 0, 0, geo.W, geo.H);
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
    drawCover(inner, s.innerImage, geo.blockX, geo.blockY, geo.blockW, geo.blockH);
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
  outerMargin: document.getElementById('outerMargin'),
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
  viewToggle: document.getElementById('viewToggle'),
};

function updateOuterMarginHint() {
  const m = state.d / 2 + state.outerMargin * (state.d + state.g);
  els.outerMarginHint.textContent = `≈ ${Math.round(m)}px`;
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
  els.outerMargin.value = state.outerMargin;
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
    img.onload = () => { URL.revokeObjectURL(img.src); res(img); };
    img.onerror = () => { URL.revokeObjectURL(img.src); res(null); };
    img.src = URL.createObjectURL(f);
  }))).then((imgs) => {
    const ok = imgs.filter(Boolean);
    if (!ok.length) { els.imgInfo.textContent = '图片加载失败'; return; }
    state.images = ok;
    els.imgInfo.textContent = ok.length === 1
      ? `${files[0].name} (${ok[0].naturalWidth}×${ok[0].naturalHeight})`
      : `${ok.length} 张图片`;
    state.crops = {};   // 新图重置所有裁剪；齿孔数由用户手动调整
    renderPreview();
  });
}

function clearImage() {
  state.images = [];
  state.crops = {};
  els.fileInput.value = '';                       // 允许重新选择同一文件
  els.imgInfo.textContent = '未选择图片';
  renderPreview();
}

// 通用背景图选择器（内/外边距），载入 Image 到 state[key]，不影响齿孔计算
function bindBgImagePicker(pickBtn, clearBtn, fileInput, infoEl, key) {
  pickBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file || !file.type.startsWith('image/')) return;
    const img = new Image();
    img.onload = () => {
      state[key] = img;
      infoEl.textContent = file.name;
      renderPreview();
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => { infoEl.textContent = '加载失败'; };
    img.src = URL.createObjectURL(file);
  });
  clearBtn.addEventListener('click', () => {
    state[key] = null;
    fileInput.value = '';
    infoEl.textContent = '无';
    renderPreview();
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
  numField(els.outerMargin, 'outerMargin', 0);

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
    c: clamp(Math.floor((gx - geo.m) / geo.Sw), 0, geo.X - 1),
    r: clamp(Math.floor((gy - geo.m) / geo.Sh), 0, geo.Y - 1),
  };
}

function bindCanvasInteractions() {
  let dragging = false;
  let dragCell = null;
  let last = null;

  canvas.addEventListener('pointerdown', (e) => {
    if (!state.images.length) return;
    const geo = computeGeometry(state);
    const cur = eventToGeo(e, geo);
    dragCell = cellAt(geo, cur.x, cur.y);        // 仅拖动光标所在的那一格
    dragging = true;
    last = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const geo = computeGeometry(state);
    const rect = canvas.getBoundingClientRect();
    const ratio = geo.W / rect.width;            // CSS px → 几何 px
    const crop = cellCrop(dragCell.c, dragCell.r);
    crop.offsetX += (e.clientX - last.x) * ratio;
    crop.offsetY += (e.clientY - last.y) * ratio;
    last = { x: e.clientX, y: e.clientY };
    clampCropCell(dragCell.c, dragCell.r);
    renderPreview();
  });

  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  canvas.addEventListener('wheel', (e) => {
    if (!state.images.length) return;
    e.preventDefault();
    const geo = computeGeometry(state);
    const cursor = eventToGeo(e, geo);
    const { c, r } = cellAt(geo, cursor.x, cursor.y);   // 只缩放光标所在格
    const crop = cellCrop(c, r);
    const newScale = clamp(crop.scale * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP), 1, 5);
    if (newScale === crop.scale) return;

    const img = state.images[(r * geo.X + c) % state.images.length];
    const cell = cellContent(geo, c, r);
    const base = coverScale(img, geo.Cw, geo.Ch);
    const before = imageDrawRect(img, cell, crop);
    const effOld = base * crop.scale;
    const imgX = (cursor.x - before.x) / effOld;     // 光标处对应的图片自身坐标
    const imgY = (cursor.y - before.y) / effOld;

    crop.scale = newScale;
    const effNew = base * newScale;
    // 反推 offset，使光标下像素保持不动
    const w = img.naturalWidth * effNew;
    const h = img.naturalHeight * effNew;
    crop.offsetX = (cursor.x + w / 2 - imgX * effNew) - (cell.x + cell.w / 2);
    crop.offsetY = (cursor.y + h / 2 - imgY * effNew) - (cell.y + cell.h / 2);

    clampCropCell(c, r);
    renderPreview();
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

/* ---------- 启动 ---------- */

loadOptions();
bindControls();
bindCanvasInteractions();
bindDragDrop();
syncInputsFromState();
renderPreview();
window.addEventListener('resize', renderPreview);
