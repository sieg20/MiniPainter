// Saves projects (photo + parts + schemes) in IndexedDB, on this device only.
import type { Part, Pt, Recipe, Scheme } from '../store';

export interface ProjectMeta {
  id: string;
  name: string;
  w: number;
  h: number;
  created: number;
  updated: number;
  partCount: number;
  thumb: Blob | null;
}

interface SavedPart {
  id: string;
  name: string;
  points: Pt[];
  level: number;
  samMasks: Uint32Array[];
  add: Uint32Array | null;
  erase: Uint32Array | null;
  recipe: Recipe;
}

export interface SavedWork {
  parts: SavedPart[];
  schemes: Scheme[];
  selectedId: string | null;
}

const STORES = ['projects', 'images', 'work'] as const;
let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  return (dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('mini-painter', 1);
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbp = null;
      reject(req.error);
    };
  }));
}

/** Runs fn inside one transaction and resolves with the last request's result once it commits. */
async function run<T>(mode: IDBTransactionMode, fn: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction([...STORES], mode);
    let req: IDBRequest<T> | void = undefined;
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error('Save cancelled'));
    req = fn(t);
  });
}

// Masks are 0/1 per pixel, so run-length encoding shrinks them ~1000×.
// AI masks never change after decoding, so their encodings are cached; brush layers are edited in place and are not.
const rleCache = new WeakMap<Uint8Array, Uint32Array>();

export function encode(m: Uint8Array, cache: boolean): Uint32Array {
  const hit = cache && rleCache.get(m);
  if (hit) return hit;
  const runs: number[] = [];
  let cur = 0;
  let len = 0;
  for (let i = 0; i < m.length; i++) {
    const v = m[i] ? 1 : 0;
    if (v === cur) len++;
    else {
      runs.push(len);
      cur = v;
      len = 1;
    }
  }
  runs.push(len);
  const out = Uint32Array.from(runs);
  if (cache) rleCache.set(m, out);
  return out;
}

export function decode(runs: Uint32Array, n: number, cache: boolean): Uint8Array {
  const m = new Uint8Array(n);
  let i = 0;
  for (let r = 0; r < runs.length; r++) {
    const end = Math.min(n, i + runs[r]);
    if (r & 1) m.fill(1, i, end);
    i = end;
  }
  if (cache) rleCache.set(m, runs);
  return m;
}

const encodeLayer = (m: Uint8Array | null) => (m && m.some((v) => v) ? encode(m, false) : null);

export function toSaved(p: Part): SavedPart {
  return {
    id: p.id, name: p.name, points: p.points, level: p.level, recipe: p.recipe,
    samMasks: p.samMasks.map((m) => encode(m, true)),
    add: encodeLayer(p.add),
    erase: encodeLayer(p.erase),
  };
}

/** Restores a part's inputs; the caller rebuilds the derived mask, alpha and stats. */
export function fromSaved(s: SavedPart, n: number): Part {
  return {
    id: s.id, name: s.name, points: s.points, level: s.level, recipe: s.recipe,
    samMasks: s.samMasks.map((r) => decode(r, n, true)),
    add: s.add ? decode(s.add, n, false) : null,
    erase: s.erase ? decode(s.erase, n, false) : null,
    mask: null, alpha: null, bbox: null, stats: null,
  };
}

export async function listProjects(): Promise<ProjectMeta[]> {
  const all = (await run<ProjectMeta[]>('readonly', (t) => t.objectStore('projects').getAll())) ?? [];
  return all.sort((a, b) => b.updated - a.updated);
}

export async function createProject(meta: ProjectMeta, rgba: Uint8ClampedArray): Promise<void> {
  const work: SavedWork = { parts: [], schemes: [], selectedId: null };
  await run('readwrite', (t) => {
    t.objectStore('images').put(rgba, meta.id);
    t.objectStore('work').put(work, meta.id);
    t.objectStore('projects').put(meta, meta.id);
  });
}

export async function saveWork(id: string, work: SavedWork, thumb: Blob | null): Promise<void> {
  await run('readwrite', (t) => {
    const projects = t.objectStore('projects');
    const get = projects.get(id);
    get.onsuccess = () => {
      const meta = get.result as ProjectMeta | undefined;
      if (!meta) return; // deleted meanwhile
      projects.put({ ...meta, updated: Date.now(), partCount: work.parts.length, thumb: thumb ?? meta.thumb }, id);
      t.objectStore('work').put(work, id);
    };
  });
}

export async function loadProject(id: string) {
  let meta: ProjectMeta | undefined;
  let rgba: Uint8ClampedArray | undefined;
  let work: SavedWork | undefined;
  await run('readonly', (t) => {
    const a = t.objectStore('projects').get(id);
    const b = t.objectStore('images').get(id);
    const c = t.objectStore('work').get(id);
    a.onsuccess = () => (meta = a.result);
    b.onsuccess = () => (rgba = b.result);
    c.onsuccess = () => (work = c.result);
  });
  return meta && rgba && work ? { meta, rgba, work } : null;
}

export async function renameProject(id: string, name: string): Promise<void> {
  await run('readwrite', (t) => {
    const projects = t.objectStore('projects');
    const get = projects.get(id);
    get.onsuccess = () => get.result && projects.put({ ...get.result, name }, id);
  });
}

export async function deleteProject(id: string): Promise<void> {
  await run('readwrite', (t) => {
    for (const s of STORES) t.objectStore(s).delete(id);
  });
}

/** Small JPEG of the painted canvas for the project list. */
export function captureThumb(): Promise<Blob | null> {
  const src = document.getElementById('paint-canvas') as HTMLCanvasElement | null;
  if (!src || !src.width) return Promise.resolve(null);
  const scale = Math.min(1, 360 / Math.max(src.width, src.height));
  const c = document.createElement('canvas');
  c.width = Math.round(src.width * scale);
  c.height = Math.round(src.height * scale);
  c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
  return new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.82));
}

// Remembers which project was open so a refresh reopens it.
const LAST = 'mini-painter:last';
export const lastOpen = {
  get: (): string | null => {
    try {
      return localStorage.getItem(LAST);
    } catch {
      return null;
    }
  },
  set: (id: string | null) => {
    try {
      if (id) localStorage.setItem(LAST, id);
      else localStorage.removeItem(LAST);
    } catch {
      /* storage blocked: nothing to remember */
    }
  },
};
