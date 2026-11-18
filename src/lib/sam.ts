import type { Pt } from '../store';
import { aiBusy } from './device';

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
const pending = new Map<number, (r: DecodeResult | null) => void>();

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
      const resolve = pending.get(m.id);
      pending.delete(m.id);
      // Only the newest request wins; older clicks are superseded.
      resolve?.(m.id === latestId ? { masks: m.masks, scores: m.scores } : null);
    } else if (m.type === 'error') {
      embedding = false;
      aiBusy.end();
      if (m.id !== undefined) {
        pending.get(m.id)?.(null);
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
  embed(rgba: Uint8ClampedArray, w: number, h: number) {
    // If the browser runs out of memory and reloads the page, this flag survives
    // and the next load switches to Smart fill instead of crashing again.
    aiBusy.start();
    const copy = rgba.slice().buffer;
    ensureWorker().postMessage({ type: 'embed', rgba: copy, w, h }, [copy]);
  },
  decode(points: Pt[]): Promise<DecodeResult | null> {
    const id = ++latestId;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      ensureWorker().postMessage({ type: 'decode', id, points });
    });
  },
};
