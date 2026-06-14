/**
 * Auto-Wall — detection/wall presets (module param space) + auto-pick heuristic.
 * Ported from the tuned desktop presets; distances are in working-image pixels.
 */
export const PRESETS = {
  "Hand-drawn B&W (grid)": {
    mode: "color", wallColor: [0, 0, 0], colorThreshold: 18, minAreaPct: 0.02,
    workingDimension: 4000, maskCleanup: true, removeHatching: true, hatchingMaxWidth: 3,
    edgeMargin: 2, simplifyPx: 2, maxWallLength: 90, mergeDistance: 24, angleTolerance: 0, maxGap: 24,
    // single wall down the middle; despeckle drops floor stipple (solid-black walls)
    centerline: true, despeckle: 300, wallFill: 0,
  },
  "Caves / Organic (no grid)": {
    mode: "color", wallColor: [0, 0, 0], colorThreshold: 20, minAreaPct: 0.02,
    workingDimension: 4000, maskCleanup: true, removeHatching: false, hatchingMaxWidth: 3,
    edgeMargin: 0, simplifyPx: 2, maxWallLength: 90, mergeDistance: 24, angleTolerance: 0, maxGap: 24,
  },
  "Clean Digital Map": {
    mode: "color", wallColor: [0, 0, 0], colorThreshold: 35, minAreaPct: 0.02,
    workingDimension: 4000, maskCleanup: false, removeHatching: false, hatchingMaxWidth: 3,
    edgeMargin: 0, simplifyPx: 1, maxWallLength: 120, mergeDistance: 12, angleTolerance: 0, maxGap: 12,
  },
  "High Detail": {
    mode: "color", wallColor: [0, 0, 0], colorThreshold: 20, minAreaPct: 0.01,
    workingDimension: 5000, maskCleanup: true, removeHatching: true, hatchingMaxWidth: 3,
    edgeMargin: 2, simplifyPx: 1, maxWallLength: 80, mergeDistance: 16, angleTolerance: 0, maxGap: 16,
  },
};

export const PRESET_NAMES = Object.keys(PRESETS);

/** Pick the best preset from a cheap scene scan ({darkFraction, saturation, gridScore}).
 *  Robust rule: colored maps -> digital preset; B&W maps -> grid preset, since
 *  thin-line (hatching) removal is safe even when there's no grid and is usually
 *  wanted on hand-drawn scans. (gridScore from a darkness profile is unreliable —
 *  printed grids are lighter than the black walls — so we don't gate on it.) */
export function autoPreset(stats) {
  if (!stats) return "Hand-drawn B&W (grid)";
  if (stats.saturation > 0.18) return "Clean Digital Map";  // colored map
  return "Hand-drawn B&W (grid)";                          // B&W line art
}
