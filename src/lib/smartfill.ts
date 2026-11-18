// "Smart fill": a light, non-AI selector that works on any device.
// From each tap it grows a region through pixels of similar colour, following
// smooth shading but stopping at sharp edges (crevices, part boundaries).
// It returns three candidates (small → large) like the AI selector does.
import type { Img, Pt } from '../store';
import { rgb8ToOklab } from './color';

const LEVELS = [
  { global: 0.06, step: 0.022, close: 1 },
  { global: 0.1, step: 0.035, close: 2 },
  { global: 0.16, step: 0.055, close: 2 },
];
/** Lightness counts less than colour, so shading inside one part doesn't stop the fill. */
const L_WEIGHT = 0.4;

interface Planes {
  rgba: Uint8ClampedArray;
  L: Float32Array;
  A: Float32Array;
  B: Float32Array;
}
let cache: Planes | null = null;

function blur3(src: Float32Array, w: number, h: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) {
      const l = x > 0 ? x - 1 : x, rr = x < w - 1 ? x + 1 : x;
      tmp[r + x] = (src[r + l] + src[r + x] + src[r + rr]) / 3;
    }
  }
  for (let y = 0; y < h; y++) {
    const u = (y > 0 ? y - 1 : y) * w, c = y * w, d = (y < h - 1 ? y + 1 : y) * w;
    for (let x = 0; x < w; x++) out[c + x] = (tmp[u + x] + tmp[c + x] + tmp[d + x]) / 3;
  }
  return out;
}

/** OKLab planes of the photo, lightly blurred so JPEG noise doesn't look like edges. */
function planes(img: Img): Planes {
  if (cache && cache.rgba === img.rgba) return cache;
  const n = img.w * img.h;
  const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
  const d = img.rgba;
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    const lab = rgb8ToOklab(d[o], d[o + 1], d[o + 2]);
    L[i] = lab[0];
    A[i] = lab[1];
    B[i] = lab[2];
  }
  cache = { rgba: img.rgba, L: blur3(L, img.w, img.h), A: blur3(A, img.w, img.h), B: blur3(B, img.w, img.h) };
  return cache;
}

interface Region {
  m: Uint8Array;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function grow(p: Planes, w: number, h: number, seed: number, lv: (typeof LEVELS)[number], queue: Int32Array): Region {
  const { L, A, B } = p;
  const m = new Uint8Array(w * h);
  const L0 = L[seed], A0 = A[seed], B0 = B[seed];
  const g2 = lv.global * lv.global, s2 = lv.step * lv.step;
  let head = 0, tail = 0;
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  m[seed] = 1;
  queue[tail++] = seed;
  while (head < tail) {
    const c = queue[head++];
    const x = c % w, y = (c - x) / w;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    for (let k = 0; k < 4; k++) {
      let n: number;
      if (k === 0) { if (x === 0) continue; n = c - 1; }
      else if (k === 1) { if (x === w - 1) continue; n = c + 1; }
      else if (k === 2) { if (y === 0) continue; n = c - w; }
      else { if (y === h - 1) continue; n = c + w; }
      if (m[n]) continue;
      const dl = L[n] - L[c], da = A[n] - A[c], db = B[n] - B[c];
      if (dl * dl + da * da + db * db > s2) continue; // sharp edge
      const gl = (L[n] - L0) * L_WEIGHT, ga = A[n] - A0, gb = B[n] - B0;
      if (gl * gl + ga * ga + gb * gb > g2) continue; // different colour
      m[n] = 1;
      queue[tail++] = n;
    }
  }
  return { m, x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/** One pass of a (2r+1)² square max (dilate) or min (erode), only inside the box. */
function morph(src: Uint8Array, w: number, h: number, r: number, box: Region, dilate: boolean): Uint8Array {
  const out = new Uint8Array(src.length);
  const tmp = new Uint8Array(src.length);
  const { x0, y0, x1, y1 } = box;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      let v = dilate ? 0 : 1;
      for (let d = -r; d <= r; d++) {
        const xx = x + d;
        const s = xx < 0 || xx >= w ? (dilate ? 0 : 1) : src[y * w + xx];
        if (dilate ? s : !s) { v = dilate ? 1 : 0; break; }
      }
      tmp[y * w + x] = v;
    }
  }
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      let v = dilate ? 0 : 1;
      for (let d = -r; d <= r; d++) {
        const yy = y + d;
        const s = yy < 0 || yy >= h ? (dilate ? 0 : 1) : tmp[yy * w + x];
        if (dilate ? s : !s) { v = dilate ? 1 : 0; break; }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

/** Fills pinholes and smooths ragged edges (morphological closing). */
function close(reg: Region, w: number, h: number, r: number): Uint8Array {
  const box = {
    ...reg,
    x0: Math.max(0, reg.x0 - r), y0: Math.max(0, reg.y0 - r),
    x1: Math.min(w, reg.x1 + r), y1: Math.min(h, reg.y1 + r),
  };
  return morph(morph(reg.m, w, h, r, box, true), w, h, r, box, false);
}

export async function smartFill(img: Img, points: Pt[]): Promise<{ masks: Uint8Array[]; scores: number[] }> {
  await new Promise((r) => setTimeout(r, 16)); // let "Finding part…" appear first
  const { w, h } = img;
  const p = planes(img);
  const queue = new Int32Array(w * h);
  const masks = LEVELS.map((lv) => {
    const out = new Uint8Array(w * h);
    // Include taps first, then exclude taps, whatever order they were made in.
    for (const pt of [...points].sort((a, b) => b.label - a.label)) {
      const x = Math.min(w - 1, Math.max(0, Math.floor(pt.x * w)));
      const y = Math.min(h - 1, Math.max(0, Math.floor(pt.y * h)));
      const m = close(grow(p, w, h, y * w + x, lv, queue), w, h, lv.close);
      // Include taps add their region; exclude taps cut theirs out.
      if (pt.label) for (let i = 0; i < m.length; i++) out[i] |= m[i];
      else for (let i = 0; i < m.length; i++) if (m[i]) out[i] = 0;
    }
    return out;
  });
  return { masks, scores: [0.6, 1, 0.5] }; // medium is the default pick
}
