import { create } from 'zustand';
import { rgb8ToOkL } from './lib/color';
import { aiCrashedLastTime, aiPref, isLowMemoryDevice } from './lib/device';
import { rebuildPart } from './lib/mask';
import { smartFill } from './lib/smartfill';
import * as persist from './lib/persist';
import type { ProjectMeta } from './lib/persist';
import { sam, type SamStatus } from './lib/sam';

export type Slot = 'base' | 'shade' | 'highlight';
export type Tool = 'select' | 'brush' | 'erase' | 'pan';

export interface Recipe {
  base: string | null;
  shade: string | null;
  highlight: string | null;
  shadeAmt: number;
  hiAmt: number;
  depth: number;
}

/** Click point in normalised image coordinates; label 1 = include, 0 = exclude. */
export interface Pt {
  x: number;
  y: number;
  label: 0 | 1;
}

export interface BBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Stats {
  lo: number;
  hi: number;
  mean: number;
}

export interface Part {
  id: string;
  name: string;
  points: Pt[];
  samMasks: Uint8Array[]; // AI candidates, smallest → largest
  level: number; // which candidate is used
  add: Uint8Array | null; // brush additions
  erase: Uint8Array | null; // brush erasures
  mask: Uint8Array | null;
  alpha: Uint8Array | null;
  bbox: BBox | null;
  stats: Stats | null;
  recipe: Recipe;
}

export interface Img {
  w: number;
  h: number;
  rgba: Uint8ClampedArray;
  L: Float32Array;
  name: string;
}

export interface Scheme {
  id: string;
  name: string;
  recipes: Record<string, Recipe>;
}

export type Selector = 'ai' | 'fill';

const LOW_MEMORY = isLowMemoryDevice();
// Phones get smaller working images: every part keeps several full-size masks.
const MAX_SIDE = LOW_MEMORY ? 1200 : 1600;

// If the last visit's AI analysis crashed the page, switch the AI off for this device.
const AI_CRASHED = aiCrashedLastTime();
if (AI_CRASHED) aiPref.set('off');
const pref = aiPref.get();
const INITIAL_SELECTOR: Selector = pref === 'on' ? 'ai' : pref === 'off' || LOW_MEMORY ? 'fill' : 'ai';

export const PART_NAMES = [
  'Armour', 'Trim', 'Helmet', 'Eye lenses', 'Cloth / robes', 'Leather / pouches',
  'Undersuit', 'Weapon casing', 'Weapon metal', 'Skin', 'Hair', 'Gems', 'Base', 'Base rim',
];

const newRecipe = (): Recipe => ({ base: null, shade: null, highlight: null, shadeAmt: 0.6, hiAmt: 0.5, depth: 1 });

let toastTimer = 0;
let uid = 0;
const nextId = (p: string) => `${p}${Date.now().toString(36)}${(uid++).toString(36)}`;

function lightnessOf(rgba: Uint8ClampedArray, n: number): Float32Array {
  const L = new Float32Array(n);
  for (let i = 0, o = 0; i < n; i++, o += 4) L[i] = rgb8ToOkL(rgba[o], rgba[o + 1], rgba[o + 2]);
  return L;
}

const stripExt = (name: string) => name.replace(/\.[^.]+$/, '') || 'My model';

interface State {
  image: Img | null;
  parts: Part[];
  selectedId: string | null;
  tool: Tool;
  pointLabel: 0 | 1;
  brushSize: number;
  activeSlot: Slot;
  showOriginal: boolean;
  showMask: boolean;
  samStatus: SamStatus;
  samDetail: string;
  busy: boolean;
  schemes: Scheme[];
  toast: string | null;
  /** Saved project currently open. */
  projectId: string | null;
  projects: ProjectMeta[];
  /** True while a saved project is being opened. */
  restoring: boolean;
  /** What a tap uses to find a part: the AI model, or the light colour-based Smart fill. */
  selector: Selector;
  lowMemory: boolean;
  setSelector(s: Selector): void;

