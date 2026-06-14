/**
 * Auto-Wall settings panel — ApplicationV2 + HandlebarsApplicationMixin (v14.364).
 *
 * Generic controls (range+number, checkbox) with per-setting tooltips, a preset
 * dropdown + Auto scan, and the Detect/Preview/Create/Clear flow. Reads/writes
 * params via game.modules.get("auto-wall").api. Live readouts update the paired
 * number field without re-rendering; commits go through setParams on change.
 */
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const MOD = "auto-wall";

/** All tunable controls. group: "detection" | "walls". */
const CONTROLS = [
  { key: "centerline", label: "Single Wall (centerline)", group: "detection", checkbox: true,
    tip: "Place ONE wall down the middle of each drawn wall instead of tracing both edges — fixes the double-wall (inner + outer) problem on hand-drawn maps. Best for solid black walls." },
  { key: "despeckle", label: "Despeckle (centerline)", group: "detection", min: 0, max: 2000, step: 25, decimals: 0,
    tip: "Centerline only: remove black blobs smaller than this many pixels — kills floor stipple / rubble dots that would otherwise become fake walls in open space. Raise until the dots are gone; too high deletes short real walls. 0 = off." },
  { key: "wallFill", label: "Wall Fill (centerline)", group: "detection", min: 0, max: 40, step: 1, decimals: 0,
    tip: "Centerline only: for walls DRAWN AS OUTLINES (two strokes / hollow). Fuses them into one solid band before thinning so each yields a single centerline (~half the wall thickness). Leave 0 for solid-black walls." },
  { key: "colorThreshold", label: "Color Threshold", group: "detection", min: 0, max: 100, step: 1, decimals: 0,
    tip: "How close a pixel must be to the wall colour to count. Lower = only the darkest walls; higher also grabs the grey grid." },
  { key: "minAreaPct", label: "Min Area %", group: "detection", min: 0, max: 1, step: 0.01, decimals: 2,
    tip: "Ignore detected shapes smaller than this % of the image — drops stipple speckle and dots." },
  { key: "workingDimension", label: "Detect Resolution", group: "detection", min: 1000, max: 8000, step: 500, decimals: 0,
    tip: "Pixel resolution walls are detected at. Higher = more detail but slower; ~4000 suits most maps." },
  { key: "removeHatching", label: "Remove Grid / Hatching", group: "detection", checkbox: true,
    tip: "Erase thin lines that share the wall colour (printed grid, pen hatching) before tracing, so they aren't detected as walls." },
  { key: "hatchingMaxWidth", label: "Grid / Hatching Width", group: "detection", min: 1, max: 12, step: 1, decimals: 0,
    tip: "Max thickness (px) of lines to erase as grid/hatching; anything thicker is kept as a wall." },
  { key: "maskCleanup", label: "Mask Cleanup", group: "detection", checkbox: true,
    tip: "Close tiny holes and remove isolated speckle before tracing, for smoother, less fragmented walls." },
  { key: "edgeMargin", label: "Edge Margin", group: "detection", min: 0, max: 50, step: 1, decimals: 0,
    tip: "Ignore geometry within this many px of the image border, so the page/frame edge isn't traced as a wall." },

  { key: "simplifyPx", label: "Simplify (px)", group: "walls", min: 0, max: 10, step: 1, decimals: 0,
    tip: "How far (px) a wall may deviate from the exact detected outline when smoothing — NOT wall thickness. Higher = straighter walls with fewer points; 0 = follow every bump. Straight walls stay straight at any value." },
  { key: "maxWallLength", label: "Max Wall Length", group: "walls", min: 20, max: 2000, step: 10, decimals: 0,
    tip: "Splits long walls into segments. Straight runs re-merge into one long wall regardless, so this mainly controls how finely CURVES are subdivided — raise it for simpler curves." },
  { key: "mergeDistance", label: "Merge Distance", group: "walls", min: 0, max: 120, step: 1, decimals: 0,
    tip: "Weld wall endpoints within this distance so corners connect. Too high collapses walls into blobs." },
  { key: "maxGap", label: "Max Gap Connect", group: "walls", min: 0, max: 120, step: 1, decimals: 0,
    tip: "Bridge straight gaps up to this distance to close small openings (e.g. door breaks)." },
  { key: "angleTolerance", label: "Angle Tolerance", group: "walls", min: 0, max: 10, step: 1, decimals: 0,
    tip: "Allowed angle difference when merging straight walls. 0 keeps curves intact while straight runs still merge." },
];

export class AutoWallApp extends HandlebarsApplicationMixin(ApplicationV2) {
  get api() { return game.modules.get(MOD)?.api ?? null; }

  static DEFAULT_OPTIONS = {
    id: "auto-wall-panel",
    tag: "div",
    classes: ["auto-wall-app"],
    window: { title: "Auto-Wall", icon: "fa-solid fa-wand-magic-sparkles", resizable: true },
    position: { width: 360, height: "auto" },
    actions: {
      auto: AutoWallApp.#onAuto,
      savePreset: AutoWallApp.#onSavePreset,
      deletePreset: AutoWallApp.#onDeletePreset,
      detect: AutoWallApp.#onDetect,
      generate: AutoWallApp.#onGenerate,
      createWalls: AutoWallApp.#onCreateWalls,
      clearWalls: AutoWallApp.#onClearWalls,
    },
  };

  static PARTS = { body: { root: true, template: "modules/auto-wall/templates/panel.hbs" } };

