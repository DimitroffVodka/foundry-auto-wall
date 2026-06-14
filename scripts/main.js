/**
 * Auto-Wall — Foundry module entry point.
 *
 * Detects walls in the active scene's background image (OpenCV.js, in-browser)
 * and creates them as native Foundry WallDocuments. Exposes a `module.api` so the
 * Foundry MCP can drive it via call_module_api.
 *
 * Step 1 scaffold: module loads, adds a Walls-toolbar button, exposes api.ping.
 */
import { detectContours, scanScene } from "./detect.js";
import { PRESETS, PRESET_NAMES, autoPreset as pickPreset } from "./presets.js";
import { contoursToWalls } from "./wallgen.js";
import { segmentsToWallData, createWalls, clearAutoWalls } from "./foundry-walls.js";
import { AutoWallApp } from "./auto-wall-app.js";
import { drawPreview, clearPreview } from "./overlay.js";

/** Map working-image pixel coords to scene (canvas) coords for the active scene. */
function sceneMapper(det) {
  const dim = canvas.scene.dimensions;
  const sx = dim.sceneX ?? 0, sy = dim.sceneY ?? 0;
  const sw = dim.sceneWidth ?? dim.width, sh = dim.sceneHeight ?? dim.height;
  const fx = sw / det.width, fy = sh / det.height;
  return (x, y) => [sx + x * fx, sy + y * fy];
}

/** Draw the current detection as a clickable green overlay (click a contour to
 *  delete it, like desktop Detect mode), redrawing after each delete. */
function drawDetectionPreview() {
  if (!canvas?.scene || !state.detection) { clearPreview(); return; }
  const det = state.detection;
  const m = sceneMapper(det);
  drawPreview({
    contours: det.contours.map((c) => c.map(([x, y]) => m(x, y))),
    open: !!det.open,
    onContourClick: (i) => deleteContourAt(i),
  });
}

/** Delete contour i, recording it for Ctrl+Z undo. */
function deleteContourAt(i) {
  const det = state.detection;
  if (!det || i < 0 || i >= det.contours.length) return false;
  state.detectUndo.push({ index: i, contour: det.contours[i] });
  det.contours.splice(i, 1);
  state.walls = null;
  drawDetectionPreview();
  panel?.note?.(`${det.contours.length} contours`);
  return true;
}

/** Undo the most recent contour delete (Ctrl+Z). */
function undoDetectDelete() {
  const det = state.detection;
  if (!det || !state.detectUndo.length) return false;
  const { index, contour } = state.detectUndo.pop();
  det.contours.splice(Math.min(index, det.contours.length), 0, contour);
  state.walls = null;
  drawDetectionPreview();
  panel?.note?.(`${det.contours.length} contours (undid delete)`);
  return true;
}

const MOD = "auto-wall";

function log(...a) { console.log(`%c${MOD}`, "color:#4ea1ff", "|", ...a); }
function err(...a) { console.error(`${MOD} |`, ...a); }

/** Module runtime state (last detection + current params). */
const state = { params: null, detection: null, walls: null, detectUndo: [], preset: "" };

const getCustomPresets = () => game.settings.get(MOD, "customPresets") ?? {};
const allPresetNames = () => [...PRESET_NAMES, ...Object.keys(getCustomPresets())];
const resolvePreset = (name) => PRESETS[name] ?? getCustomPresets()[name] ?? null;

/** Single settings-panel instance (re-clicking the toolbar focuses it). */
let panel = null;

