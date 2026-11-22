// Helpers that make the AI selector more accurate on miniature photos:
//  - subjectBox: finds the model against a plain backdrop, so the AI can analyse a
//    close crop instead of the whole photo (the AI only sees a 64×64 grid, so a
//    tighter crop means far more detail on the mini itself).
//  - refineMask: the AI's masks come from a 256×256 grid and have blobby edges;
//    this re-decides a thin band along the edge using the photo's colours and
//    edges (the same rules as Smart fill), keeping the AI's overall shape.
import type { Img, Pt } from '../store';
import { rgb8ToOklab } from './color';
import { planes } from './smartfill';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Bounding box of whatever stands out from the photo's border colours, padded.
 * Returns the whole photo when nothing clear stands out or the subject fills most of it.
 */
export function subjectBox(rgba: Uint8ClampedArray, w: number, h: number): Box {
  const full = { x: 0, y: 0, w, h };
  const step = Math.max(1, Math.round(Math.max(w, h) / 320));
  const gw = Math.floor(w / step), gh = Math.floor(h / step);
  if (gw < 16 || gh < 16) return full;
  const lab = (gx: number, gy: number) => {
    const o = (gy * step * w + gx * step) * 4;
    return rgb8ToOklab(rgba[o], rgba[o + 1], rgba[o + 2]);
  };
  // Sample the outer 3% ring as "backdrop" colours.
  const ring = Math.max(1, Math.round(Math.min(gw, gh) * 0.03));
  const bg: number[] = [];
  const border = gw * 2 + gh * 2;
  const every = Math.max(1, Math.floor((border * ring) / 400));
  let k = 0;
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const edge = gx < ring || gy < ring || gx >= gw - ring || gy >= gh - ring;
      if (!edge || k++ % every) continue;
      bg.push(...lab(gx, gy));
    }
  }
  const T2 = 0.06 * 0.06;
  const xs: number[] = [], ys: number[] = [];
  for (let gy = ring; gy < gh - ring; gy++) {
    for (let gx = ring; gx < gw - ring; gx++) {
      const [L, A, B] = lab(gx, gy);
      let near = false;
      for (let i = 0; i < bg.length; i += 3) {
        const dl = (L - bg[i]) * 0.5, da = A - bg[i + 1], db = B - bg[i + 2];
        if (dl * dl + da * da + db * db < T2) { near = true; break; }
      }
      if (!near) { xs.push(gx); ys.push(gy); }
    }
  }
  if (xs.length < 30) return full;
  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);
  const pick = (a: number[], q: number) => a[Math.min(a.length - 1, Math.floor(a.length * q))];
  let x0 = pick(xs, 0.005) * step, x1 = (pick(xs, 0.995) + 1) * step;
  let y0 = pick(ys, 0.005) * step, y1 = (pick(ys, 0.995) + 1) * step;
  // Generous padding: better to include some backdrop than to cut off part of the model.
  const pad = Math.max(32, 0.15 * Math.max(x1 - x0, y1 - y0));
  x0 = Math.max(0, Math.floor(x0 - pad)); y0 = Math.max(0, Math.floor(y0 - pad));
  x1 = Math.min(w, Math.ceil(x1 + pad)); y1 = Math.min(h, Math.ceil(y1 + pad));
  // Don't crop below 256px on the long side (the AI upscales the crop anyway).
  const grow = (a0: number, a1: number, max: number, min: number): [number, number] => {
    const need = min - (a1 - a0);
    if (need <= 0) return [a0, a1];
    const n0 = Math.max(0, a0 - Math.ceil(need / 2));
    return [n0, Math.min(max, n0 + min)];
  };
  [x0, x1] = grow(x0, x1, w, Math.min(w, 256));
  [y0, y1] = grow(y0, y1, h, Math.min(h, 256));
  const box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  // Not worth it if the subject already fills most of the photo.
  if (box.w * box.h > 0.6 * w * h) return full;
  return box;
}

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Square dilate/erode of radius r inside a rectangle, using running counts so the
 * cost doesn't grow with r. Pixels outside the image count as 0 (dilate) / 1 (erode).
 */
