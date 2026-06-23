/**
 * tests/reframeBox.test.ts — node-runnable correctness tests for the Phase 4 geometry
 * core. Run: `node tests/reframeBox.test.ts` (no npm deps; uses only node:assert).
 *
 * Verifies the TS port matches the Python `model.py` math: model<->window round-trip
 * idempotency, aspect-lock, source-clamp, max-zoom hard-stop + allowUpscale bypass,
 * resolution readout, and the NEW rotation transforms (0/90/180/270 preview<->source
 * round-trip). Includes at least one hand-computed cross-check against the Python math.
 *
 * Prints a clear pass/fail summary and exits non-zero on failure.
 */

import assert from "node:assert";
import {
  makeModel,
  cropDims,
  nativeCropDims,
  scaledCropDims,
  modelToWindow,
  windowToModel,
  maxZoom,
  clampScale,
  resolutionReadout,
  boxToModel,
  Rotation,
  displayDims,
  displayToSource,
  sourceToDisplay,
  previewLayout,
  previewToSource,
  sourceToPreview,
  previewRectToModel,
  pyRound,
  type RotationDeg,
} from "../src/reframeBox.ts";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    failures.push(`${name}: ${(e as Error).message}`);
  }
}

const approx = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`);

// ── hand-computed cross-check against the Python crop_dims math ──────────────────────
// Python crop_dims(1920,1080, 9,16):  cw = 1080*9/16 = 607.5 ; <= 1920 so
//   crop_w=607.5, crop_h=1080. crop_w = min(1920, round(607.5/2)*2)=round(303.75)*2
//   = 304*2 = 608. crop_h = min(1080, round(540)*2)=1080. -> (608, 1080).
test("cropDims 1920x1080 -> 9:16 == (608,1080) [hand-computed]", () => {
  assert.deepEqual(cropDims(1920, 1080, 9, 16), [608, 1080]);
});

// pyRound banker's rounding: 0.5->0, 1.5->2, 2.5->2, 3.5->4, 303.5->304 (even).
test("pyRound is round-half-to-even (matches Python round())", () => {
  assert.equal(pyRound(0.5), 0);
  assert.equal(pyRound(1.5), 2);
  assert.equal(pyRound(2.5), 2);
  assert.equal(pyRound(3.5), 4);
  assert.equal(pyRound(303.75), 304);
  assert.equal(pyRound(-0.5), -0); // -0; floor(-0.5)=-1, diff .5, -1 odd -> 0
});

// nativeCropDims is crop_dims; second hand check, 16:9 from a 1080x1920 portrait src.
// cw = 1920*16/9 = 3413.33 > 1080 -> crop_w=1080, crop_h=1080*9/16=607.5 ->
// round(303.75)*2 = 608. -> (1080, 608).
test("nativeCropDims portrait 1080x1920 -> 16:9 == (1080,608)", () => {
  assert.deepEqual(nativeCropDims(1080, 1920, 16, 9), [1080, 608]);
});

// ── scaledCropDims ──────────────────────────────────────────────────────────────────
test("scaledCropDims scale<=1 returns native", () => {
  assert.deepEqual(scaledCropDims(1920, 1080, 9, 16, 1.0), [608, 1080]);
  assert.deepEqual(scaledCropDims(1920, 1080, 9, 16, 0.3), [608, 1080]);
});
test("scaledCropDims scale=2 halves (even, hand: round(608/2/2)*2=304 ; round(1080/2/2)*2=540)", () => {
  // 608/2/2 = 152 -> 152*2 = 304 ; 1080/2/2 = 270 -> 270*2 = 540
  assert.deepEqual(scaledCropDims(1920, 1080, 9, 16, 2.0), [304, 540]);
});

// ── model <-> window round-trip idempotency across a scale × pan grid ────────────────
test("model<->window round-trip idempotent across scale×pan grid", () => {
  const srcs: [number, number][] = [
    [1920, 1080],
    [1080, 1920],
    [3840, 2160],
    [1280, 720],
  ];
  const aspects: [number, number][] = [
    [9, 16],
    [16, 9],
    [1, 1],
    [4, 5],
    [7, 3],
  ];
  const scales = [1.0, 1.25, 1.5, 2.0, 3.0, 5.0];
  const pans = [0.0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0];
  for (const [sw, sh] of srcs) {
    for (const [aw, ah] of aspects) {
      for (const s of scales) {
        for (const px of pans) {
          for (const py of pans) {
            const m = makeModel(s, px, py);
            const w1 = modelToWindow(m, sw, sh, aw, ah);
            const m2 = windowToModel(w1, sw, sh, aw, ah);
            const w2 = modelToWindow(m2, sw, sh, aw, ah);
            // The headline DoD: re-deriving and re-resolving yields the SAME window.
            assert.deepEqual(
              w2,
              w1,
              `window not idempotent: src=${sw}x${sh} aspect=${aw}:${ah} scale=${s} pan=${px},${py} -> ${JSON.stringify(w1)} vs ${JSON.stringify(w2)}`,
            );
          }
        }
      }
    }
  }
});

// ── aspect-lock: the constrained crop keeps the target aspect (even-dim tolerance) ───
test("aspect-lock: boxToModel crop holds target aspect within 1px", () => {
  // Drag an off-aspect box; the locked crop must match 9:16 (within even-dim rounding).
  const r = boxToModel(
    { cx: 960, cy: 540, w: 1200, h: 400 }, // wide box, source 1920x1080
    1920,
    1080,
    9,
    16,
    1080,
    1920, // out 1080x1920
  );
  const ratio = r.geom.w / r.geom.h;
  approx(ratio, 9 / 16, 0.01); // even-dim rounding tolerance
});

// ── source-clamp at extreme pans: crop stays inside the footage ──────────────────────
test("source-clamp: extreme pans park crop inside the frame", () => {
  for (const aspect of [
    [9, 16],
    [16, 9],
    [1, 1],
  ] as [number, number][]) {
    for (const [px, py] of [
      [0, 0],
      [1, 1],
      [0, 1],
      [1, 0],
      [-5, 5],
    ] as [number, number][]) {
      const g = modelToWindow(makeModel(2.0, px, py), 1920, 1080, aspect[0], aspect[1]);
      assert.ok(g.x >= 0, `x<0: ${JSON.stringify(g)}`);
      assert.ok(g.y >= 0, `y<0: ${JSON.stringify(g)}`);
      assert.ok(g.x + g.w <= 1920, `right OOB: ${JSON.stringify(g)}`);
      assert.ok(g.y + g.h <= 1080, `bottom OOB: ${JSON.stringify(g)}`);
    }
  }
});

// ── max-zoom hard-stop + allowUpscale bypass ────────────────────────────────────────
test("maxZoom hand-check: 4K src, 9:16 aspect, out 1080x1920", () => {
  // native 9:16 of 3840x2160: cw=2160*9/16=1215 -> round(607.5)*2=1216 ; ch=2160
  // -> native (1216, 2160). cap_w = 1216*1.05/1080 = 1.18222...
  // cap_h = 2160*1.05/1920 = 1.18125. cap = min = 1.18125.
  const [nw, nh] = nativeCropDims(3840, 2160, 9, 16);
  assert.deepEqual([nw, nh], [1216, 2160]);
  const mz = maxZoom(3840, 2160, 9, 16, 1080, 1920);
  approx(mz, 1.18125, 1e-6);
});
test("clampScale hard-stop bites; allowUpscale bypasses", () => {
  const hard = clampScale(3.0, 3840, 2160, 9, 16, 1080, 1920);
  assert.ok(hard.clamped, "expected hard-stop to bite at scale 3");
  approx(hard.scale, hard.maxZoom);
  assert.ok(hard.scale < 3.0);
  const soft = clampScale(3.0, 3840, 2160, 9, 16, 1080, 1920, true);
  assert.equal(soft.clamped, false);
  assert.equal(soft.scale, 3.0);
});
test("clampScale never below 1.0 (no-fill)", () => {
  const r = clampScale(0.2, 1920, 1080, 9, 16, 1080, 1920);
  assert.equal(r.scale, 1.0);
  assert.equal(r.requested, 1.0);
});

// ── resolution readout ──────────────────────────────────────────────────────────────
test("resolutionReadout factor + tolerance flag", () => {
  // At native scale on 4K 9:16 -> crop (1216,2160), out 1080x1920:
  // fx=1080/1216=0.888, fy=1920/2160=0.888 -> factor<1 (downscale) -> within tolerance.
  const r = resolutionReadout(1.0, 3840, 2160, 9, 16, 1080, 1920);
  assert.deepEqual([r.cropNativeW, r.cropNativeH], [1216, 2160]);
  assert.ok(r.upscaleFactor < 1.0);
  assert.equal(r.withinTolerance, true);
  // Punch in past max-zoom -> upscaling beyond tolerance -> flag false.
  const r2 = resolutionReadout(3.0, 3840, 2160, 9, 16, 1080, 1920);
  assert.ok(r2.upscaleFactor > 1.05);
  assert.equal(r2.withinTolerance, false);
});

// ── rotation transforms: display dims + round-trip ──────────────────────────────────
test("displayDims swaps axes for 90/270 only", () => {
  assert.deepEqual(displayDims(1920, 1080, Rotation.R0), [1920, 1080]);
  assert.deepEqual(displayDims(1920, 1080, Rotation.R90), [1080, 1920]);
  assert.deepEqual(displayDims(1920, 1080, Rotation.R180), [1920, 1080]);
  assert.deepEqual(displayDims(1920, 1080, Rotation.R270), [1080, 1920]);
});

test("display<->source round-trip for all rotations", () => {
  const srcW = 1920;
  const srcH = 1080;
  const pts: [number, number][] = [
    [0, 0],
    [1920, 1080],
    [100, 900],
    [960, 540],
    [1500, 200],
  ];
  for (const rot of [Rotation.R0, Rotation.R90, Rotation.R180, Rotation.R270] as RotationDeg[]) {
    for (const [sx, sy] of pts) {
      const [dx, dy] = sourceToDisplay(sx, sy, srcW, srcH, rot);
      const [sx2, sy2] = displayToSource(dx, dy, srcW, srcH, rot);
      approx(sx2, sx, 1e-6);
      approx(sy2, sy, 1e-6);
    }
  }
});

test("rotation 90 maps known corner correctly", () => {
  // source (1920x1080) rotated 90° CW displays as 1080x1920. Stored top-left (0,0)
  // -> display top-right (dispW=1080, 0).
  const [dx, dy] = sourceToDisplay(0, 0, 1920, 1080, Rotation.R90);
  assert.deepEqual([dx, dy], [1080, 0]);
  // and inverse:
  assert.deepEqual(displayToSource(1080, 0, 1920, 1080, Rotation.R90), [0, 0]);
});

// ── preview <-> source round-trip (the GUI net-new layer) ───────────────────────────
test("previewLayout contain-fit centres + uniform scale", () => {
  // 1920x1080 source, no rotation, into a 800x800 preview: unit=min(800/1920,800/1080)
  // = 800/1920 = 0.41666. drawnW=800, drawnH=450. offsetX=0, offsetY=(800-450)/2=175.
  const lay = previewLayout(1920, 1080, Rotation.R0, 800, 800);
  approx(lay.unit, 800 / 1920);
  approx(lay.drawnW, 800);
  approx(lay.drawnH, 450);
  approx(lay.offsetX, 0);
  approx(lay.offsetY, 175);
});

test("preview<->source round-trip across rotations", () => {
  const cases: [number, number, RotationDeg][] = [
    [1920, 1080, Rotation.R0],
    [1920, 1080, Rotation.R90],
    [1080, 1920, Rotation.R180],
    [1080, 1920, Rotation.R270],
  ];
  for (const [sw, sh, rot] of cases) {
    const lay = previewLayout(sw, sh, rot, 640, 900);
    for (const [sx, sy] of [
      [0, 0],
      [sw, sh],
      [sw / 2, sh / 2],
      [sw * 0.3, sh * 0.8],
    ] as [number, number][]) {
      const [px, py] = sourceToPreview(sx, sy, lay);
      const [sx2, sy2] = previewToSource(px, py, lay);
      approx(sx2, sx, 1e-6);
      approx(sy2, sy, 1e-6);
    }
  }
});

// ── previewRectToModel: a drag rect in preview px -> constrained model ───────────────
test("previewRectToModel produces a valid clamped model (rotated source)", () => {
  // Portrait source displayed via 90° rotation; drag a rect in preview px.
  const sw = 1080;
  const sh = 1920;
  const lay = previewLayout(sw, sh, Rotation.R90, 800, 600);
  const r = previewRectToModel(
    { x0: 100, y0: 80, x1: 500, y1: 520 },
    lay,
    1,
    1, // 1:1 aspect
    1080,
    1080,
  );
  // model is clamped/valid
  assert.ok(r.model.scale >= 1.0);
  assert.ok(r.model.pan_x >= 0 && r.model.pan_x <= 1);
  assert.ok(r.model.pan_y >= 0 && r.model.pan_y <= 1);
  // crop stays inside the footage
  assert.ok(r.geom.x >= 0 && r.geom.y >= 0);
  assert.ok(r.geom.x + r.geom.w <= sw);
  assert.ok(r.geom.y + r.geom.h <= sh);
  // re-resolving the returned model reproduces the same window (render-exact)
  const w2 = modelToWindow(r.model, sw, sh, 1, 1);
  assert.deepEqual(w2, r.geom);
});

test("previewRectToModel honours max-zoom hard-stop and allowUpscale", () => {
  const sw = 3840;
  const sh = 2160;
  const lay = previewLayout(sw, sh, Rotation.R0, 800, 450);
  // Drag a tiny rect (deep punch-in) -> hard-stop should clamp.
  const tiny = { x0: 390, y0: 220, x1: 410, y1: 240 };
  const hard = previewRectToModel(tiny, lay, 9, 16, 1080, 1920);
  assert.ok(hard.zoom.clamped, "expected max-zoom to clamp a deep punch-in");
  const soft = previewRectToModel(tiny, lay, 9, 16, 1080, 1920, true);
  assert.equal(soft.zoom.clamped, false);
  assert.ok(soft.model.scale >= hard.model.scale);
});

// ── summary ─────────────────────────────────────────────────────────────────────────
console.log("");
console.log(`reframeBox.test.ts — ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("");
  for (const f of failures) console.log("  FAIL  " + f);
  process.exit(1);
} else {
  console.log("ALL TESTS PASSED");
  process.exit(0);
}
