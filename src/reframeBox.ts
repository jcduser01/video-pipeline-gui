/**
 * reframeBox.ts — the pure, DOM-free geometry brain of INI-091 Phase 4's draggable
 * crop box.
 *
 * This is a faithful TypeScript port of the already-tested Python module
 * `video_pipeline/reframe/model.py` (+ the `crop_dims` primitive from
 * `reframe/plan.py` and `UPSCALE_TOLERANCE` from `target_format.py`). The math is
 * mirrored exactly so the GUI box and the renderer never disagree: the geometry the
 * model yields here is the geometry rendered Mac-side.
 *
 * The framing model is three numbers — `{scale, pan_x, pan_y}`:
 *   - `scale`   — punch-in multiplier. 1.0 is the native widest crop of the target
 *                 aspect (largest target-aspect rect that fits the source, no fill);
 *                 > 1.0 punches in; < 1.0 is clamped to 1.0 (the no-fill rule).
 *   - `pan_x`/`pan_y` — the crop CENTRE in normalized source coords (0–1, top-left
 *                 origin). (0.5, 0.5) centres the crop; the centre is clamped so the
 *                 crop never leaves the footage.
 *
 * The aspect is passed as two plain integers (`aspectW`, `aspectH`) — the reduced
 * target ratio — rather than the Python `AspectPreset` object, since only `.w`/`.h`
 * are ever used by the geometry.
 *
 * NEW vs the Python (the GUI-only part): a rotation-aware coordinate layer mapping
 * source px <-> display px <-> preview px for EXIF/container rotations 0/90/180/270,
 * so a box dragged in preview-pixel space maps to the correct normalized source model
 * and back.
 *
 * Pure: no DOM, no canvas, no Tauri, no npm deps. Runs standalone under `node`.
 */

// ── tolerance (mirrors target_format.UPSCALE_TOLERANCE) ────────────────────────────

/** Auto may upscale a crop by at most this fraction. */
export const UPSCALE_TOLERANCE = 0.05;

// Pan / scale defaults — a centred native crop.
export const DEFAULT_PAN_X = 0.5;
export const DEFAULT_PAN_Y = 0.5;
export const DEFAULT_SCALE = 1.0;

// ── interfaces ─────────────────────────────────────────────────────────────────────

/** `{scale, pan_x, pan_y}` — the canonical reframe crop description. */
export interface FramingModel {
  scale: number;
  pan_x: number;
  pan_y: number;
}

/** A concrete pixel crop window `(x, y, w, h)` derived from a model. */
export interface CropGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Result of clamping a requested scale to the resolution-driven max-zoom. */
export interface ZoomClamp {
  scale: number; // effective scale after clamping
  requested: number; // what the caller asked for
  maxZoom: number; // computed hard-stop
  clamped: boolean; // did the clamp bite?
}

/** Live resolution readout: crop native px vs target output px. */
export interface ResolutionReadout {
  cropNativeW: number;
  cropNativeH: number;
  outW: number;
  outH: number;
  upscaleFactor: number; // max axis enlargement (>1 = upscaling)
  withinTolerance: boolean;
}

// ── model construction / clamping (mirrors FramingModel.__post_init__) ──────────────

/**
 * Build a clamped FramingModel. Clamp eagerly so an out-of-range model can never
 * reach the geometry math: scale < 1.0 -> 1.0 (no fill); pan outside [0,1] -> clamped.
 * Mirrors `FramingModel.__post_init__`.
 */
export function makeModel(
  scale: number = DEFAULT_SCALE,
  pan_x: number = DEFAULT_PAN_X,
  pan_y: number = DEFAULT_PAN_Y,
): FramingModel {
  return {
    scale: Math.max(1.0, Number(scale)),
    pan_x: Math.min(1.0, Math.max(0.0, Number(pan_x))),
    pan_y: Math.min(1.0, Math.max(0.0, Number(pan_y))),
  };
}

/** Round a model's fields to 6dp (mirrors FramingModel.to_dict). */
export function modelToDict(m: FramingModel): FramingModel {
  const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
  return { scale: r6(m.scale), pan_x: r6(m.pan_x), pan_y: r6(m.pan_y) };
}

// ── canonical-unit transforms: model <-> pixel crop window ──────────────────────────

/**
 * Largest crop of (srcW, srcH) matching the out aspect, even dimensions.
 * Mirrors `plan.crop_dims` byte-for-byte (Python int(round(x/2)*2) — banker's? No:
 * Python round() is banker's rounding, but here the argument x/2 is rounded then
 * doubled. We mirror Python's round-half-to-even to stay bit-identical).
 */