function morph(src: Uint8Array, w: number, h: number, r: number, b: Rect, dilate: boolean): Uint8Array {
  const tmp = new Uint8Array(src.length);
  const out = new Uint8Array(src.length);
  const pass = (from: Uint8Array, to: Uint8Array, horizontal: boolean) => {
    const [a0, a1, c0, c1, len] = horizontal ? [b.y0, b.y1, b.x0, b.x1, w] : [b.x0, b.x1, b.y0, b.y1, h];
    const stride = horizontal ? 1 : w;
    for (let a = a0; a < a1; a++) {
      const base = horizontal ? a * w : a;
      // Window [c - r, c + r] clipped to the image: cnt pixels, n of them set.
      let n = 0, cnt = 0;
      for (let c = c0 - r; c <= c0 + r; c++) if (c >= 0 && c < len) { cnt++; n += from[base + c * stride]; }
      for (let c = c0; c < c1; c++) {
        to[base + c * stride] = dilate ? (n > 0 ? 1 : 0) : n === cnt ? 1 : 0;
        const leave = c - r, enter = c + r + 1;
        if (leave >= 0) { cnt--; n -= from[base + leave * stride]; }
        if (enter < len) { cnt++; n += from[base + enter * stride]; }
      }
    }
  };
  pass(src, tmp, true);
  pass(tmp, out, false);
  return out;
}

/**
 * Snaps an AI mask's edges to the photo. Keeps the AI's confident interior (and any
 * thin parts, which have no interior). Each pixel in a band of radius r around the
 * edge then joins whichever side it is closer to in colour: the nearby interior or
 * the nearby outside. Comparing against nearby pixels copes with shading.
 */
export function refineMask(img: Img, m: Uint8Array, r: number): Uint8Array {
  const { w, h } = img;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (!m[row + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return m;
  const R = 2 * r; // window for the nearby colours
  const box = {
    m, x0: Math.max(0, x0 - R - 1), y0: Math.max(0, y0 - R - 1),
    x1: Math.min(w, x1 + R + 2), y1: Math.min(h, y1 + R + 2),
  };
  const core = morph(m, w, h, r, box, false);
  const opened = morph(core, w, h, r, box, true);
  const allowed = morph(m, w, h, r, box, true);
  const { L, A, B } = planes(img);
  const LW = 0.5; // shading matters less than colour
  const SAME2 = 0.04 * 0.04;
  const out = new Uint8Array(w * h);
  const s = r > 3 ? 2 : 1; // sample every other pixel in big windows
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      const i = y * w + x;
      if (core[i] || (m[i] && !opened[i])) { out[i] = 1; continue; } // trust the AI
      if (!allowed[i]) continue; // clearly outside
      let nI = 0, lI = 0, aI = 0, bI = 0, nO = 0, lO = 0, aO = 0, bO = 0;
      for (let yy = Math.max(0, y - R); yy <= Math.min(h - 1, y + R); yy += s) {
        for (let xx = Math.max(0, x - R); xx <= Math.min(w - 1, x + R); xx += s) {
          const j = yy * w + xx;
          if (core[j]) { nI++; lI += L[j]; aI += A[j]; bI += B[j]; }
          else if (!allowed[j]) { nO++; lO += L[j]; aO += A[j]; bO += B[j]; }
        }
      }
      if (!nI || !nO) { out[i] = m[i]; continue; }
      lI /= nI; aI /= nI; bI /= nI; lO /= nO; aO /= nO; bO /= nO;
      // Both sides look alike (e.g. a model primed in one colour): colour can't
      // tell them apart, so keep the AI's own edge here.
      if (((lI - lO) * LW) ** 2 + (aI - aO) ** 2 + (bI - bO) ** 2 < SAME2) { out[i] = m[i]; continue; }
      const dI = ((L[i] - lI) * LW) ** 2 + (A[i] - aI) ** 2 + (B[i] - bI) ** 2;
      const dO = ((L[i] - lO) * LW) ** 2 + (A[i] - aO) ** 2 + (B[i] - bO) ** 2;
      out[i] = dI <= dO ? 1 : 0;
    }
  }
  // Smooth single-pixel notches (closing, radius 1).
  return morph(morph(out, w, h, 1, box, true), w, h, 1, box, false);
}

/**
 * Trims an AI mask to the paint colour that was tapped. The AI selects objects
 * (a whole shoulder pad with its trim, or the whole model), but a paint area is one
 * colour. Keeps mask pixels whose hue/chroma match a tapped colour, ignoring
 * lightness (shading and metallic highlights), plus deep shadows and white
 * highlights that have no colour of their own. Small holes (rivets, engraving) are
 * filled, and only the area connected to a tap is kept.
 * Falls back to the untouched mask when the tap has no clear match.
 */