Hooks.once("init", () => {
  log("init");
  const mod = game.modules.get(MOD);
  // API surface — fleshed out in later steps. Stubs return a clear status now so
  // call_module_api wiring can be verified end-to-end before the real work lands.
  state.params = foundry.utils.deepClone(DEFAULT_PARAMS);

  // Persisted user presets (named param sets the user saves).
  game.settings.register(MOD, "customPresets", {
    scope: "world", config: false, type: Object, default: {},
  });

  // Ctrl+Z undoes a detection-contour delete while the green preview is active.
  game.keybindings.register(MOD, "undoDetectDelete", {
    name: "Auto-Wall: Undo detection delete",
    hint: "Restores the last contour deleted in the Detect preview.",
    editable: [{ key: "KeyZ", modifiers: ["Control"] }],
    onDown: () => {
      if (canvas?.__autoWallPreview && state.detectUndo.length) {
        undoDetectDelete();
        return true; // consume — prevent core undo
      }
      return false; // not our context — let other handlers run
    },
    precedence: CONST.KEYBINDING_PRECEDENCE.PRIORITY,
  });

  mod.api = {
    ping: () => ({ ok: true, module: MOD, version: mod.version, foundry: game.version }),
    getParams: () => foundry.utils.deepClone(state.params),
    setParams: (patch = {}) => {
      state.params = foundry.utils.mergeObject(state.params, patch, { inplace: false });
      state.preset = ""; // manual tweak -> no longer matches a preset
      return foundry.utils.deepClone(state.params);
    },
    presets: () => allPresetNames().map((name) => ({ name, custom: !PRESETS[name] })),
    currentPreset: () => state.preset,
    applyPreset: (name) => {
      const preset = resolvePreset(name);
      if (!preset) return { ok: false, error: `unknown preset: ${name}` };
      state.params = foundry.utils.mergeObject(state.params, preset, { inplace: false });
      state.preset = name;
      return { ok: true, preset: name, params: foundry.utils.deepClone(state.params) };
    },
    autoPreset: async () => {
      if (!canvas?.scene) return { ok: false, error: "no active scene" };
      try {
        const stats = await scanScene();
        const name = pickPreset(stats);
        state.params = foundry.utils.mergeObject(state.params, PRESETS[name], { inplace: false });
        state.preset = name;
        return { ok: true, preset: name, stats, params: foundry.utils.deepClone(state.params) };
      } catch (e) { err("autoPreset", e); return { ok: false, error: String(e?.message ?? e) }; }
    },
    savePreset: async (name) => {
      name = String(name ?? "").trim();
      if (!name) return { ok: false, error: "name required" };
      if (PRESETS[name]) return { ok: false, error: "name clashes with a built-in preset" };
      const custom = getCustomPresets();
      const params = foundry.utils.deepClone(state.params);
      custom[name] = params;
      await game.settings.set(MOD, "customPresets", custom);
      state.preset = name;
      return { ok: true, preset: name, presets: allPresetNames() };
    },
    deletePreset: async (name) => {
      const custom = getCustomPresets();
      if (!(name in custom)) return { ok: false, error: "not a custom preset" };
      delete custom[name];
      await game.settings.set(MOD, "customPresets", custom);
      if (state.preset === name) state.preset = "";
      return { ok: true, presets: allPresetNames() };
    },
    detect: async (patch = {}) => {
      if (!canvas?.scene) return { ok: false, error: "no active scene" };
      const params = foundry.utils.mergeObject(state.params, patch, { inplace: false });
      state.params = params;
      try {
        const t0 = performance.now();
        const det = await detectContours(params);
        state.detection = det;
        state.walls = null;
        state.detectUndo = []; // fresh detection -> reset undo history
        drawDetectionPreview(); // clickable green contour preview
        const totalPts = det.contours.reduce((n, c) => n + c.length, 0);
        return {
          ok: true,
          contours: det.contours.length,
          points: totalPts,
          working: { width: det.width, height: det.height },
          natural: { width: det.naturalWidth, height: det.naturalHeight },
          ms: Math.round(performance.now() - t0),
        };
      } catch (e) {
        err("detect", e);
        return { ok: false, error: String(e?.message ?? e) };
      }
    },
    generate: async (patch = {}) => {
      if (!state.detection) return { ok: false, error: "run detect first" };
      const params = foundry.utils.mergeObject(state.params, patch, { inplace: false });
      state.params = params;
      try {
        const t0 = performance.now();
        const segs = contoursToWalls(state.detection.contours, { ...params, open: !!state.detection.open });
        state.walls = segs;
        // yellow wall preview on the canvas (replaces the green contour preview)
        const m = sceneMapper(state.detection);
        drawPreview({ walls: segs.map((s) => ({ a: m(s.a[0], s.a[1]), b: m(s.b[0], s.b[1]) })) });
        return { ok: true, walls: segs.length, ms: Math.round(performance.now() - t0) };
      } catch (e) { err("generate", e); return { ok: false, error: String(e?.message ?? e) }; }
    },
    createWalls: async ({ clear = true } = {}) => {
      if (!canvas?.scene) return { ok: false, error: "no active scene" };
      if (!state.walls?.length) return { ok: false, error: "run generate first" };
      try {
        const data = segmentsToWallData(state.walls, state.detection, canvas.scene);
        const cleared = clear ? await clearAutoWalls(canvas.scene, state.detection.levelId) : 0;
        const created = await createWalls(canvas.scene, data);
        clearPreview(); // committed -> remove the candidate overlay
        return { ok: true, created, cleared };
      } catch (e) { err("createWalls", e); return { ok: false, error: String(e?.message ?? e) }; }
    },
    clearWalls: async () => {
      if (!canvas?.scene) return { ok: false, error: "no active scene" };
      clearPreview();
      const cleared = await clearAutoWalls(canvas.scene);
      return { ok: true, cleared };
    },
    clearPreview: () => { clearPreview(); return { ok: true }; },
    deleteContour: (i) => {
      if (!state.detection) return { ok: false, error: "run detect first" };
      if (!deleteContourAt(i)) return { ok: false, error: "bad index" };
      return { ok: true, contours: state.detection.contours.length };
    },
    undoDelete: () => ({ ok: undoDetectDelete(), contours: state.detection?.contours.length ?? 0 }),
    openUI: () => openAutoWall(),
  };
});

