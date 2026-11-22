import type { Pt } from '../store';
import { aiBusy } from './device';
import { subjectBox, type Box } from './aiAssist';

export type SamStatus = 'idle' | 'loading' | 'embedding' | 'ready' | 'error';
type StatusListener = (status: SamStatus, detail?: string) => void;

export interface DecodeResult {
  masks: Uint8Array[];
  scores: number[];
}

let worker: Worker | null = null;
let listener: StatusListener = () => {};
let latestId = 0;
let embedding = false;
const pending = new Map<number, { resolve: (r: DecodeResult | null) => void; box: Box; w: number; h: number }>();
/** The photo last sent for analysis, and the part of it the AI actually sees. */
let photo: { rgba: Uint8ClampedArray; w: number; h: number; box: Box } | null = null;

function sendEmbed(rgba: Uint8ClampedArray, w: number, h: number, box: Box) {
  // If the browser runs out of memory and reloads the page, this flag survives
  // and the next load switches to Smart fill instead of crashing again.
  aiBusy.start();
  photo = { rgba, w, h, box };
  const crop = new Uint8ClampedArray(box.w * box.h * 4);
  for (let y = 0; y < box.h; y++) {
    const from = ((box.y + y) * w + box.x) * 4;
    crop.set(rgba.subarray(from, from + box.w * 4), y * box.w * 4);
  }
  ensureWorker().postMessage({ type: 'embed', rgba: crop.buffer, w: box.w, h: box.h }, [crop.buffer]);
}

/** Masks come back for the cropped area; place them into full-photo masks. */
function uncrop(masks: Uint8Array[], box: Box, w: number, h: number): Uint8Array[] {
  if (box.x === 0 && box.y === 0 && box.w === w && box.h === h) return masks;
  return masks.map((m) => {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < box.h; y++) out.set(m.subarray(y * box.w, (y + 1) * box.w), (box.y + y) * w + box.x);
    return out;
  });
}

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./samWorker.ts', import.meta.url), { type: 'module' });
  const fileProgress = new Map<string, number>();
  let deviceLabel = '';
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'status') {
      if (m.status === 'embedding') embedding = true;
      else if (embedding && (m.status === 'ready' || m.status === 'error')) {
        embedding = false;
        aiBusy.end();
      }
      if (m.device) deviceLabel = m.device === 'webgpu' ? 'GPU' : 'CPU';
      listener(m.status, m.status === 'ready' && deviceLabel ? `on ${deviceLabel}` : undefined);
    } else if (m.type === 'progress') {
      fileProgress.set(m.file, m.progress);
      const vals = [...fileProgress.values()];
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      listener('loading', `downloading AI model… ${Math.round(avg)}%`);
    } else if (m.type === 'decoded') {
      const req = pending.get(m.id);
      pending.delete(m.id);
      // Only the newest request wins; older clicks are superseded.
      if (req) req.resolve(m.id === latestId ? { masks: uncrop(m.masks, req.box, req.w, req.h), scores: m.scores } : null);
    } else if (m.type === 'error') {
      embedding = false;
      aiBusy.end();
      if (m.id !== undefined) {
        pending.get(m.id)?.resolve(null);
        pending.delete(m.id);
      }
      listener('error', m.message);
    }
  };
  return worker;
}

export const sam = {
  onStatus(fn: StatusListener) {
    listener = fn;
  },
  preload() {
    ensureWorker().postMessage({ type: 'load' });
  },
  /** Analyses the photo — cropped to the model when it stands out from a plain backdrop. */
  embed(rgba: Uint8ClampedArray, w: number, h: number) {
    sendEmbed(rgba, w, h, subjectBox(rgba, w, h));
  },
  decode(points: Pt[]): Promise<DecodeResult | null> {
    if (!photo) return Promise.resolve(null);
    const { w, h } = photo;
    let { box } = photo;
    const inside = (p: Pt) =>
      p.x * w >= box.x && p.x * w < box.x + box.w && p.y * h >= box.y && p.y * h < box.y + box.h;
    if (points.some((p) => p.label === 1 && !inside(p))) {
      // Tapped outside the cropped area: analyse the whole photo instead (once).
      box = { x: 0, y: 0, w, h };
      sendEmbed(photo.rgba, w, h, box);
    }
    const local = points.map((p) => ({ x: (p.x * w - box.x) / box.w, y: (p.y * h - box.y) / box.h, label: p.label }));
    const id = ++latestId;
    return new Promise((resolve) => {
      pending.set(id, { resolve, box, w, h });
      ensureWorker().postMessage({ type: 'decode', id, points: local });
    });
  },
  /** Pixel area of the region the AI analyses (the crop around the model, or the whole photo). */
  viewArea(): number {
    return photo ? photo.box.w * photo.box.h : 0;
  },
  /** How many photo pixels one cell of the AI's 256×256 mask grid covers. */
  maskCell(): number {
    return photo ? Math.max(photo.box.w, photo.box.h) / 256 : 4;
  },
};