  loadFile(file: File): Promise<void>;
  closeImage(): Promise<void>;
  openProject(id: string): Promise<void>;
  deleteProject(id: string): Promise<void>;
  renameProject(id: string, name: string): Promise<void>;
  refreshProjects(): Promise<void>;
  saveNow(): Promise<void>;
  newPart(): string;
  selectPart(id: string | null): void;
  renamePart(id: string, name: string): void;
  deletePart(id: string): void;
  movePart(id: string, dir: -1 | 1): void;
  addPoint(pt: Pt): Promise<void>;
  undoPoint(): Promise<void>;
  clearPoints(): void;
  setLevel(level: number): void;
  brushLayers(id: string, mode: 'brush' | 'erase'): { paint: Uint8Array; other: Uint8Array } | null;
  commitBrush(id: string): void;
  setTool(t: Tool): void;
  setPointLabel(l: 0 | 1): void;
  setBrushSize(n: number): void;
  setActiveSlot(s: Slot): void;
  applyPaint(ref: string): void;
  clearSlot(slot: Slot): void;
  setRecipeValue(key: 'shadeAmt' | 'hiAmt' | 'depth', v: number): void;
  setShowOriginal(v: boolean): void;
  setShowMask(v: boolean): void;
  saveScheme(name: string): void;
  applyScheme(id: string): void;
  deleteScheme(id: string): void;
  notify(msg: string, ms?: number): void;
}

