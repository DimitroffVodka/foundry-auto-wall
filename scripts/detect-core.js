/**
 * Auto-Wall — pure-JS detection core (no OpenCV, no WASM, no DOM).
 *
 * Operates on a flat RGBA byte array + dimensions, so it runs identically in the
 * browser (canvas ImageData) and in Node (test harness). Two stages:
 *   1. colorMask  — binary mask of pixels near a target colour.
 *   2. findContours — Suzuki-Abe border following (outer + hole borders, like
 *      OpenCV RETR_CCOMP) → polylines, area-filtered.
 */

/** Binary mask (Uint8Array, 1=match) of pixels within `threshold` (0-100) of
 *  `[r,g,b]`, using max-channel (Chebyshev) distance — matches an inRange box. */
export function colorMask(rgba, width, height, target, threshold) {
  const [tr, tg, tb] = target;
  const t = (threshold / 100) * 255;
  const mask = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    if (rgba[p + 3] >= 128 &&            // skip (semi-)transparent pixels
        Math.abs(rgba[p] - tr) <= t &&
        Math.abs(rgba[p + 1] - tg) <= t &&
        Math.abs(rgba[p + 2] - tb) <= t) {
      mask[i] = 1;
    }
  }
  return mask;
}

// --- binary morphology (separable, prefix-sum; square structuring element) ---

/** Erode: pixel survives iff the full (2r+1)² window is all 1 (border counts as 0). */
export function erode(mask, w, h, r) {
  if (r <= 0) return mask;
  const need = 2 * r + 1;
  const tmp = new Uint8Array(w * h);
  const ps = new Int32Array(Math.max(w, h) + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) ps[x + 1] = ps[x] + mask[row + x];
    for (let x = 0; x < w; x++) {
      const a = x - r, b = x + r;
      if (a < 0 || b >= w) { tmp[row + x] = 0; continue; }
      tmp[row + x] = (ps[b + 1] - ps[a] === need) ? 1 : 0;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) ps[y + 1] = ps[y] + tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      const a = y - r, b = y + r;
      if (a < 0 || b >= h) { out[y * w + x] = 0; continue; }
      out[y * w + x] = (ps[b + 1] - ps[a] === need) ? 1 : 0;
    }
  }
  return out;
}

/** Dilate: pixel is 1 iff any pixel in the (2r+1)² window is 1. */
export function dilate(mask, w, h, r) {
  if (r <= 0) return mask;
  const tmp = new Uint8Array(w * h);
  const ps = new Int32Array(Math.max(w, h) + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) ps[x + 1] = ps[x] + mask[row + x];
    for (let x = 0; x < w; x++) {
      const a = Math.max(0, x - r), b = Math.min(w - 1, x + r);
      tmp[row + x] = (ps[b + 1] - ps[a] > 0) ? 1 : 0;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) ps[y + 1] = ps[y] + tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      const a = Math.max(0, y - r), b = Math.min(h - 1, y + r);
      out[y * w + x] = (ps[b + 1] - ps[a] > 0) ? 1 : 0;
    }
  }
  return out;
}

export const morphOpen = (m, w, h, r) => dilate(erode(m, w, h, r), w, h, r);   // removes thin structures
export const morphClose = (m, w, h, r) => erode(dilate(m, w, h, r), w, h, r);  // fills small gaps

/** Zero out a `margin`-px band around the border (drop the map frame/page edge). */
export function applyEdgeMargin(mask, w, h, margin) {
  if (margin <= 0) return mask;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < margin || y < margin || x >= w - margin || y >= h - margin) mask[y * w + x] = 0;
    }
  }
  return mask;
}

// --- centerline / skeleton (single walls instead of outline double-walls) ---

/** Zhang-Suen thinning: reduce a binary mask to its 1px skeleton (centerlines). */
export function thin(mask, w, h) {
  const m = Uint8Array.from(mask);
  const ix = (x, y) => y * w + x;
  let changed = true;
  while (changed) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      const rm = [];
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          if (!m[ix(x, y)]) continue;
          const p2 = m[ix(x, y - 1)], p3 = m[ix(x + 1, y - 1)], p4 = m[ix(x + 1, y)],
                p5 = m[ix(x + 1, y + 1)], p6 = m[ix(x, y + 1)], p7 = m[ix(x - 1, y + 1)],
                p8 = m[ix(x - 1, y)], p9 = m[ix(x - 1, y - 1)];
          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (B < 2 || B > 6) continue;
          const s = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
          let A = 0;
          for (let i = 0; i < 8; i++) if (s[i] === 0 && s[i + 1] === 1) A++;
          if (A !== 1) continue;
          if (step === 0) { if (p2 && p4 && p6) continue; if (p4 && p6 && p8) continue; }
          else { if (p2 && p4 && p8) continue; if (p2 && p6 && p8) continue; }
          rm.push(ix(x, y));
        }
      }
      if (rm.length) { changed = true; for (const i of rm) m[i] = 0; }
    }
  }
  return m;
}

