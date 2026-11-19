// Undo/redo history entries.
//
// Two kinds:
// - "state": the parts / schemes / selection before an action. Parts are immutable
//   objects, so most snapshots just share them with the current state and cost nothing.
//   A snapshot part whose masks are no longer in use is "compacted": its AI/fill masks
//   are run-length encoded and its derived mask dropped, then rebuilt if it's restored.
// - "stroke": one brush/erase stroke. Brush layers are edited in place, so a stroke
//   stores only the rectangle it changed (before-bytes), not whole layers.
import type { Img, Part, Scheme } from '../store';
import { rebuildPart } from './mask';
import { decode, encode } from './persist';

interface CompactPart extends Omit<Part, 'samMasks' | 'mask' | 'alpha'> {
  compact: Uint32Array[];
}
type SnapPart = Part | CompactPart;

const isCompact = (p: SnapPart): p is CompactPart => 'compact' in p;

export interface StateEntry {
  kind: 'state';
  label: string;
  /** Repeated actions with the same key (slider drags, typing) merge into one step. */
  key?: string;
  time: number;
  parts: SnapPart[];
  schemes: Scheme[];
  selectedId: string | null;
}

export interface StrokeEntry {
  kind: 'stroke';
  label: string;
  partId: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Layer bytes inside the rectangle; swapped with the live layers on undo/redo. */
  add: Uint8Array;
  erase: Uint8Array;
}

export type Entry = StateEntry | StrokeEntry;

/** Compacts snapshot parts whose masks the current state no longer shares. */
export function compactEntry(e: Entry, current: Part[]): void {
  if (e.kind !== 'state') return;
  e.parts = e.parts.map((p) => {
    if (isCompact(p)) return p;
    const c = current.find((q) => q.id === p.id);
    if (c && c.samMasks === p.samMasks && c.mask === p.mask) return p; // shared: no extra memory
    if (!p.mask && !p.samMasks.length) return p; // nothing heavy to drop
    const { samMasks, mask, alpha, ...rest } = p;
    return { ...rest, compact: samMasks.map((m) => encode(m, true)) };
  });
}

export function restoreParts(parts: SnapPart[], img: Img): Part[] {
  const n = img.w * img.h;
  return parts.map((p) => {
    if (!isCompact(p)) return p;
    const { compact, ...rest } = p;
    return rebuildPart({ ...rest, samMasks: compact.map((r) => decode(r, n, true)), mask: null, alpha: null }, img);
  });
}

/** Builds a stroke entry from the layers before and after a stroke; null if nothing changed. */
export function makeStroke(
  label: string, partId: string, w: number, h: number,
  before: { add: Uint8Array; erase: Uint8Array }, after: { add: Uint8Array; erase: Uint8Array },
): StrokeEntry | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (before.add[i] !== after.add[i] || before.erase[i] !== after.erase[i]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  x1++;
  y1++;
  const rw = x1 - x0, rh = y1 - y0;
  const add = new Uint8Array(rw * rh), erase = new Uint8Array(rw * rh);
  for (let y = 0; y < rh; y++) {
    const src = (y + y0) * w + x0;
    add.set(before.add.subarray(src, src + rw), y * rw);
    erase.set(before.erase.subarray(src, src + rw), y * rw);
  }
  return { kind: 'stroke', label, partId, x0, y0, x1, y1, add, erase };
}

/** Swaps the stored bytes with the live layers: undoes a stroke, and calling it again redoes it. */
export function swapStroke(e: StrokeEntry, w: number, add: Uint8Array, erase: Uint8Array): void {
  const rw = e.x1 - e.x0;
  for (let y = e.y0; y < e.y1; y++) {
    for (let x = e.x0; x < e.x1; x++) {
      const i = y * w + x, k = (y - e.y0) * rw + (x - e.x0);
      let t = add[i]; add[i] = e.add[k]; e.add[k] = t;
      t = erase[i]; erase[i] = e.erase[k]; e.erase[k] = t;
    }
  }
}