  #ctx(group) {
    const params = this.api?.getParams?.() ?? {};
    return CONTROLS.filter((c) => c.group === group).map((c) => {
      if (c.checkbox) return { key: c.key, label: c.label, tip: c.tip, isCheckbox: true, value: !!params[c.key] };
      const raw = Number(params[c.key]);
      const value = Number.isFinite(raw) ? raw : c.min;
      return { key: c.key, label: c.label, tip: c.tip, isCheckbox: false,
               min: c.min, max: c.max, step: c.step, value, display: value.toFixed(c.decimals) };
    });
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const cur = this.api?.currentPreset?.() ?? "";
    context.presets = (this.api?.presets?.() ?? []).map((p) => ({
      name: p.name, custom: p.custom, selected: p.name === cur,
    }));
    context.currentPreset = cur;
    context.detection = this.#ctx("detection");
    context.walls = this.#ctx("walls");
    return context;
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const el = this.element;

    // range <-> number sync + commit
    for (const c of CONTROLS) {
      if (c.checkbox) {
        const cb = el.querySelector(`input[type="checkbox"][name="${c.key}"]`);
        cb?.addEventListener("change", (e) => this.#commit(c.key, e.currentTarget.checked));
        continue;
      }
      const range = el.querySelector(`input[type="range"][name="${c.key}"]`);
      const num = el.querySelector(`input.aw-num[data-num="${c.key}"]`);
      if (!range || !num) continue;
      range.addEventListener("input", () => { num.value = range.value; });
      num.addEventListener("input", () => { range.value = num.value; });
      const commit = () => {
        const v = Math.clamp(Number(num.value), c.min, c.max);
        num.value = v; range.value = v;
        this.#commit(c.key, v);
      };
      range.addEventListener("change", commit);
      num.addEventListener("change", commit);
    }

    // preset dropdown
    const sel = el.querySelector('select[name="preset"]');
    sel?.addEventListener("change", async (e) => {
      const name = e.currentTarget.value;
      if (!name) return;
      this.api?.applyPreset?.(name);
      this.render(); // refresh all controls to the preset values
    });
  }

  _onClose(options) { super._onClose(options); this.api?.clearPreview?.(); }

  #commit(key, value) {
    try {
      this.api?.setParams?.({ [key]: value });
      // tweaking any control no longer matches a preset -> show "Custom"
      const sel = this.element?.querySelector('select[name="preset"]');
      if (sel) sel.value = "";
    } catch (e) { console.error(`${MOD} | setParams ${key}`, e); }
  }

  note(text, opts) { this.#setStatus(text, opts); }

  #setStatus(text, { error = false } = {}) {
    const el = this.element?.querySelector("[data-status]");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("is-error", !!error);
  }

  #setBusy(busy) {
    for (const b of this.element?.querySelectorAll("button[data-action], select, input") ?? []) b.disabled = !!busy;
  }

  async #run(label, fn, format, { refresh = false } = {}) {
    const api = this.api;
    if (!api) return this.#setStatus("Auto-Wall API unavailable", { error: true });
    this.#setBusy(true);
    this.#setStatus(`${label}…`);
    try {
      const res = await fn(api);
      if (res?.ok) {
        const msg = format(res);
        if (refresh) await this.render(); // re-render BEFORE writing status (else it's clobbered)
        this.#setStatus(msg);
      } else this.#setStatus(res?.error ?? `${label} failed`, { error: true });
    } catch (e) {
      this.#setStatus(String(e?.message ?? e), { error: true });
    } finally {
      this.#setBusy(false);
    }
  }

  static #onAuto() { return this.#run("Scanning", (a) => a.autoPreset(), (r) => `preset: ${r.preset}`, { refresh: true }); }

  static async #onSavePreset() {
    const name = await foundry.applications.api.DialogV2.prompt({
      window: { title: "Save Auto-Wall Preset" },
      content: `<input type="text" name="presetName" placeholder="My preset" autofocus style="width:100%">`,
      ok: { label: "Save", callback: (event, button) => button.form.elements.presetName.value },
    }).catch(() => null);
    if (!name) return;
    return this.#run("Saving preset", (a) => a.savePreset(name), (r) => `saved "${r.preset}"`, { refresh: true });
  }

  static async #onDeletePreset() {
    const name = this.element.querySelector('select[name="preset"]')?.value || this.api?.currentPreset?.();
    if (!name) return this.note("select a custom preset to delete", { error: true });
    const entry = (this.api?.presets?.() ?? []).find((p) => p.name === name);
    if (!entry?.custom) return this.note("only custom presets can be deleted", { error: true });
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Delete Preset" }, content: `<p>Delete custom preset <strong>${name}</strong>?</p>`,
    }).catch(() => false);
    if (!ok) return;
    return this.#run("Deleting preset", (a) => a.deletePreset(name), () => `deleted "${name}"`, { refresh: true });
  }
  static #onDetect() { return this.#run("Detecting", (a) => a.detect(), (r) => `${r.contours} contours — click green to delete`); }
  static #onGenerate() { return this.#run("Previewing walls", (a) => a.generate(), (r) => `${r.walls} walls`); }
  static #onCreateWalls() { return this.#run("Creating walls", (a) => a.createWalls({ clear: true }), (r) => `created ${r.created}`); }
  static #onClearWalls() { return this.#run("Clearing", (a) => a.clearWalls(), (r) => `cleared ${r.cleared}`); }
}