export function cropDims(
  srcW: number,
  srcH: number,
  outW: number,
  outH: number,
): [number, number] {
  const cw = (srcH * outW) / outH;
  let cropW: number;
  let cropH: number;
  if (cw <= srcW) {
    cropW = cw;
    cropH = srcH;
  } else {
    cropW = srcW;
    cropH = (srcW * outH) / outW;
  }
  cropW = Math.min(srcW, pyRound(cropW / 2) * 2);
  cropH = Math.min(srcH, pyRound(cropH / 2) * 2);
  return [cropW, cropH];
}

/** Native (scale=1.0) crop size for the aspect inside the source. */
export function nativeCropDims(
  srcW: number,
  srcH: number,
  aspectW: number,
  aspectH: number,
): [number, number] {
  return cropDims(srcW, srcH, aspectW, aspectH);
}

/**
 * Crop size at a given punch-in scale — matches `model.scaled_crop_dims` /
 * `build_crop_plan` exactly. scale <= 1.0 returns native; > 1.0 shrinks (even dims,
 * never larger than source).
 */
export function scaledCropDims(
  srcW: number,
  srcH: number,
  aspectW: number,
  aspectH: number,
  scale: number,
): [number, number] {
  let [cropW, cropH] = nativeCropDims(srcW, srcH, aspectW, aspectH);
  if (scale > 1.0) {
    cropW = Math.min(srcW, Math.max(2, pyRound(cropW / scale / 2) * 2));
    cropH = Math.min(srcH, Math.max(2, pyRound(cropH / scale / 2) * 2));
  }
  return [cropW, cropH];
}

/** Integer top/left edge for a normalized-centre-derived pixel centre, clamped. */
function clampTopLeft(centrePx: number, crop: number, src: number): number {
  const edge = pyRound(centrePx - crop / 2);
  return Math.min(Math.max(edge, 0), Math.max(0, src - crop));
}

/**
 * Resolve a FramingModel to a clamped pixel crop window. scale sets size; pan_x/pan_y
 * (the normalized crop centre) set position. Clamped inside the source (no-fill).
 * Mirrors `model.model_to_window`.
 */
export function modelToWindow(
  model: FramingModel,
  srcW: number,
  srcH: number,
  aspectW: number,
  aspectH: number,
): CropGeometry {
  const [cropW, cropH] = scaledCropDims(srcW, srcH, aspectW, aspectH, model.scale);
  const cxPx = model.pan_x * srcW;
  const cyPx = model.pan_y * srcH;
  const x = clampTopLeft(cxPx, cropW, srcW);
  const y = clampTopLeft(cyPx, cropH, srcH);
  return { x, y, w: cropW, h: cropH };
}

/**
 * Inverse transform: a pixel crop window back to a FramingModel. scale recovered from
 * the crop width/height vs native; pan from the window centre. Picks the axis-derived
 * scale that re-resolves to this exact window (the forward transform is authoritative),
 * making model<->window idempotent. Mirrors `model.window_to_model`.
 */
export function windowToModel(
  geom: CropGeometry,
  srcW: number,
  srcH: number,
  aspectW: number,
  aspectH: number,
): FramingModel {
  const [nativeW, nativeH] = nativeCropDims(srcW, srcH, aspectW, aspectH);
  const candidates: number[] = [];
  if (geom.w) candidates.push(nativeW / geom.w);
  if (geom.h) candidates.push(nativeH / geom.h);
  candidates.push(1.0);
  let scale = candidates[0];
  for (let cand of candidates) {
    cand = Math.max(1.0, cand);
    const [cw, ch] = scaledCropDims(srcW, srcH, aspectW, aspectH, cand);
    if (cw === geom.w && ch === geom.h) {
      scale = cand;
      break;
    }
  }
  const pan_x = srcW ? (geom.x + geom.w / 2) / srcW : DEFAULT_PAN_X;
  const pan_y = srcH ? (geom.y + geom.h / 2) / srcH : DEFAULT_PAN_Y;
  return makeModel(scale, pan_x, pan_y);
}

// ── resolution-driven max-zoom + advanced upscale ──────────────────────────────────

/**
 * The largest punch-in scale before the crop's NATIVE pixels fall below the target
 * output resolution (within tolerance upscale). Independent of pan. Mirrors
 * `model.max_zoom`.
 */