export function colourGate(img: Img, m: Uint8Array, points: Pt[]): Uint8Array {
  const { w, h } = img;
  const { L, A, B } = planes(img);
  const taps = points.filter((p) => p.label === 1).map((p) => {
    const x = Math.min(w - 1, Math.max(0, Math.floor(p.x * w)));
    const y = Math.min(h - 1, Math.max(0, Math.floor(p.y * h)));
    return y * w + x;
  });
  if (!taps.length) return m;
  // Reference colour per tap: median a/b over a small window (avoids a lone highlight pixel).
  const med = (v: number[]) => v.sort((p, q) => p - q)[v.length >> 1];
  const refs = taps.map((t) => {
    const tx = t % w, ty = (t - tx) / w;
    const as: number[] = [], bs: number[] = [];
    for (let y = Math.max(0, ty - 4); y <= Math.min(h - 1, ty + 4); y++) {
      for (let x = Math.max(0, tx - 4); x <= Math.min(w - 1, tx + 4); x++) {
        as.push(A[y * w + x]);
        bs.push(B[y * w + x]);
      }
    }
    const a = med(as), b = med(bs);
    return { a, b, c: Math.hypot(a, b), hue: Math.atan2(b, a) };
  });
  const HUE_WIDE = (35 * Math.PI) / 180, HUE_TIGHT = (20 * Math.PI) / 180;
  const match = (i: number) => {
    const a = A[i], b = B[i], c = Math.hypot(a, b), l = L[i];
    for (const r of refs) {
      if (r.c < 0.035) {
        // Grey, black or white paint: anything with little colour.
        if (c < Math.max(0.045, r.c + 0.025)) return true;
      } else if (c < 0.025) {
        // Colourless pixel on a coloured part: only shadows and glare count.
        if (l < 0.25 || l > 0.88) return true;
      } else {
        // Strong colours have a reliable hue, so match them tightly (red vs bronze
        // can be only ~30° apart); muted ones get more room. Chroma must be similar too.
        let d = Math.abs(Math.atan2(b, a) - r.hue);
        if (d > Math.PI) d = 2 * Math.PI - d;
        const t = Math.min(1, Math.max(0, (r.c - 0.06) / 0.06));
        const hueTol = HUE_WIDE - t * (HUE_WIDE - HUE_TIGHT);
        const cMin = (0.3 + 0.15 * t) * r.c, cMax = Math.max(2.2 * r.c, r.c + 0.08);
        if (d <= hueTol && c >= cMin && c <= cMax) return true;
      }
    }
    return false;
  };
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  const keep = new Uint8Array(w * h);
  for (let i = 0; i < m.length; i++) {
    if (!m[i] || !match(i)) continue;
    keep[i] = 1;
    const x = i % w, y = (i - x) / w;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (x1 < 0) return m;
  const box = { x0: Math.max(0, x0 - 3), y0: Math.max(0, y0 - 3), x1: Math.min(w, x1 + 4), y1: Math.min(h, y1 + 4) };
  // Fill small holes, but never grow past the AI's own outline.
  const closed = morph(morph(keep, w, h, 2, box, true), w, h, 2, box, false);
  for (let i = 0; i < closed.length; i++) closed[i] &= m[i];
  // Keep only what is connected to a tap.
  const out = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let tail = 0;
  for (const t of taps) {
    // The tap itself may sit on a rivet or glint; start from the nearest kept pixel.
    let s = -1;
    const tx = t % w, ty = (t - tx) / w;
    for (let rad = 0; rad <= 6 && s < 0; rad++) {
      for (let y = Math.max(0, ty - rad); y <= Math.min(h - 1, ty + rad) && s < 0; y++) {
        for (let x = Math.max(0, tx - rad); x <= Math.min(w - 1, tx + rad); x++) {
          if (closed[y * w + x]) { s = y * w + x; break; }
        }
      }
    }
    if (s >= 0 && !out[s]) { out[s] = 1; queue[tail++] = s; }
  }
  if (!tail) return m;
  let head = 0, n = 0;
  while (head < tail) {
    const c = queue[head++];
    n++;
    const x = c % w, y = (c - x) / w;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= w) continue;
        const j = yy * w + xx;
        if (closed[j] && !out[j]) { out[j] = 1; queue[tail++] = j; }
      }
    }
  }
  return n < 20 ? m : out;
}