Hooks.once("ready", () => {
  log(`ready — Foundry ${game.version}, world "${game.world.id}"`);
});

// Switching scenes (or the canvas re-drawing) invalidates a stale detection so we
// never create one scene's walls onto another.
Hooks.on("canvasReady", () => {
  state.detection = null;
  state.walls = null;
  state.detectUndo = [];
  clearPreview();
  panel?.note?.("scene changed — Detect again");
});

// Add a button to the Walls scene-control toolbar (v13/v14: controls + tools are
// objects keyed by name).
Hooks.on("getSceneControlButtons", (controls) => {
  try {
    const walls = controls.walls;
    if (!walls?.tools) return;
    walls.tools[MOD] = {
      name: MOD,
      title: "Auto-Wall: detect walls",
      icon: "fa-solid fa-wand-magic-sparkles",
      button: true,
      order: 99,
      onChange: () => openAutoWall(),
    };
  } catch (e) {
    err("getSceneControlButtons", e);
  }
});

function openAutoWall() {
  if (!canvas?.scene) {
    ui.notifications?.warn("Auto-Wall: open a scene first.");
    return;
  }
  if (!panel) panel = new AutoWallApp();
  panel.render({ force: true });
}

/** Default detection/export params (mirrors the tuned desktop presets). */
export const DEFAULT_PARAMS = {
  mode: "color",
  wallColor: [0, 0, 0],
  colorThreshold: 20,
  minAreaPct: 0.02,
  workingDimension: 4000,
  // single wall down the middle of each drawn wall (skeleton), not two edge outlines
  centerline: false,
  // centerline only: remove black blobs smaller than this many px (floor stipple /
  // rubble dots) before thinning, so they don't skeletonise into fake walls
  despeckle: 300,
  // centerline only: close radius (px) to fuse walls DRAWN AS OUTLINES/hollow into
  // one solid band before thinning. Leave 0 for solid-black walls.
  wallFill: 0,
  // detection cleanup / parity
  maskCleanup: true,
  removeHatching: false,
  hatchingMaxWidth: 3,
  edgeMargin: 0,
  // wall-gen (working-image pixels)
  simplifyPx: 2,
  maxWallLength: 300,
  mergeDistance: 24,
  angleTolerance: 0,
  maxGap: 24,
};