export const useStore = create<State>((set, get) => {
  const updatePart = (id: string, fn: (p: Part) => Part) =>
    set((s) => ({ parts: s.parts.map((p) => (p.id === id ? fn(p) : p)) }));

  const selected = () => {
    const { parts, selectedId } = get();
    return parts.find((p) => p.id === selectedId) ?? null;
  };

  async function runDecode(id: string) {
    const img = get().image;
    const part = get().parts.find((p) => p.id === id);
    if (!img || !part) return;
    if (!part.points.length) {
      updatePart(id, (p) => rebuildPart({ ...p, samMasks: [] }, img));
      return;
    }
    const pointsAtRequest = part.points;
    set({ busy: true });
    const res = get().selector === 'ai' ? await sam.decode(part.points) : await smartFill(img, part.points);
    set({ busy: false });
    if (!res) return;
    const current = get().parts.find((p) => p.id === id);
    if (!current || current.points !== pointsAtRequest || get().image !== img) return;
    // Order candidates small → large so "detail level" is intuitive.
    const order = res.masks
      .map((m, i) => {
        let c = 0;
        for (let k = 0; k < m.length; k++) c += m[k];
        return { m, i, c, score: res.scores[i] };
      })
      .sort((a, b) => a.c - b.c);
    const best = order.reduce((bi, o, i, arr) => (o.score > arr[bi].score ? i : bi), 0);
    updatePart(id, (p) => rebuildPart({ ...p, samMasks: order.map((o) => o.m), level: best }, img));
  }

  return {
    image: null,
    parts: [],
    selectedId: null,
    tool: 'select',
    pointLabel: 1,
    brushSize: 14,
    activeSlot: 'base',
    showOriginal: false,
    showMask: true,
    samStatus: 'idle',
    samDetail: '',
    busy: false,
    schemes: [],
    toast: null,
    projectId: null,
    projects: [],
    restoring: !!persist.lastOpen.get(),
    selector: INITIAL_SELECTOR,
    lowMemory: LOW_MEMORY,

    setSelector(selector) {
      aiPref.set(selector === 'ai' ? 'on' : 'off');
      set({ selector });
      const img = get().image;
      if (selector === 'ai') {
        if (img) sam.embed(img.rgba, img.w, img.h);
        else sam.preload();
      }
    },

    async loadFile(file) {
      if (!file.type.startsWith('image/')) {
        get().notify('That file is not an image.');
        return;
      }
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
      const w = Math.round(bmp.width * scale);
      const h = Math.round(bmp.height * scale);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const cx = c.getContext('2d', { willReadFrequently: true })!;
      cx.drawImage(bmp, 0, 0, w, h);
      bmp.close();
      const rgba = cx.getImageData(0, 0, w, h).data;
      const L = lightnessOf(rgba, w * h);
      await get().saveNow(); // finish saving the project being left
      const id = nextId('m');
      const name = stripExt(file.name);
      set({ image: { w, h, rgba, L, name }, projectId: id, parts: [], selectedId: null, schemes: [], tool: 'select' });
      if (get().selector === 'ai') sam.embed(rgba, w, h);
      const now = Date.now();
      try {
        await persist.createProject({ id, name, w, h, created: now, updated: now, partCount: 0, thumb: null }, rgba);
        persist.lastOpen.set(id);
        navigator.storage?.persist?.().catch(() => {});
      } catch (e) {
        console.error(e);
        get().notify("Couldn't save this photo on your device — your work won't be kept after a refresh.");
      }
    },

    async closeImage() {
      await get().saveNow();
      persist.lastOpen.set(null);
      set({ image: null, projectId: null, parts: [], selectedId: null, schemes: [] });
      await get().refreshProjects();
    },

    async openProject(id) {
      if (get().projectId === id) return;
      await get().saveNow();
      set({ restoring: true });
      try {
        const data = await persist.loadProject(id);
        if (!data) {
          persist.lastOpen.set(null);
          set({ restoring: false });
          get().notify('That saved model could not be found.');
          await get().refreshProjects();
          return;
        }
        const { meta, rgba, work } = data;
        const n = meta.w * meta.h;
        const img: Img = { w: meta.w, h: meta.h, rgba, L: lightnessOf(rgba, n), name: meta.name };
        const parts = work.parts.map((sp) => rebuildPart(persist.fromSaved(sp, n), img));
        const selectedId = parts.some((p) => p.id === work.selectedId) ? work.selectedId : null;
        set({ image: img, projectId: id, parts, schemes: work.schemes, selectedId, tool: 'select', restoring: false });
        persist.lastOpen.set(id);
        if (get().selector === 'ai') sam.embed(rgba, img.w, img.h);
      } catch (e) {
        console.error(e);
        set({ restoring: false });
        get().notify("Couldn't open that saved model.");
      }
    },

    async deleteProject(id) {
      await persist.deleteProject(id);
      if (persist.lastOpen.get() === id) persist.lastOpen.set(null);
      await get().refreshProjects();
    },

    async renameProject(id, name) {
      name = name.trim();
      if (!name) return;
      await persist.renameProject(id, name);
      const img = get().image;
      if (get().projectId === id && img) set({ image: { ...img, name } });
      await get().refreshProjects();
    },

    async refreshProjects() {
      try {
        set({ projects: await persist.listProjects() });
      } catch (e) {
        console.error(e);
      }
    },

    saveNow: () => flushSave(),

    newPart() {
      const id = nextId('p');
      const used = new Set(get().parts.map((p) => p.name));
      const name = PART_NAMES.find((n) => !used.has(n)) ?? `Part ${get().parts.length + 1}`;
      const part: Part = {
        id, name, points: [], samMasks: [], level: 0, add: null, erase: null,
        mask: null, alpha: null, bbox: null, stats: null, recipe: newRecipe(),
      };
      set((s) => ({ parts: [...s.parts, part], selectedId: id, activeSlot: 'base', showMask: true }));
      return id;
    },

    // Show the selection whenever a part is picked, so an empty or hidden one isn't mistaken for a broken selector.
    selectPart: (id) => set((s) => ({ selectedId: id, showMask: id !== null && id !== s.selectedId ? true : s.showMask })),
    renamePart: (id, name) => updatePart(id, (p) => ({ ...p, name })),
    deletePart: (id) =>
      set((s) => ({ parts: s.parts.filter((p) => p.id !== id), selectedId: s.selectedId === id ? null : s.selectedId })),
    movePart: (id, dir) =>
      set((s) => {
        const i = s.parts.findIndex((p) => p.id === id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= s.parts.length) return s;
        const parts = [...s.parts];
        [parts[i], parts[j]] = [parts[j], parts[i]];
        return { parts };
      }),

    async addPoint(pt) {
      let part = selected();
      if (!part) {
        get().newPart();
        part = selected()!;
      }
      const id = part.id;
      set({ showMask: true });
      updatePart(id, (p) => ({ ...p, points: [...p.points, pt] }));
      await runDecode(id);
    },

    async undoPoint() {
      const part = selected();
      if (!part || !part.points.length) return;
      updatePart(part.id, (p) => ({ ...p, points: p.points.slice(0, -1) }));
      await runDecode(part.id);
    },

    clearPoints() {
      const part = selected();
      const img = get().image;
      if (!part || !img) return;
      updatePart(part.id, (p) => rebuildPart({ ...p, points: [], samMasks: [], add: null, erase: null }, img));
    },

    setLevel(level) {
      const part = selected();
      const img = get().image;
      if (!part || !img) return;
      updatePart(part.id, (p) => rebuildPart({ ...p, level }, img));
    },

    brushLayers(id, mode) {
      const img = get().image;
      const part = get().parts.find((p) => p.id === id);
      if (!img || !part) return null;
      const n = img.w * img.h;
      // Mutated in place during a stroke; commitBrush() publishes the result.
      const add = (part.add ??= new Uint8Array(n));
      const erase = (part.erase ??= new Uint8Array(n));
      return mode === 'brush' ? { paint: add, other: erase } : { paint: erase, other: add };
    },

    commitBrush(id) {
      const img = get().image;
      if (!img) return;
      updatePart(id, (p) => rebuildPart(p, img));
    },

    setTool: (tool) => set({ tool }),
    setPointLabel: (pointLabel) => set({ pointLabel }),
    setBrushSize: (brushSize) => set({ brushSize }),
    setActiveSlot: (activeSlot) => set({ activeSlot }),

    applyPaint(ref) {
      const part = selected();
      if (!part) {
        get().notify('Select or create a part first, then pick a paint.');
        return;
      }
      const slot = get().activeSlot;
      updatePart(part.id, (p) => ({ ...p, recipe: { ...p.recipe, [slot]: ref } }));
      if (!part.mask) get().notify('Paint set — now tap the model to choose where it goes.');
    },

    clearSlot(slot) {
      const part = selected();
      if (part) updatePart(part.id, (p) => ({ ...p, recipe: { ...p.recipe, [slot]: null } }));
    },

    setRecipeValue(key, v) {
      const part = selected();
      if (part) updatePart(part.id, (p) => ({ ...p, recipe: { ...p.recipe, [key]: v } }));
    },

    setShowOriginal: (showOriginal) => set({ showOriginal }),
    setShowMask: (showMask) => set({ showMask }),

    saveScheme(name) {
      const recipes: Record<string, Recipe> = {};
      for (const p of get().parts) recipes[p.id] = { ...p.recipe };
      set((s) => ({ schemes: [...s.schemes, { id: nextId('s'), name, recipes }] }));
    },

    applyScheme(id) {
      const scheme = get().schemes.find((s) => s.id === id);
      if (!scheme) return;
      set((s) => ({
        parts: s.parts.map((p) => (scheme.recipes[p.id] ? { ...p, recipe: { ...scheme.recipes[p.id] } } : p)),
      }));
    },

    deleteScheme: (id) => set((s) => ({ schemes: s.schemes.filter((x) => x.id !== id) })),

    notify(msg, ms = 3200) {
      set({ toast: msg });
      window.clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => set({ toast: null }), ms);
    },
  };
});