/** Block-OR downscale of a binary mask to nw×nh: a destination pixel is set if
 *  ANY source pixel in its block is set (preserves thin-wall connectivity). Used
 *  to skeletonise at a lower resolution — thinning cost scales with pixels ×
 *  object thickness, so halving the resolution is ~8x faster. */
export function downscaleMask(src, w, h, nw, nh) {
  const dst = new Uint8Array(nw * nh);
  for (let ny = 0; ny < nh; ny++) {
    const y0 = Math.floor((ny * h) / nh), y1 = Math.max(y0 + 1, Math.floor(((ny + 1) * h) / nh));
    for (let nx = 0; nx < nw; nx++) {
      const x0 = Math.floor((nx * w) / nw), x1 = Math.max(x0 + 1, Math.floor(((nx + 1) * w) / nw));
      let on = 0;
      for (let y = y0; y < y1 && !on; y++) for (let x = x0; x < x1; x++) if (src[y * w + x]) { on = 1; break; }
      dst[ny * nw + nx] = on;
    }
  }
  return dst;
}

const N8 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

/** Remove connected components (8-connected) smaller than minArea px. Drops
 *  isolated speckle (stipple / rubble dots) while keeping large connected walls,
 *  WITHOUT eroding wall thickness the way a morphological opening would. */
export function removeSmallComponents(mask, w, h, minArea) {
  if (minArea <= 1) return mask;
  const out = Uint8Array.from(mask);
  const label = new Int32Array(w * h);
  const stack = [];
  let cur = 0;
  for (let i = 0; i < out.length; i++) {
    if (!out[i] || label[i]) continue;
    cur++;
    stack.length = 0; stack.push(i); label[i] = cur;
    const members = [i];
    while (stack.length) {
      const p = stack.pop();
      const px = p % w, py = (p / w) | 0;
      for (const [dx, dy] of N8) {
        const nx = px + dx, ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const np = ny * w + nx;
        if (out[np] && !label[np]) { label[np] = cur; stack.push(np); members.push(np); }
      }
    }
    if (members.length < minArea) for (const m of members) out[m] = 0;
  }
  return out;
}

const pathLen = (p) => {
  let L = 0;
  for (let i = 1; i < p.length; i++) L += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  return L;
};

/** Erase short dead-end branches (spurs) from a skeleton. Skeletonising a
 *  right-angle corner throws a diagonal nub into the corner; pruning these
 *  leaves clean centrelines. A spur = a free end (degree-1) whose branch
 *  reaches a junction (degree >=3) within minLen px. Self-contained (walks
 *  from each endpoint), so it doesn't depend on the tracer's node semantics. */
export function pruneSkeletonSpurs(skel, w, h, minLen = 10, iterations = 4) {
  const s = Uint8Array.from(skel);
  const idx = (x, y) => y * w + x;
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : s[idx(x, y)]);
  const nbrs = (x, y) => { const r = []; for (const [dx, dy] of N8) if (at(x + dx, y + dy)) r.push([x + dx, y + dy]); return r; };
  const deg = (x, y) => nbrs(x, y).length;
  for (let it = 0; it < iterations; it++) {
    const endpoints = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (s[idx(x, y)] && deg(x, y) === 1) endpoints.push([x, y]);
    let removed = 0;
    for (const [ex, ey] of endpoints) {
      if (!s[idx(ex, ey)] || deg(ex, ey) !== 1) continue; // changed under us
      const branch = [[ex, ey]];
      let px = -1, py = -1, cx = ex, cy = ey, len = 0, hitJunction = false;
      while (len <= minLen) {
        const cont = nbrs(cx, cy).filter(([a, b]) => !(a === px && b === py));
        if (cont.length !== 1) { if (deg(cx, cy) >= 3) hitJunction = true; break; }
        const [nx, ny] = cont[0];
        len += Math.hypot(nx - cx, ny - cy);
        if (deg(nx, ny) >= 3) { hitJunction = true; break; }   // next is the junction; keep it
        if (deg(nx, ny) === 1) break;                          // isolated 2-endpoint segment, not a spur
        branch.push([nx, ny]);
        px = cx; py = cy; cx = nx; cy = ny;
      }
      if (hitJunction && len < minLen) { for (const [x, y] of branch) { s[idx(x, y)] = 0; removed++; } }
    }
    if (!removed) break;
  }
  return s;
}

