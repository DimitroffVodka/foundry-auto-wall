/**
 * Auto-Wall — canvas preview overlay (PIXI, Foundry v14 / PIXI v8).
 *
 * Sits above the walls layer (canvas.interface, zIndex 710), in SCENE coords.
 *  - Green polylines = detected contours. When `onContourClick` is given they are
 *    interactive: hover highlights red, click removes that contour (delete bad
 *    detections, like desktop Detect mode).
 *  - Yellow segments = candidate walls (non-interactive).
 * Fully cleared/redrawn each call.
 */
const KEY = "__autoWallPreview";

const GREEN = 0x33ff33;
const RED = 0xff4444;
const YELLOW = 0xffd000;

/** Squared distance from (px,py) to segment (ax,ay)-(bx,by). */
function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx, cy = ay + t * dy;
  return (px - cx) ** 2 + (py - cy) ** 2;
}

/** A hitArea that only registers near the contour's OUTLINE (within `tol` px),
 *  so clicking inside a room doesn't select the big enclosing contour. For open
 *  centerlines the closing segment is omitted. */
function nearLineHitArea(poly, tol, open = false) {
  const t2 = tol * tol;
  const n = open ? poly.length - 1 : poly.length;
  return {
    contains(x, y) {
      for (let i = 0; i < n; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        if (segDist2(x, y, a[0], a[1], b[0], b[1]) <= t2) return true;
      }
      return false;
    },
  };
}

function polyArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function strokePoly(g, poly, color, alpha, width, open = false) {
  g.lineStyle({ width, color, alpha });
  g.moveTo(poly[0][0], poly[0][1]);
  for (let i = 1; i < poly.length; i++) g.lineTo(poly[i][0], poly[i][1]);
  if (!open) g.lineTo(poly[0][0], poly[0][1]); // closed contours loop back; centerlines don't
}

export function clearPreview() {
  const c = canvas?.[KEY];
  if (c) {
    c.parent?.removeChild(c);
    c.destroy({ children: true });
    canvas[KEY] = null;
  }
}

/**
 * @param {object} data
 * @param {number[][][]} [data.contours] polylines [[x,y],...] in scene coords
 * @param {{a:number[],b:number[]}[]} [data.walls] segments in scene coords
 * @param {(index:number)=>void} [data.onContourClick] makes contours clickable;
 *        called with the ORIGINAL contour index to delete.
 * @param {boolean} [data.open] contours are open centerlines (don't close them).
 */
export function drawPreview({ contours = [], walls = [], onContourClick = null, open = false } = {}) {
  clearPreview();
  if (!canvas?.interface) return;

  const container = new PIXI.Container();
  container.name = "auto-wall-preview";
  container.zIndex = 710;
  container.sortableChildren = true;
  container.eventMode = onContourClick ? "passive" : "none";
  canvas.interface.sortableChildren = true;
  canvas.interface.addChild(container);
  canvas[KEY] = container;

  if (onContourClick && contours.length) {
    // Smaller contours on top so clicks land on the most specific shape.
    const order = contours
      .map((c, i) => ({ i, area: Math.abs(polyArea(c)) }))
      .sort((a, b) => b.area - a.area);
    let z = 0;
    for (const { i } of order) {
      const poly = contours[i];
      if (poly.length < 2) continue;
      const g = new PIXI.Graphics();
      g.zIndex = z++;
      g.eventMode = "static";
      g.cursor = "pointer";
      strokePoly(g, poly, GREEN, 0.85, 2, open);
      g.hitArea = nearLineHitArea(poly, 12, open); // clickable only near the outline
      g.on("pointerover", () => { g.clear(); strokePoly(g, poly, RED, 1, 4, open); });
      g.on("pointerout", () => { g.clear(); strokePoly(g, poly, GREEN, 0.85, 2, open); });
      g.on("pointerdown", (ev) => { ev.stopPropagation?.(); onContourClick(i); });
      container.addChild(g);
    }
    container.sortChildren();
    return;
  }

  // Non-interactive: green contours + yellow walls in one graphics.
  const g = new PIXI.Graphics();
  for (const poly of contours) if (poly.length >= 2) strokePoly(g, poly, GREEN, 0.85, 2, open);
  for (const s of walls) {
    g.lineStyle({ width: 3, color: YELLOW, alpha: 0.95 });
    g.moveTo(s.a[0], s.a[1]).lineTo(s.b[0], s.b[1]);
  }
  if (walls.length) {
    g.lineStyle({ width: 0 });
    g.beginFill(YELLOW, 0.9);
    for (const s of walls) { g.drawCircle(s.a[0], s.a[1], 3); g.drawCircle(s.b[0], s.b[1], 3); }
    g.endFill();
  }
  container.addChild(g);
}
