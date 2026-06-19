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
 * 渲染顺序（利用合成模式一次成型，天然支持半透明导出）：
 *   1. 清空 → 2. 填内边距色 + 画照片(cover) → 3. destination-out 打孔 → 4. destination-over 铺外边距色
 */

const DPR_LIMIT = 8;      // 预览缩放上限
const ZOOM_STEP = 1.1;    // 每格滚轮缩放系数
const MAX_PERF = 400;     // 齿孔数上限，防止超大图
const MIN_PERF = 3;
const STORAGE_PREFIX = 'stampit_';   // localStorage key 前缀
const PERSISTED = ['d', 'g', 'nx', 'ny', 'outerColor', 'outerOpacity', 'innerColor', 'exportScale', 'view'];

const state = {
  d: 8,
  g: 4,
  nx: 20,
  ny: 14,
  outerColor: '#000000',
  outerOpacity: 1,
  innerColor: '#d4af37',
  exportScale: 2,
  view: 'fit',              // 'fit' 适应窗口 | 'actual' 1:1 实际像素
  image: null,
  crop: { scale: 1, offsetX: 0, offsetY: 0 }, // offset 单位为几何 px，相对内容区中心
};

const canvas = document.getElementById('preview');
const ctx = canvas.getContext('2d');

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* ---------- 几何 ---------- */

function computeGeometry(s) {
  const pitch = s.d + s.g;
  const Sw = s.nx * pitch;
  const Sh = s.ny * pitch;
  const m = s.d / 2;          // 外边距 / 邮票矩形偏移
  const inner = pitch;        // 内边距
  return {
    d: s.d, pitch, Sw, Sh,
    W: Sw + s.d, H: Sh + s.d,
    m, inner,
    stampX: m, stampY: m,
    contentX: m + inner, contentY: m + inner,
    Cw: Sw - 2 * inner, Ch: Sh - 2 * inner,
  };
}

function holeCenters(geo) {
  const out = [];
  const { m, pitch, Sw, Sh } = geo;
  const nx = state.nx, ny = state.ny;
  for (let i = 0; i <= nx; i++) {           // 上/下边
    out.push({ x: m + i * pitch, y: m });
    out.push({ x: m + i * pitch, y: m + Sh });
  }
  for (let j = 1; j < ny; j++) {            // 左/右边（跳过已加的边角）
    out.push({ x: m, y: m + j * pitch });
    out.push({ x: m + Sw, y: m + j * pitch });
  }
  return out;
}

/* ---------- 照片 cover 裁剪 ---------- */

function coverBaseScale(geo, img) {
  return Math.max(geo.Cw / img.naturalWidth, geo.Ch / img.naturalHeight);
}

