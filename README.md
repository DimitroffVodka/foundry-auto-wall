# Auto-Wall

Automatically detect walls in a battlemap image and create them as **native Foundry walls** — ones you can drag, edit, and add doors to. Tune the detection, preview it live on the canvas, and commit when it looks right.

- **Foundry compatibility:** v13 minimum, verified on **v14**.
- **Dependencies:** none. Pure client-side JavaScript — no OpenCV, no WASM, nothing to download or freeze the tab.
- **Works on:** the active scene's background image (per-level on multi-level v14 scenes).

---

## Install

1. Copy this folder to `Data/modules/auto-wall/` in your Foundry user data directory, **or** install from a manifest URL pointing at `module.json`.
2. Enable **Auto-Wall** in *Manage Modules* for your world.
3. Open a scene that has a background image.

> Foundry caches the module manifest at **world launch**, so a freshly installed/updated version may not show its new version number until you relaunch the world.

---

## Quick start

1. Open the **Walls** tool in the left toolbar and click the **Auto-Wall** wand (✨), or call `game.modules.get("auto-wall").api.openUI()`.
2. Pick a **Preset** that matches your map (see below), or click **Auto** to let it scan and choose.
3. **Detect** → a green overlay shows what it found. Click any green shape to delete a bad detection (Ctrl+Z to undo).
4. **Preview Walls** → a yellow overlay shows the walls it will create. Adjust the Wall sliders and preview again.
5. **Create Walls** → commits the yellow preview as real Foundry walls.

The three buttons map to three stages: **Detect** finds wall *shapes*, **Preview Walls** turns them into wall *segments*, **Create Walls** writes them to the scene.

---

## Single Wall (centerline) — the double-wall fix

By default, detection traces the **outline** of the ink. A thick drawn wall has two edges, so you get **two parallel walls** (one inside, one outside). Turn on **Single Wall (centerline)** and Auto-Wall instead thins each wall to its 1-pixel skeleton and traces *that*, placing **one wall down the middle**.

Centerline mode has two cleanup knobs, and **you use one or the other depending on how the walls are drawn**:

| Your walls are… | Use | Why |
|---|---|---|
| **Solid black**, with stipple/rubble dots on the floor | **Despeckle** (start ~300) | Removes black blobs smaller than N px so floor dots don't skeletonise into fake walls. Raise until the dots are gone; too high deletes short real walls. |
| **Drawn as outlines / hollow** (two strokes with space between) | **Wall Fill** (~half the wall thickness) | Fuses the two strokes into one solid band before thinning, so each wall yields a single centerline. |

For most hand-drawn maps the walls are solid, so **Despeckle is the one you want** and Wall Fill stays at 0. The **Hand-drawn B&W (grid)** preset turns centerline + despeckle on for you.

> Very wide, irregular *blobby* areas (organic cave fill) skeletonise into branches — a blob's medial axis genuinely branches. Those areas are better left to outline mode (centerline off).

---

## Presets

Pick from the dropdown, or **Save** the current settings as your own named preset (marked ★, deletable). **Auto** scans the map and picks one.

| Preset | For |
|---|---|
| **Hand-drawn B&W (grid)** | Black line-art maps on a printed grid. Centerline + despeckle on, hatching/grid removal on. |
| **Caves / Organic (no grid)** | Natural cave outlines, no grid. |
| **Clean Digital Map** | Crisp digital maps with solid wall colors. |
| **High Detail** | Higher resolution + finer subdivision for intricate maps. |

---

## Settings reference

### Detection — *what counts as a wall*

