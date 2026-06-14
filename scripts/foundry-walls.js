/**
 * Auto-Wall — turn wall segments into native Foundry WallDocuments.
 *
 * Maps working-image pixel coordinates into the scene's canvas coordinate space
 * (accounting for scene padding via scene.dimensions) and creates walls flagged
 * as auto-generated so they can be cleared/regenerated without touching the
 * user's hand-drawn walls.
 */
const MOD = "auto-wall";

/** Map detection-space segments to WallDocument creation data in scene coords. */
export function segmentsToWallData(segs, det, scene) {
  const dim = scene.dimensions;
  // v13/v14: sceneX/sceneY = top-left of the background rect inside the padded
  // canvas; sceneWidth/sceneHeight = its size.
  const sx = dim.sceneX ?? 0, sy = dim.sceneY ?? 0;
  const sw = dim.sceneWidth ?? dim.width, sh = dim.sceneHeight ?? dim.height;
  const fx = sw / det.width, fy = sh / det.height;
  // Assign to the level we detected on (empty = all levels — wrong for multi-level).
  const levels = det?.levelId ? [det.levelId] : [];
  return segs.map((s) => ({
    c: [
      Math.round(sx + s.a[0] * fx), Math.round(sy + s.a[1] * fy),
      Math.round(sx + s.b[0] * fx), Math.round(sy + s.b[1] * fy),
    ],
    levels,
    flags: { [MOD]: { generated: true } },
  }));
}

/** Delete previously auto-generated walls (leaves manual walls AND any generated
 *  wall the user turned into a door). When `levelId` is given, only clears walls
 *  on that level (empty `levels` = all levels), so regenerating one floor doesn't
 *  wipe another. */
export async function clearAutoWalls(scene, levelId = null) {
  const onLevel = (w) => {
    if (!levelId) return true;
    const lv = w.levels ?? [];
    return lv.length === 0 || lv.includes(levelId);
  };
  const ids = scene.walls
    .filter((w) => w.getFlag(MOD, "generated") && !w.door && onLevel(w))
    .map((w) => w.id);
  if (ids.length) await scene.deleteEmbeddedDocuments("Wall", ids);
  return ids.length;
}

/** Create the walls on the scene (chunked to stay under document-op limits). */
export async function createWalls(scene, wallData) {
  let created = 0;
  const CHUNK = 500;
  for (let i = 0; i < wallData.length; i += CHUNK) {
    const batch = wallData.slice(i, i + CHUNK);
    const docs = await scene.createEmbeddedDocuments("Wall", batch);
    created += docs.length;
  }
  return created;
}