function imageDrawRect(s, geo) {
  const img = s.image;
  const eff = coverBaseScale(geo, img) * s.crop.scale;
  const w = img.naturalWidth * eff;
  const h = img.naturalHeight * eff;
  const cx = geo.contentX + geo.Cw / 2 + s.crop.offsetX;
  const cy = geo.contentY + geo.Ch / 2 + s.crop.offsetY;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

function clampCrop() {
  const img = state.image;
  if (!img) return;
  const geo = computeGeometry(state);
  const eff = coverBaseScale(geo, img) * state.crop.scale;
  const ox = Math.max(0, (img.naturalWidth * eff - geo.Cw) / 2);
  const oy = Math.max(0, (img.naturalHeight * eff - geo.Ch) / 2);
  state.crop.offsetX = clamp(state.crop.offsetX, -ox, ox);
  state.crop.offsetY = clamp(state.crop.offsetY, -oy, oy);
}

/* ---------- 渲染 ---------- */

function render(targetCtx, scale) {
  const s = state;
  const geo = computeGeometry(s);
  const cv = targetCtx.canvas;
  cv.width = Math.max(1, Math.round(geo.W * scale));
  cv.height = Math.max(1, Math.round(geo.H * scale));

  targetCtx.setTransform(scale, 0, 0, scale, 0, 0);
  targetCtx.globalAlpha = 1;
  targetCtx.globalCompositeOperation = 'source-over';
  targetCtx.clearRect(0, 0, geo.W, geo.H);

  // 2. 邮票主体：内边距色 + 照片
  targetCtx.fillStyle = s.innerColor;
  targetCtx.fillRect(geo.stampX, geo.stampY, geo.Sw, geo.Sh);

  if (s.image && geo.Cw > 0 && geo.Ch > 0) {
    targetCtx.save();
    targetCtx.beginPath();
    targetCtx.rect(geo.contentX, geo.contentY, geo.Cw, geo.Ch);
    targetCtx.clip();
    const r = imageDrawRect(s, geo);
    targetCtx.drawImage(s.image, r.x, r.y, r.w, r.h);
    targetCtx.restore();
  }

  // 3. 打孔
  targetCtx.globalCompositeOperation = 'destination-out';
  targetCtx.fillStyle = '#000';
  const radius = geo.d / 2;
  for (const c of holeCenters(geo)) {
    targetCtx.beginPath();
    targetCtx.arc(c.x, c.y, radius, 0, Math.PI * 2);
    targetCtx.fill();
  }

  // 4. 外边距色铺在所有透明区域之下
  targetCtx.globalCompositeOperation = 'destination-over';
  targetCtx.globalAlpha = s.outerOpacity;
  targetCtx.fillStyle = s.outerColor;
  targetCtx.fillRect(0, 0, geo.W, geo.H);

  targetCtx.globalAlpha = 1;
  targetCtx.globalCompositeOperation = 'source-over';
  targetCtx.setTransform(1, 0, 0, 1, 0, 0);
}

function previewScale(geo) {
  if (state.view === 'actual') return 1;     // 1:1 实际几何像素
  const availW = window.innerWidth - 280 - 80;
  const availH = window.innerHeight - 140;
  return clamp(Math.min(availW / geo.W, availH / geo.H), 0.25, DPR_LIMIT);
}

function renderPreview() {
  const geo = computeGeometry(state);
  render(ctx, previewScale(geo));
}

/* ---------- 选图自动反推齿孔数 ---------- */

function recomputePerfFromImage() {
  const img = state.image;
  if (!img) return;
  const pitch = state.d + state.g;
  state.nx = clamp(Math.round(img.naturalWidth / pitch) + 2, MIN_PERF, MAX_PERF);
  state.ny = clamp(Math.round(img.naturalHeight / pitch) + 2, MIN_PERF, MAX_PERF);
  state.crop = { scale: 1, offsetX: 0, offsetY: 0 };
  syncInputsFromState();
  saveOptions();
}

/* ---------- 控件 ---------- */

const els = {
  fileInput: document.getElementById('fileInput'),
  pickBtn: document.getElementById('pickBtn'),
  imgInfo: document.getElementById('imgInfo'),
  holeD: document.getElementById('holeD'),
  holeG: document.getElementById('holeG'),
  nx: document.getElementById('nx'),
  ny: document.getElementById('ny'),
  outerColor: document.getElementById('outerColor'),
  outerOpacity: document.getElementById('outerOpacity'),
  outerOpacityVal: document.getElementById('outerOpacityVal'),
  innerColor: document.getElementById('innerColor'),
  exportScale: document.getElementById('exportScale'),
  exportBtn: document.getElementById('exportBtn'),
  viewToggle: document.getElementById('viewToggle'),
};

function syncInputsFromState() {
  els.holeD.value = state.d;
  els.holeG.value = state.g;
  els.nx.value = state.nx;
  els.ny.value = state.ny;
  els.outerColor.value = state.outerColor;
  els.outerOpacity.value = state.outerOpacity;
  els.outerOpacityVal.textContent = Number(state.outerOpacity).toFixed(2);
  els.innerColor.value = state.innerColor;
  els.exportScale.value = String(state.exportScale);
  els.viewToggle.textContent = state.view === 'fit' ? '1:1 视图' : '适应窗口';
  els.viewToggle.classList.toggle('active', state.view === 'actual');
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

function loadImageFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const img = new Image();
  img.onload = () => {
    state.image = img;
    els.imgInfo.textContent = `${file.name} (${img.naturalWidth}×${img.naturalHeight})`;
    recomputePerfFromImage();
    renderPreview();
    URL.revokeObjectURL(img.src);
  };
  img.onerror = () => { els.imgInfo.textContent = '图片加载失败'; };
  img.src = URL.createObjectURL(file);
}

function bindControls() {
  els.pickBtn.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', (e) => loadImageFile(e.target.files && e.target.files[0]));

  const numField = (el, key, lo) => {
    el.addEventListener('input', () => {
      const v = parseFloat(el.value);
      if (Number.isNaN(v)) return;
      state[key] = Math.max(lo, v);
      clampCrop();
      renderPreview();
      saveOptions();
    });
  };
  numField(els.holeD, 'd', 1);
  numField(els.holeG, 'g', 0);
  numField(els.nx, 'nx', MIN_PERF);
  numField(els.ny, 'ny', MIN_PERF);

  els.outerColor.addEventListener('input', () => { state.outerColor = els.outerColor.value; renderPreview(); saveOptions(); });
  els.innerColor.addEventListener('input', () => { state.innerColor = els.innerColor.value; renderPreview(); saveOptions(); });
  els.outerOpacity.addEventListener('input', () => {
    state.outerOpacity = parseFloat(els.outerOpacity.value);
    els.outerOpacityVal.textContent = state.outerOpacity.toFixed(2);
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

function bindCanvasInteractions() {
  let dragging = false;
  let last = null;

  canvas.addEventListener('pointerdown', (e) => {
    if (!state.image) return;
    dragging = true;
    last = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const geo = computeGeometry(state);
    const rect = canvas.getBoundingClientRect();
    const ratio = geo.W / rect.width;            // CSS px → 几何 px
    state.crop.offsetX += (e.clientX - last.x) * ratio;
    state.crop.offsetY += (e.clientY - last.y) * ratio;
    last = { x: e.clientX, y: e.clientY };
    clampCrop();
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
    if (!state.image) return;
    e.preventDefault();
    const geo = computeGeometry(state);
    const img = state.image;
    const newScale = clamp(state.crop.scale * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP), 1, 5);
    if (newScale === state.crop.scale) return;

    const base = coverBaseScale(geo, img);
    const before = imageDrawRect(state, geo);
    const effOld = base * state.crop.scale;
    const cursor = eventToGeo(e, geo);
    // 光标处对应的图片自身坐标
    const imgX = (cursor.x - before.x) / effOld;
    const imgY = (cursor.y - before.y) / effOld;

    state.crop.scale = newScale;
    const effNew = base * newScale;
    // 反推 offset，使光标下像素保持不动
    const w = img.naturalWidth * effNew;
    const h = img.naturalHeight * effNew;
    const centerX = cursor.x + w / 2 - imgX * effNew;
    const centerY = cursor.y + h / 2 - imgY * effNew;
    state.crop.offsetX = centerX - geo.contentX - geo.Cw / 2;
    state.crop.offsetY = centerY - geo.contentY - geo.Ch / 2;

    clampCrop();
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
    loadImageFile(e.dataTransfer.files && e.dataTransfer.files[0]);
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