export function maxZoom(
  srcW: number,
  srcH: number,
  aspectW: number,
  aspectH: number,
  outW: number,
  outH: number,
  tolerance: number = UPSCALE_TOLERANCE,
): number {
  const [nativeW, nativeH] = nativeCropDims(srcW, srcH, aspectW, aspectH);
  const capW = outW ? (nativeW * (1.0 + tolerance)) / outW : Infinity;
  const capH = outH ? (nativeH * (1.0 + tolerance)) / outH : Infinity;
  const cap = Math.min(capW, capH);
  return Math.max(1.0, cap);
}

/**
 * Clamp a requested punch-in scale to the resolution-driven max-zoom. Hard-stop by
 * default; `allowUpscale=true` passes the request through (clamped always false),
 * letting the render upscale past budget. scale never below 1.0. Mirrors
 * `model.clamp_scale`.
 */
export function clampScale(
  requested: number,
  srcW: number,
  srcH: number,
  aspectW: number,
  aspectH: number,
  outW: number,
  outH: number,
  allowUpscale: boolean = false,
  tolerance: number = UPSCALE_TOLERANCE,
): ZoomClamp {
  const req = Math.max(1.0, Number(requested));
  const mz = maxZoom(srcW, srcH, aspectW, aspectH, outW, outH, tolerance);
  if (allowUpscale) {
    return { scale: req, requested: req, maxZoom: mz, clamped: false };
  }
  const effective = Math.min(req, mz);
  return { scale: effective, requested: req, maxZoom: mz, clamped: effective < req };
}

/**
 * Crop native px vs target output px at a given scale (the upscale margin). The
 * upscale factor is the larger of the two per-axis enlargements (out / native).
 * Mirrors `model.resolution_readout`.
 */
export function resolutionReadout(
  scale: number,
  srcW: number,
  srcH: number,
  aspectW: number,
  aspectH: number,
  outW: number,
  outH: number,
  tolerance: number = UPSCALE_TOLERANCE,
): ResolutionReadout {
  const [cw, ch] = scaledCropDims(srcW, srcH, aspectW, aspectH, Math.max(1.0, Number(scale)));
  const fx = cw ? outW / cw : Infinity;
  const fy = ch ? outH / ch : Infinity;
  const factor = Math.max(fx, fy);
  return {
    cropNativeW: cw,
    cropNativeH: ch,
    outW,
    outH,
    upscaleFactor: factor,
    withinTolerance: factor <= 1.0 + tolerance + 1e-9,
  };
}

// ── box constraints: a dragged box -> a constrained model ───────────────────────────

/**
 * Constrain an arbitrary requested crop rectangle (in SOURCE px, the box the user
 * dragged) to a valid FramingModel: aspect-locked, source-clamped, max-zoom-clamped.
 *
 * Steps (all mirroring the canonical math):
 *   1. Aspect-lock: derive a scale from the box's larger relative dimension, then snap
 *      to `scaledCropDims` so the crop keeps the EXACT target aspect (the box cannot
 *      change shape — it can only move and zoom). The box's centre is preserved.
 *   2. Max-zoom clamp: the derived scale is run through `clampScale` (hard-stop unless
 *      `allowUpscale`), so the box can never punch past the resolution budget.
 *   3. Source-clamp: `modelToWindow` parks the crop against the nearest edge so it
 *      never leaves the footage; the resulting (clamped) window is read back via
 *      `windowToModel` so the returned model is exactly what render will reproduce.
 *
 * The box is described by its centre + size in source px. We size from the box and
 * re-centre; aspect is enforced by snapping to crop dims, not by trusting the box.
 */
export function boxToModel(
  box: { cx: number; cy: number; w: number; h: number },
  srcW: number,
  srcH: number,
  aspectW: number,
  aspectH: number,
  outW: number,
  outH: number,
  allowUpscale: boolean = false,
  tolerance: number = UPSCALE_TOLERANCE,
): { model: FramingModel; geom: CropGeometry; zoom: ZoomClamp } {
  const [nativeW, nativeH] = nativeCropDims(srcW, srcH, aspectW, aspectH);
  // The box may be any shape; the crop is aspect-locked. Take the scale implied by
  // each axis (native/requested) and use the SMALLER scale (the larger box dim) so the
  // locked crop fully contains the dragged region — the box only ever shrinks toward
  // the target shape, never expands past what the user dragged. Guard zero dims.
  const sx = box.w > 0 ? nativeW / box.w : 1.0;
  const sy = box.h > 0 ? nativeH / box.h : 1.0;
  let scale = Math.max(1.0, Math.min(sx, sy));

  // Max-zoom clamp (hard-stop unless allowUpscale).
  const zoom = clampScale(scale, srcW, srcH, aspectW, aspectH, outW, outH, allowUpscale, tolerance);
  scale = zoom.scale;

  // Build the model from the box CENTRE (normalized) at the clamped scale, then resolve
  // -> source-clamp -> read back so the returned model is render-exact.
  const provisional = makeModel(
    scale,
    srcW ? box.cx / srcW : DEFAULT_PAN_X,
    srcH ? box.cy / srcH : DEFAULT_PAN_Y,
  );
  const geom = modelToWindow(provisional, srcW, srcH, aspectW, aspectH);
  const model = windowToModel(geom, srcW, srcH, aspectW, aspectH);
  return { model, geom, zoom };
}