/** Trace a 1px skeleton into centerline polylines [[x,y],...] (OPEN, not closed).
 *  Junction clusters (connected blobs of degree>=3 pixels — 8-connected thinning
 *  leaves 2px-wide junctions) collapse to one node at their centroid, so a T
 *  yields 3 edges, not 6. Edges run node->node; ringless loops handled separately. */
export function traceSkeleton(skel, w, h) {
  const idx = (x, y) => y * w + x;
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : skel[idx(x, y)]);
  const nbrs = (x, y) => { const r = []; for (const [dx, dy] of N8) if (at(x + dx, y + dy)) r.push([x + dx, y + dy]); return r; };
  const deg = (x, y) => nbrs(x, y).length;

  // label connected blobs of junction pixels (deg>=3); each blob -> one node at its centroid
  const clusterId = new Int32Array(w * h).fill(-1);
  const reps = [];
  let cid = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!skel[idx(x, y)] || deg(x, y) < 3 || clusterId[idx(x, y)] >= 0) continue;
    let sx = 0, sy = 0, n = 0;
    const stack = [[x, y]]; clusterId[idx(x, y)] = cid;
    while (stack.length) {
      const [cx, cy] = stack.pop(); sx += cx; sy += cy; n++;
      for (const [nx, ny] of nbrs(cx, cy)) if (deg(nx, ny) >= 3 && clusterId[idx(nx, ny)] < 0) { clusterId[idx(nx, ny)] = cid; stack.push([nx, ny]); }
    }
    reps.push([Math.round(sx / n), Math.round(sy / n)]); cid++;
  }
  const clusterOf = (x, y) => clusterId[idx(x, y)];
  const isNode = (x, y) => deg(x, y) === 1 || clusterOf(x, y) >= 0;
  const nodeCoord = (x, y) => (clusterOf(x, y) >= 0 ? reps[clusterOf(x, y)] : [x, y]);

  const consumed = new Uint8Array(w * h); // degree-2 pixels used by an edge
  const seenEdge = new Set();             // dedup edges with no interior (node adjacent to node)
  const polylines = [];

  const walkEdge = (sx, sy, nx, ny) => {
    const path = [nodeCoord(sx, sy)];
    let px = sx, py = sy, cx = nx, cy = ny;
    for (let guard = 0; guard < w * h; guard++) {
      if (isNode(cx, cy)) { path.push(nodeCoord(cx, cy)); return path; }
      consumed[idx(cx, cy)] = 1;
      path.push([cx, cy]);
      const cont = nbrs(cx, cy).filter(([a, b]) => !(a === px && b === py));
      const next = cont.find(([a, b]) => isNode(a, b)) ?? cont.find(([a, b]) => !consumed[idx(a, b)]) ?? cont[0];
      if (!next) return path;
      px = cx; py = cy; cx = next[0]; cy = next[1];
    }
    return path;
  };

  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!skel[idx(x, y)] || !isNode(x, y)) continue;
    const myC = clusterOf(x, y);
    for (const [nx, ny] of nbrs(x, y)) {
      if (myC >= 0 && clusterOf(nx, ny) === myC) continue;        // step within the same junction blob
      if (deg(nx, ny) === 2 && consumed[idx(nx, ny)]) continue;   // edge already traced from its other end
      if (isNode(nx, ny)) {                                       // zero-interior edge: dedup by endpoint pair
        const A = nodeCoord(x, y), B = nodeCoord(nx, ny);
        if (A[0] === B[0] && A[1] === B[1]) continue;
        const ka = `${A[0]},${A[1]}`, kb = `${B[0]},${B[1]}`;
        const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        if (seenEdge.has(key)) continue;
        seenEdge.add(key);
      }
      const p = walkEdge(x, y, nx, ny);
      if (p.length >= 2) polylines.push(p);
    }
  }

  // pure loops (all degree-2, no node) — follow until we return to the start
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!skel[idx(x, y)] || consumed[idx(x, y)] || deg(x, y) !== 2) continue;
    const path = [[x, y]]; consumed[idx(x, y)] = 1;
    let px = -1, py = -1, cx = x, cy = y;
    for (let guard = 0; guard < w * h; guard++) {
      const cont = nbrs(cx, cy).filter(([a, b]) => !(a === px && b === py) && !consumed[idx(a, b)]);
      if (!cont.length) break;
      const [nx, ny] = cont[0]; consumed[idx(nx, ny)] = 1; path.push([nx, ny]);
      px = cx; py = cy; cx = nx; cy = ny;
    }
    path.push([x, y]); // close the loop
    if (path.length >= 3) polylines.push(path);
  }
  // drop degenerate edges: junction blobs spawn tiny walks that loop back into
  // themselves (start node == end node, ~0px) — never real walls.
  return polylines.filter((p) => pathLen(p) >= 2.5);
}