| Setting | Meaning |
|---|---|
| **Single Wall (centerline)** | One wall down the middle of each drawn wall instead of tracing both edges. Fixes double walls. |
| **Despeckle (centerline)** | Remove black blobs smaller than this many px — kills floor stipple/rubble. 0 = off. |
| **Wall Fill (centerline)** | For walls drawn as hollow outlines: fuse them solid before thinning (~half the wall thickness). Leave 0 for solid walls. |
| **Color Threshold** | How close a pixel must be to the wall color to count. Lower = only the darkest ink; higher also grabs the grey grid. |
| **Min Area %** | Ignore detected shapes smaller than this % of the image (drops speckle and dots). |
| **Detect Resolution** | Pixel resolution walls are detected at. Higher = more detail but slower; ~4000 suits most maps. |
| **Remove Grid / Hatching** | Erase thin lines that share the wall color (printed grid, pen hatching) before tracing. |
| **Grid / Hatching Width** | Max thickness (px) of lines to erase as grid/hatching; anything thicker is kept. |
| **Mask Cleanup** | Close tiny holes and remove isolated speckle for smoother, less fragmented walls. |
| **Edge Margin** | Ignore geometry within this many px of the image border (so the page/frame edge isn't traced). |

### Walls — *how shapes become wall segments*

| Setting | Meaning |
|---|---|
| **Simplify (px)** | How far a wall may deviate from the exact outline when smoothing (**not** thickness). Higher = straighter walls, fewer points. |
| **Max Wall Length** | Splits long walls into segments. Straight runs re-merge regardless, so this mainly controls how finely **curves** are subdivided. |
| **Merge Distance** | Weld wall endpoints within this distance so corners connect. Too high collapses walls into blobs. |
| **Max Gap Connect** | Bridge straight gaps up to this distance to close small openings (e.g. door breaks). |
| **Angle Tolerance** | Allowed angle difference when merging straight walls. 0 keeps curves intact while straight runs still merge. |

---

## After you create walls

- The result is **native Foundry walls** — select, drag, split, and convert any to doors as usual.
- **Clear** removes only the walls Auto-Wall generated; **hand-drawn and door walls are preserved**. Re-running Create Walls also keeps your doors.
- On **multi-level v14 scenes**, walls are scoped to the level whose background was detected, and Clear is level-aware.

---

## Macro / MCP API

Everything in the panel is also on `game.modules.get("auto-wall").api`, so it can be driven from macros or a Foundry MCP bridge via `call_module_api`:

| Function | Description |
|---|---|
| `openUI()` | Open the settings panel. |
| `getParams()` / `setParams(patch)` | Read / merge detection params. |
| `presets()` / `currentPreset()` | List presets / current selection. |
| `applyPreset(name)` / `autoPreset()` | Apply a named preset / auto-pick one. |
| `savePreset(name)` / `deletePreset(name)` | Manage custom presets (world-scoped). |
| `detect(patch?)` | Run detection; draws the green preview. |
| `generate(patch?)` | Build wall segments; draws the yellow preview. |
| `createWalls({clear=true})` | Commit walls to the scene. |
| `clearWalls()` / `clearPreview()` | Remove generated walls / clear the overlay. |
| `deleteContour(i)` / `undoDelete()` | Delete a detected shape / undo. |

Each call returns `{ ok, ... }` (or `{ ok: false, error }`).

---

## How it works

All image processing is plain JavaScript on a canvas `ImageData` buffer, so it runs the same in the browser and in Node (which is how it's tested):

1. **Color mask** — pixels within the threshold of the wall color (alpha-aware).
2. **Cleanup** — separable prefix-sum morphology (open/close) to fill holes and drop speckle; optional grid/hatching removal.
3. **Trace** — either Suzuki-Abe contour following (outline mode) **or** Zhang-Suen thinning → skeleton tracing (centerline mode), with junction-cluster collapsing and spur pruning. Centerline thinning runs at a capped resolution and scales back up (~8× faster on large maps).
4. **Wall-gen** — Douglas-Peucker simplify, length splitting, endpoint welding, and collinear merging (a perpendicular-distance gate keeps parallel walls from merging into diagonals).
5. **Commit** — working-image pixels mapped into scene coordinates and written as `WallDocument`s.

The canvas overlay is drawn with PIXI (v7.4.3) above the walls layer.

---

## Development

The image core (`scripts/detect-core.js`, `scripts/wallgen.js`) is DOM-free, so it can be unit-tested in Node — copy a file to `*.mjs` and import it. Detection runs identically in the browser (canvas `ImageData`) and in Node, which keeps the geometry honest.

## Credits

Inspired by — and sharing the name and spirit of — the original **[Auto-Wall](https://github.com/ThreeHats/auto-wall)** desktop tool by **ThreeHats**, which is MIT licensed. This is an independent Foundry VTT module: the detection and wall-generation code is a from-scratch reimplementation in JavaScript, but the idea, the name, and much of the workflow come straight from that project. If this is useful to you, go star the original too.

## License

MIT — see [LICENSE](LICENSE). Carries the original Auto-Wall copyright (© 2025 ThreeHats) alongside this module's (© 2026 DimitroffVodka).