// ── rotation-aware coordinate layer (NEW — GUI-only, not in the Python) ─────────────

/**
 * The four EXIF/container rotations the previewer must handle. A const-object "enum"
 * (node strips types but does not transform `enum`), so this is type-stripping-safe.
 */
export const Rotation = {
  R0: 0,
  R90: 90,
  R180: 180,
  R270: 270,
} as const;
export type RotationDeg = (typeof Rotation)[keyof typeof Rotation];

/**
 * Display dimensions for a source after applying `rotation`. For 90/270 the axes swap
 * (a portrait source rotated 90° displays landscape). `srcW`/`srcH` are the STORED
 * (coded) source dims; the previewer shows the source at these DISPLAY dims.
 */
export function displayDims(
  srcW: number,
  srcH: number,
  rotation: RotationDeg,
): [number, number] {
  if (rotation === Rotation.R90 || rotation === Rotation.R270) return [srcH, srcW];
  return [srcW, srcH];
}

/**
 * Map a point from DISPLAY space (post-rotation, the orientation the user sees) back
 * to STORED source space. `(dx, dy)` are display px; returns stored-source px.
 *
 * Convention: rotation is the clockwise angle applied to the STORED frame to PRODUCE
 * the display frame (the same sense as an EXIF/`rotate` tag the player honours). So to
 * go display -> source we rotate the display point by -rotation about the appropriate
 * dims. Top-left origin, y-down (screen/image convention).
 */
export function displayToSource(
  dx: number,
  dy: number,
  srcW: number,
  srcH: number,
  rotation: RotationDeg,
): [number, number] {
  // dispW/dispH are the display extents.
  const [dispW, dispH] = displayDims(srcW, srcH, rotation);
  switch (rotation) {
    case Rotation.R0:
      return [dx, dy];
    case Rotation.R90:
      // display = source rotated 90° CW. Inverse (display->source) is 90° CCW:
      //   sx = dy ; sy = dispW - dx   (dispW == srcH)
      return [dy, dispW - dx];
    case Rotation.R180:
      return [dispW - dx, dispH - dy];
    case Rotation.R270:
      // display = source rotated 270° CW (== 90° CCW). Inverse is 90° CW:
      //   sx = dispH - dy ; sy = dx   (dispH == srcW)
      return [dispH - dy, dx];
    default:
      return [dx, dy];
  }
}

/** Map a STORED source point to DISPLAY space (inverse of displayToSource). */
export function sourceToDisplay(
  sx: number,
  sy: number,
  srcW: number,
  srcH: number,
  rotation: RotationDeg,
): [number, number] {
  switch (rotation) {
    case Rotation.R0:
      return [sx, sy];
    case Rotation.R90:
      // forward of the 90° inverse above: dx = srcH - sy ; dy = sx
      return [srcH - sy, sx];
    case Rotation.R180:
      return [srcW - sx, srcH - sy];
    case Rotation.R270:
      // forward of the 270° inverse: dx = sy ; dy = srcW - sx
      return [sy, srcW - sx];
    default:
      return [sx, sy];
  }
}

/**
 * The geometry of the previewer viewport: where the (rotation-corrected) display frame
 * is drawn inside the preview element, and at what uniform scale. `previewW/H` are the
 * preview element px; `offsetX/Y` the letterbox/pillarbox padding; `scale` the
 * display-px-per-preview-px factor along each axis (uniform — aspect preserved).
 */
export interface PreviewLayout {
  /** Stored source dims. */
  srcW: number;
  srcH: number;
  /** Display dims after rotation. */
  dispW: number;
  dispH: number;
  rotation: RotationDeg;
  /** Top-left of the drawn display frame inside the preview element (preview px). */
  offsetX: number;
  offsetY: number;
  /** Drawn frame size inside the preview element (preview px). */
  drawnW: number;
  drawnH: number;
  /** preview px per display px (uniform). */
  unit: number;
}

