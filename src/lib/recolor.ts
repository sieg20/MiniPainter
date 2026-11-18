import { resolvePaint } from '../data/paints';
import type { Img, Part } from '../store';
import { hexToOklab, oklabToRgb8, rgb8ToOklab, type Lab } from './color';

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (t: number) => t * t * (3 - 2 * t);

let outBuf: Uint8ClampedArray | null = null;
const px = new Uint8ClampedArray(3);

/**
 * Renders the painted photo. For every part, each pixel keeps its *relative*
 * lightness from the photo (the real shading) and takes its colour from the paints:
 *   base      → hue/chroma + mid lightness
 *   wash      → pools into the darkest pixels (the recesses)
 *   highlight → lifts the brightest pixels (the edges catching light)
 */
export function renderScheme(img: Img, parts: Part[]): ImageData {
  const { w, h, rgba, L: Lsrc } = img;
  if (!outBuf || outBuf.length !== rgba.length) outBuf = new Uint8ClampedArray(rgba.length);
  const out = outBuf;
  out.set(rgba);

  for (const part of parts) {
    const { alpha, bbox, stats, recipe } = part;
    if (!alpha || !bbox || !stats) continue;
    const base = resolvePaint(recipe.base);
    const shade = resolvePaint(recipe.shade);
    const hi = resolvePaint(recipe.highlight);
    if (!base && !shade && !hi) continue;

    const baseLab: Lab | null = base ? hexToOklab(base.hex) : null;
    const shadeLab: Lab | null = shade ? hexToOklab(shade.hex) : null;
    const hiLab: Lab | null = hi ? hexToOklab(hi.hex) : null;
    const metal = base?.type === 'metallic';
    const contrast = base?.type === 'contrast';
    const depth = recipe.depth * (metal ? 1.5 : 1) * (contrast ? 1.35 : 1);
    const shadeAmt = shade ? recipe.shadeAmt : 0;
    const hiAmt = hi ? recipe.hiAmt : 0;

    const range = Math.max(0.02, stats.hi - stats.lo);
    const meanT = clamp01((stats.mean - stats.lo) / range);

    for (let y = bbox.y0; y < bbox.y1; y++) {
      for (let x = bbox.x0; x < bbox.x1; x++) {
        const i = y * w + x;
        const a8 = alpha[i];
        if (!a8) continue;
        const o = i * 4;

        // 0 = deepest recess in this part, 1 = brightest edge
        const t = clamp01((Lsrc[i] - stats.lo) / range);
        let L: number, A: number, B: number;

        if (baseLab) {
          const rel = t - meanT;
          L = baseLab[0] + rel * 0.55 * depth;
          const chroma = Math.max(0.35, 1 - Math.abs(rel) * 0.5 * depth);
          A = baseLab[1] * chroma;
          B = baseLab[2] * chroma;
          if (metal) {
            const spec = smooth(clamp01((t - 0.78) / 0.22));
            L += spec * 0.28;
            A *= 1 - spec * 0.6;
            B *= 1 - spec * 0.6;
          }
        } else {
          [L, A, B] = rgb8ToOklab(rgba[o], rgba[o + 1], rgba[o + 2]);
        }

        if (shadeLab && shadeAmt > 0) {
          const recess = smooth(clamp01(1 - t / 0.6));
          const r = clamp01(recess * shadeAmt + 0.12 * shadeAmt);
          L += (Math.min(L, shadeLab[0] + 0.05) - L) * r;
          A += (shadeLab[1] - A) * r * 0.9;
          B += (shadeLab[2] - B) * r * 0.9;
        }

        if (hiLab && hiAmt > 0) {
          const e = smooth(clamp01((t - 0.62) / 0.33)) * hiAmt;
          L += (hiLab[0] - L) * e;
          A += (hiLab[1] - A) * e;
          B += (hiLab[2] - B) * e;
        }

        oklabToRgb8(clamp01(L), A, B, px, 0);
        const k = a8 / 255;
        out[o] = out[o] + (px[0] - out[o]) * k;
        out[o + 1] = out[o + 1] + (px[1] - out[o + 1]) * k;
        out[o + 2] = out[o + 2] + (px[2] - out[o + 2]) * k;
      }
    }
  }
  return new ImageData(out, w, h);
}
