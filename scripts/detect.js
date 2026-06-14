/**
 * Auto-Wall — detection (pure JS, no OpenCV/WASM).
 *
 * Loads the active scene's background into a working-resolution canvas, reads its
 * pixels, and runs the pure-JS detect-core (colour mask + contour tracing). No
 * WASM means it can't freeze the Foundry tab. Returns contours in working-image
 * pixel coordinates plus the dimensions needed to map into scene space.
 */
import { colorMask, findContours, morphOpen, morphClose, applyEdgeMargin,
         thin, pruneSkeletonSpurs, traceSkeleton, downscaleMask, removeSmallComponents } from "./detect-core.js";

/** The scene level whose background we detect on. v14 scenes are multi-level
 *  (core feature); single-level uses its only level, multi-level uses the lowest. */
export function getActiveLevel() {
  const levels = canvas.scene?.levels?.contents ?? [];
  if (!levels.length) return null;
  return levels.length === 1
    ? levels[0]
    : [...levels].sort((a, b) => (a.elevation?.bottom ?? 0) - (b.elevation?.bottom ?? 0))[0];
}

/** v14-correct background source (Scene#background is deprecated -> per-level). */
export function getActiveBackgroundSrc() {
  return getActiveLevel()?.background?.src ?? null;
}

/** Draw the scene background into a canvas, capped to maxDim on its long edge. */
export async function loadSceneImageData(maxDim) {
  const src = getActiveBackgroundSrc();
  if (!src) throw new Error("active scene level has no background image");
  const image = new Image();
  image.crossOrigin = "anonymous";
  await new Promise((res, rej) => {
    image.onload = res;
    image.onerror = () => rej(new Error(`could not load background image: ${src}`));
    image.src = foundry.utils.getRoute ? foundry.utils.getRoute(src) : src;
  });
  const nw = image.naturalWidth, nh = image.naturalHeight;
  const scale = Math.min(1, maxDim / Math.max(nw, nh));
  const w = Math.max(1, Math.round(nw * scale));
  const h = Math.max(1, Math.round(nh * scale));
  const cnv = document.createElement("canvas");
  cnv.width = w; cnv.height = h;
  const ctx = cnv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  return { data, width: w, height: h, naturalWidth: nw, naturalHeight: nh };
}

/**
 * Detect wall contours on the active scene background.
 * @returns {{contours: number[][][], width, height, naturalWidth, naturalHeight}}
 *   contours: polylines [[x,y], ...] in working-image pixels.
 */
export async function detectContours(params) {
  const levelId = getActiveLevel()?.id ?? null;
  const { data, width, height, naturalWidth, naturalHeight } =
    await loadSceneImageData(params.workingDimension);
  let mask = colorMask(data, width, height, params.wallColor, params.colorThreshold);
  // mask cleanup: fill tiny gaps in walls, drop salt speckle
  if (params.maskCleanup !== false) {
    mask = morphClose(mask, width, height, 2);
    mask = morphOpen(mask, width, height, 1);
  }
  // hatching / grid removal: opening erases lines thinner than the wall thickness
  if (params.removeHatching) {
    mask = morphOpen(mask, width, height, Math.max(1, Math.round(params.hatchingMaxWidth ?? 3)));
  }
  if (params.edgeMargin > 0) applyEdgeMargin(mask, width, height, Math.round(params.edgeMargin));

  // Centerline mode: thin the ink to its 1px skeleton and trace that, so each
  // drawn wall becomes ONE wall down its middle instead of two edge contours.
  if (params.centerline) {
    // Drop isolated speckle (floor stipple / rubble dots) so only connected walls
    // remain — solid-black walls are kept, the dots that would otherwise skeletonise
    // into fake walls through open floor are removed.
    if (params.despeckle > 0) mask = removeSmallComponents(mask, width, height, Math.round(params.despeckle));
    // Thinning cost scales with pixels x object thickness, so skeletonise at a
    // capped resolution and scale the centerlines back up (~8x faster at 4000px).
    const SKEL_MAX = 2000;
    const sf = Math.min(1, SKEL_MAX / Math.max(width, height));
    let sw = width, sh = height, sm = mask;
    if (sf < 1) {
      sw = Math.max(1, Math.round(width * sf));
      sh = Math.max(1, Math.round(height * sf));
      sm = downscaleMask(mask, width, height, sw, sh);
    }
    // Fuse outlined / stippled walls into a solid band first, so the skeleton is
    // a single centerline rather than two edge strokes + speckle.
    if (params.wallFill > 0) sm = morphClose(sm, sw, sh, Math.max(1, Math.round(params.wallFill * sf)));
    let skel = thin(sm, sw, sh);
    skel = pruneSkeletonSpurs(skel, sw, sh, Math.max(4, Math.round(10 * sf)));
    const inv = sf < 1 ? 1 / sf : 1;
    const lines = traceSkeleton(skel, sw, sh).map((p) => p.map(([x, y]) => [x * inv, y * inv]));
    // drop sub-pixel noise specks that survived cleanup; real walls are far longer
    const contours = lines.filter((p) => pathLength(p) >= 5);
    return { contours, open: true, width, height, naturalWidth, naturalHeight, levelId };
  }

  const minArea = (params.minAreaPct / 100) * width * height;
  const contours = findContours(mask, width, height, minArea);
  return { contours, open: false, width, height, naturalWidth, naturalHeight, levelId };
}

const pathLength = (p) => {
  let L = 0;
  for (let i = 1; i < p.length; i++) L += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  return L;
};

/** Quick scan of the scene background to classify it for auto-preset selection.
 *  Returns { darkFraction, saturation, gridScore } sampled at low resolution. */
export async function scanScene() {
  const { data, width, height } = await loadSceneImageData(1200);
  let dark = 0, satSum = 0, n = width * height;
  for (let p = 0; p < data.length; p += 4) {
    const r = data[p], g = data[p + 1], b = data[p + 2];
    if (r < 60 && g < 60 && b < 60) dark++;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    satSum += mx === 0 ? 0 : (mx - mn) / mx;
  }
  // grid score: periodicity of column-darkness near the scene grid period
  const gridPx = (canvas.scene?.grid?.size ?? 0) * (width / (canvas.scene?.dimensions?.sceneWidth ?? width));
  let gridScore = 0;
  if (gridPx >= 4 && gridPx < width / 4) {
    const col = new Float32Array(width);
    for (let x = 0; x < width; x++) {
      let s = 0;
      for (let y = 0; y < height; y += 4) s += 255 - data[(y * width + x) * 4];
      col[x] = s;
    }
    // correlation of the darkness profile with a comb at the grid period
    const period = Math.round(gridPx);
    let on = 0, off = 0, cOn = 0, cOff = 0;
    for (let x = 0; x < width; x++) {
      if (x % period < 2) { on += col[x]; cOn++; } else { off += col[x]; cOff++; }
    }
    const mOn = cOn ? on / cOn : 0, mOff = cOff ? off / cOff : 1;
    gridScore = mOff > 0 ? (mOn - mOff) / mOff : 0; // >0 => darker at grid lines
  }
  return { darkFraction: dark / n, saturation: satSum / n, gridScore };
}