/**
 * Compute the fit-inside (contain) layout of a rotated source within a preview box.
 * Mirrors the previewer's contain-fit: the display frame is scaled uniformly to fit
 * inside `(previewW, previewH)` and centred (letterbox/pillarbox).
 */
export function previewLayout(
  srcW: number,
  srcH: number,
  rotation: RotationDeg,
  previewW: number,
  previewH: number,
): PreviewLayout {
  const [dispW, dispH] = displayDims(srcW, srcH, rotation);
  const unit = Math.min(previewW / dispW, previewH / dispH);
  const drawnW = dispW * unit;
  const drawnH = dispH * unit;
  const offsetX = (previewW - drawnW) / 2;
  const offsetY = (previewH - drawnH) / 2;
  return { srcW, srcH, dispW, dispH, rotation, offsetX, offsetY, drawnW, drawnH, unit };
}

/**
 * Map a PREVIEW-space point (preview element px, origin top-left of the preview
 * element) to STORED source px, via display space. Returns source px; the point is NOT
 * clamped to the frame (callers decide whether an out-of-frame drag is valid).
 */
export function previewToSource(
  px: number,
  py: number,
  layout: PreviewLayout,
): [number, number] {
  // preview -> display: subtract letterbox offset, divide by unit.
  const dx = (px - layout.offsetX) / layout.unit;
  const dy = (py - layout.offsetY) / layout.unit;
  return displayToSource(dx, dy, layout.srcW, layout.srcH, layout.rotation);
}

/** Map a STORED source px point to PREVIEW-space px (inverse of previewToSource). */
export function sourceToPreview(
  sx: number,
  sy: number,
  layout: PreviewLayout,
): [number, number] {
  const [dx, dy] = sourceToDisplay(sx, sy, layout.srcW, layout.srcH, layout.rotation);
  const px = dx * layout.unit + layout.offsetX;
  const py = dy * layout.unit + layout.offsetY;
  return [px, py];
}

/**
 * The headline GUI helper: a box dragged in PREVIEW-pixel space -> the constrained
 * `{scale, pan_x, pan_y}` model. Takes the drag rect's two opposite corners in preview
 * px, maps them through the rotation layer to source px, derives the box centre+size in
 * source space, then defers to `boxToModel` for aspect-lock + source-clamp + max-zoom.
 *
 * Because the rotation can swap/flip axes, we map both corners and take the
 * axis-aligned source bounding box (min/max), so the result is correct for any
 * rotation. Aspect-lock then enforces the target shape regardless of the dragged
 * shape.
 */
export function previewRectToModel(
  rect: { x0: number; y0: number; x1: number; y1: number },
  layout: PreviewLayout,
  aspectW: number,
  aspectH: number,
  outW: number,
  outH: number,
  allowUpscale: boolean = false,
  tolerance: number = UPSCALE_TOLERANCE,
): { model: FramingModel; geom: CropGeometry; zoom: ZoomClamp } {
  const [sx0, sy0] = previewToSource(rect.x0, rect.y0, layout);
  const [sx1, sy1] = previewToSource(rect.x1, rect.y1, layout);
  const left = Math.min(sx0, sx1);
  const right = Math.max(sx0, sx1);
  const top = Math.min(sy0, sy1);
  const bottom = Math.max(sy0, sy1);
  const box = {
    cx: (left + right) / 2,
    cy: (top + bottom) / 2,
    w: right - left,
    h: bottom - top,
  };
  return boxToModel(
    box,
    layout.srcW,
    layout.srcH,
    aspectW,
    aspectH,
    outW,
    outH,
    allowUpscale,
    tolerance,
  );
}

// ── helpers ─────────────────────────────────────────────────────────────────────────

/**
 * Round-half-to-even (banker's rounding) — matches Python's built-in `round()`, which
 * `crop_dims` / `_clamp_top_left` / `scaled_crop_dims` rely on. JS `Math.round` rounds
 * half UP (toward +Inf), which would diverge from the Python on exact .5 boundaries
 * (e.g. dimension parity). We replicate Python's behaviour exactly so the GUI and the
 * renderer compute byte-identical crop windows.
 */
export function pyRound(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  // exactly .5 -> round to even
  return floor % 2 === 0 ? floor : floor + 1;
}
