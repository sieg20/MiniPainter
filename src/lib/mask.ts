import type { BBox, Img, Part, Stats } from '../store';

/** Final 0/1 mask = AI mask (+ brush additions) − brush erasures. */
function combine(part: Part, n: number): Uint8Array {
  const m = new Uint8Array(n);
  const sam = part.points.length ? part.samMasks[part.level] : undefined;
  if (sam) m.set(sam);
  const { add, erase } = part;
  if (add) for (let i = 0; i < n; i++) if (add[i]) m[i] = 1;
  if (erase) for (let i = 0; i < n; i++) if (erase[i]) m[i] = 0;
  return m;
}

function bboxOf(m: Uint8Array, w: number, h: number): BBox | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (m[row + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/** Soft 0–255 alpha via a small separable box blur, so edges blend instead of looking cut out. */
function feather(m: Uint8Array, w: number, h: number, bb: BBox, r = 1): { alpha: Uint8Array; bbox: BBox } {
  const x0 = Math.max(0, bb.x0 - r - 1), y0 = Math.max(0, bb.y0 - r - 1);
  const x1 = Math.min(w, bb.x1 + r + 1), y1 = Math.min(h, bb.y1 + r + 1);
  const tmp = new Float32Array(w * h);
  const alpha = new Uint8Array(w * h);
  const k = 2 * r + 1;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      let s = 0;
      for (let d = -r; d <= r; d++) {
        const xx = x + d;
        if (xx >= 0 && xx < w) s += m[y * w + xx];
      }
      tmp[y * w + x] = s / k;
    }
  }
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      let s = 0;
      for (let d = -r; d <= r; d++) {
        const yy = y + d;
        if (yy >= 0 && yy < h) s += tmp[yy * w + x];
      }
      alpha[y * w + x] = Math.round((s / k) * 255);
    }
  }
  return { alpha, bbox: { x0, y0, x1, y1 } };
}

/**
 * Lightness range of the selected area in the photo. Normalising against it is
 * the "lightness remap" that lets dark, already-painted models take light colours.
 */
function statsOf(L: Float32Array, m: Uint8Array, w: number, bb: BBox): Stats {
  const bins = new Uint32Array(256);
  let count = 0, sum = 0;
  for (let y = bb.y0; y < bb.y1; y++) {
    for (let x = bb.x0; x < bb.x1; x++) {
      const i = y * w + x;
      if (!m[i]) continue;
      const v = L[i];
      bins[Math.min(255, Math.max(0, (v * 255) | 0))]++;
      sum += v;
      count++;
    }
  }
  const pct = (p: number) => {
    const target = count * p;
    let acc = 0;
    for (let i = 0; i < 256; i++) {
      acc += bins[i];
      if (acc >= target) return i / 255;
    }
    return 1;
  };
  let lo = pct(0.03);
  let hi = pct(0.97);
  const mean = count ? sum / count : 0.5;
  if (hi - lo < 0.08) {
    lo = Math.max(0, mean - 0.04);
    hi = Math.min(1, mean + 0.04);
  }
  return { lo, hi, mean };
}

/** Recomputes the derived mask data after points or brush strokes change. */
export function rebuildPart(part: Part, img: Img): Part {
  const n = img.w * img.h;
  const m = combine(part, n);
  const bb = bboxOf(m, img.w, img.h);
  if (!bb) return { ...part, mask: null, alpha: null, bbox: null, stats: null };
  const { alpha, bbox } = feather(m, img.w, img.h, bb);
  return { ...part, mask: m, alpha, bbox, stats: statsOf(img.L, m, img.w, bb) };
}

/** Paints a filled circle into a 0/1 layer. */
export function stamp(layer: Uint8Array, w: number, h: number, cx: number, cy: number, r: number, v: number): void {
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
  const r2 = r * r;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r2) layer[y * w + x] = v;
    }
  }
}