sam.onStatus((status, detail) => useStore.setState({ samStatus: status, samDetail: detail ?? '' }));

// ---- Autosave -------------------------------------------------------------
let saveTimer = 0;
let dirty = false;
let saving: Promise<void> = Promise.resolve();

/** Writes pending changes now; resolves once everything queued so far is saved. */
function flushSave(): Promise<void> {
  window.clearTimeout(saveTimer);
  const { projectId, parts, schemes, selectedId } = useStore.getState();
  if (dirty && projectId) {
    dirty = false;
    // Encode now: brush layers are edited in place, so this snapshots them.
    const work = { parts: parts.map(persist.toSaved), schemes, selectedId };
    saving = saving
      .then(async () => persist.saveWork(projectId, work, await persist.captureThumb()))
      .catch((e) => {
        console.error(e);
        useStore.getState().notify("Couldn't save your work on this device (storage may be full).");
      });
  }
  return saving;
}

useStore.subscribe((s, prev) => {
  if (!s.projectId || s.projectId !== prev.projectId) return;
  if (s.parts === prev.parts && s.schemes === prev.schemes && s.selectedId === prev.selectedId) return;
  dirty = true;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(flushSave, 700);
});

window.addEventListener('pagehide', () => void flushSave());
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && void flushSave());

// Reopen whatever was open before a refresh, and load the saved list.
{
  const last = persist.lastOpen.get();
  if (last) void useStore.getState().openProject(last);
  void useStore.getState().refreshProjects();
}

// Handy for debugging in the browser console during development.
if (import.meta.env.DEV) (window as unknown as { __store: typeof useStore }).__store = useStore;

if (AI_CRASHED) {
  useStore.getState().notify(
    'The AI selector ran out of memory on this device and the page reloaded, so it has been switched to Smart fill. Tap a part to select it.',
    9000,
  );
}
