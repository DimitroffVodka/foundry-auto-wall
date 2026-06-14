/**
 * Auto-Wall — wall generation (pure JS, ported from the tuned desktop pipeline).
 *
 * contours (polylines in working-image px) -> wall segments {a:[x,y], b:[x,y]}:
 *   1. Douglas-Peucker simplify (absolute px — avoids the fraction-of-arclength
 *      chording the desktop app suffered).
 *   2. split long edges by maxWallLength.
 *   3. weld nearby endpoints (mergeDistance) so corners share vertices.
 *   4. merge collinear runs (angleTolerance=0 keeps straight walls merged without
 *      chording curves) and bridge small straight gaps (maxGap).
 * All distances are in working-image pixels.
 */
import { simplify } from "./detect-core.js";

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Perpendicular distance from point p to the infinite line through a-b. */
function perpDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return dist(p, a);
  return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len;
}

// Max perpendicular offset (working px) for two same-angle segments to count as
// collinear (on the SAME line). Without this, parallel walls (e.g. the two sides
// of a thin corridor) whose endpoints are near merge into a diagonal.
const COLLINEAR_TOL = 3;

function splitEdge(out, a, b, maxLen) {
  const d = dist(a, b);
  if (d < 1) return;
  if (maxLen > 0 && d > maxLen) {
    const n = Math.ceil(d / maxLen);
    for (let j = 0; j < n; j++) {
      const t0 = j / n, t1 = (j + 1) / n;
      out.push({
        a: [a[0] + t0 * (b[0] - a[0]), a[1] + t0 * (b[1] - a[1])],
        b: [a[0] + t1 * (b[0] - a[0]), a[1] + t1 * (b[1] - a[1])],
      });
    }
  } else {
    out.push({ a: [a[0], a[1]], b: [b[0], b[1]] });
  }
}

/** Weld all endpoints within `radius` to a shared cluster centroid. */
function weldEndpoints(segs, radius) {
  if (radius <= 0) return segs;
  const pts = [];
  for (const s of segs) { pts.push(s.a, s.b); }
  const cell = Math.max(radius, 1e-6);
  const buckets = new Map();
  const key = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  pts.forEach((p, i) => {
    const k = key(p[0], p[1]);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(i);
  });
  const parent = pts.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  const r2 = radius * radius;
  for (const [k, members] of buckets) {
    const [bx, by] = k.split(",").map(Number);
    const neigh = [];
    for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
      const nb = buckets.get(`${bx + ox},${by + oy}`);
      if (nb) neigh.push(...nb);
    }
    for (const i of members) for (const j of neigh) {
      if (j <= i) continue;
      if ((i >> 1) === (j >> 1)) continue; // never weld a wall's own two endpoints (would zero it)
      const dx = pts[i][0] - pts[j][0], dy = pts[i][1] - pts[j][1];
      if (dx * dx + dy * dy <= r2) union(i, j);
    }
  }
  const sum = new Map();
  for (let i = 0; i < pts.length; i++) {
    const r = find(i);
    const e = sum.get(r) || [0, 0, 0];
    e[0] += pts[i][0]; e[1] += pts[i][1]; e[2]++;
    sum.set(r, e);
  }
  const centroid = (i) => { const e = sum.get(find(i)); return [e[0] / e[2], e[1] / e[2]]; };
  const out = [];
  const seen = new Set();
  for (let s = 0; s < segs.length; s++) {
    const a = centroid(2 * s), b = centroid(2 * s + 1);
    if (dist(a, b) < 2) continue;
    const k = [a, b].map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).sort().join("|");
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ a, b });
  }
  return out;
}

const angleOf = (s) => {
  let ang = (Math.atan2(s.b[1] - s.a[1], s.b[0] - s.a[0]) * 180 / Math.PI) % 180;
  if (ang < 0) ang += 180;
  return ang;
};

/** Merge collinear segments whose endpoints are within `maxGap`. angleTol=0 ->
 *  only perfectly-aligned (straight) walls merge; curves are left alone. */
export function mergeCollinear(segs, angleTol, maxGap) {
  if (angleTol <= 0 && maxGap <= 0) return segs;
  let work = segs.slice();
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 50) {
    changed = false;
    const used = new Array(work.length).fill(false);
    const out = [];
    for (let i = 0; i < work.length; i++) {
      if (used[i]) continue;
      let cur = work[i];
      used[i] = true;
      let merged = true;
      while (merged) {
        merged = false;
        for (let j = 0; j < work.length; j++) {
          if (used[j]) continue;
          const o = work[j];
          const ends = [
            [cur.b, o.a], [cur.b, o.b], [cur.a, o.a], [cur.a, o.b],
          ];
          let near = false;
          for (const [p, q] of ends) if (dist(p, q) <= maxGap) { near = true; break; }
          if (!near) continue;
          let ad = Math.abs(angleOf(cur) - angleOf(o));
          ad = Math.min(ad, 180 - ad);
          const ok = angleTol <= 0 ? ad < 0.01 : ad <= angleTol;
          if (!ok) continue;
          // collinearity: o's endpoints must lie on cur's infinite line, not just
          // share its angle — prevents parallel walls merging into a diagonal.
          if (perpDist(o.a, cur.a, cur.b) > COLLINEAR_TOL ||
              perpDist(o.b, cur.a, cur.b) > COLLINEAR_TOL) continue;
          // merge: take the two farthest endpoints
          const all = [cur.a, cur.b, o.a, o.b];
          let best = 0, bi = 0, bj = 1;
          for (let m = 0; m < 4; m++) for (let n = m + 1; n < 4; n++) {
            const d = dist(all[m], all[n]); if (d > best) { best = d; bi = m; bj = n; }
          }
          cur = { a: all[bi], b: all[bj] };
          used[j] = true; merged = true; changed = true;
        }
      }
      out.push(cur);
    }
    work = out;
  }
  return work;
}

export function contoursToWalls(contours, params) {
  const eps = params.simplifyPx ?? 1.5;
  const open = !!params.open; // centerline polylines are open paths, not closed loops
  let segs = [];
  for (const c of contours) {
    const pts = simplify(c, eps);
    if (pts.length < (open ? 2 : 3)) continue;
    const last = open ? pts.length - 1 : pts.length; // open: stop before wrapping back to pts[0]
    for (let i = 0; i < last; i++) splitEdge(segs, pts[i], pts[(i + 1) % pts.length], params.maxWallLength);
  }
  segs = weldEndpoints(segs, params.mergeDistance);
  segs = mergeCollinear(segs, params.angleTolerance, params.maxGap);
  return segs;
}