// Clockwise neighbour offsets starting from east, used by border following.
const DX = [1, 1, 0, -1, -1, -1, 0, 1];
const DY = [0, 1, 1, 1, 0, -1, -1, -1];

/**
 * Suzuki-Abe (1985) border following. Returns contours as `[[x,y], ...]`
 * polylines (outer borders CCW, holes CW), filtered to `minArea` by |signed area|.
 * Equivalent in spirit to cv.findContours(RETR_CCOMP, CHAIN_APPROX_NONE).
 */
export function findContours(mask, width, height, minArea = 0) {
  // Labelled image: 0 bg, 1 fg, then border IDs (>=2 / <=-…). Use Int32 padded
  // by 1px so neighbour lookups never go out of bounds.
  const W = width + 2, H = height + 2;
  const f = new Int32Array(W * H);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      f[(y + 1) * W + (x + 1)] = mask[y * width + x] ? 1 : 0;

  const at = (x, y) => f[y * W + x];
  const set = (x, y, v) => { f[y * W + x] = v; };
  const contours = [];
  let nbd = 1;

  for (let y = 1; y <= height; y++) {
    for (let x = 1; x <= width; x++) {
      if (at(x, y) === 0) continue;
      let from = -1; // direction of the starting examined neighbour
      const isOuter = at(x, y) === 1 && at(x - 1, y) === 0;
      const isHole = at(x, y) >= 1 && at(x + 1, y) === 0;
      if (isOuter) from = 4;        // examine west
      else if (isHole) from = 0;    // examine east
      else continue;

      nbd++;
      // --- trace this border ---
      const pts = [];
      let i2x = x + DX[from], i2y = y + DY[from];
      let found = false, dir = 0;
      for (let k = 0; k < 8; k++) {
        dir = (from + 7 - k + 8) % 8; // clockwise from `from`
        const nx = x + DX[dir], ny = y + DY[dir];
        if (at(nx, ny) !== 0) { i2x = nx; i2y = ny; found = true; break; }
      }
      if (!found) {            // isolated pixel
        set(x, y, -nbd);
        pts.push([x - 1, y - 1]);
      } else {
        let i3x = x, i3y = y;
        let i2dx = i2x, i2dy = i2y;
        let guard = 0, maxGuard = width * height * 8 + 16;
        while (guard++ < maxGuard) {
          pts.push([i3x - 1, i3y - 1]);
          // find next 1-or-border pixel counter-clockwise around i3, starting
          // just past the previous examined neighbour
          let startDir = 0;
          for (let d = 0; d < 8; d++)
            if (i3x + DX[d] === i2dx && i3y + DY[d] === i2dy) { startDir = d; break; }
          let nextx = -1, nexty = -1, ndir = 0, crossedRight = false;
          for (let k = 1; k <= 8; k++) {
            ndir = (startDir + k) % 8;            // counter-clockwise
            const nx = i3x + DX[ndir], ny = i3y + DY[ndir];
            if (ndir === 0) crossedRight = false; // east neighbour examined
            if (at(nx, ny) !== 0) { nextx = nx; nexty = ny; break; }
            if (DX[ndir] === 1 && DY[ndir] === 0) crossedRight = true;
          }
          // mark current pixel
          if (at(i3x + 1, i3y) === 0 && crossedRight) set(i3x, i3y, -nbd);
          else if (at(i3x, i3y) === 1) set(i3x, i3y, nbd);
          if (nextx === x && nexty === y && i3x === i2x && i3y === i2y) break; // closed
          i2dx = i3x; i2dy = i3y;
          i3x = nextx; i3y = nexty;
          if (i3x === x && i3y === y) {
            // potential closure on next step; continue one more to confirm
          }
        }
      }
      if (pts.length >= 3 && Math.abs(polygonArea(pts)) >= minArea) contours.push(pts);
    }
  }
  return contours;
}

/** Signed polygon area (shoelace). */
export function polygonArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/** Douglas-Peucker simplification (epsilon in pixels). */
export function simplify(pts, eps) {
  if (pts.length < 3 || eps <= 0) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0, idx = -1;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    for (let i = a + 1; i < b; i++) {
      const d = segDist(pts[i], ax, ay, bx, by);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

function segDist(p, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy;
  if (L2 === 0) return Math.hypot(p[0] - ax, p[1] - ay);
  let t = ((p[0] - ax) * dx + (p[1] - ay) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy));
}
