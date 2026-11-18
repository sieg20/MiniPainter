// OKLab colour helpers. OKLab separates lightness (L) from hue/chroma (a, b),
// which lets us keep the photo's light and shadow while swapping the colour.

const SRGB_TO_LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

const LUT_SIZE = 4096;
const LIN_TO_SRGB = new Uint8ClampedArray(LUT_SIZE + 1);
for (let i = 0; i <= LUT_SIZE; i++) {
  const v = i / LUT_SIZE;
  const s = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  LIN_TO_SRGB[i] = Math.round(s * 255);
}

function linTo8(v: number): number {
  if (v <= 0) return 0;
  if (v >= 1) return 255;
  return LIN_TO_SRGB[(v * LUT_SIZE + 0.5) | 0];
}

export type Lab = [number, number, number];

export function rgb8ToOklab(r8: number, g8: number, b8: number): Lab {
  const r = SRGB_TO_LIN[r8];
  const g = SRGB_TO_LIN[g8];
  const b = SRGB_TO_LIN[b8];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Lightness only — cheaper, used to precompute the photo's shading. */
export function rgb8ToOkL(r8: number, g8: number, b8: number): number {
  const r = SRGB_TO_LIN[r8];
  const g = SRGB_TO_LIN[g8];
  const b = SRGB_TO_LIN[b8];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}

/** Writes sRGB bytes into out[o..o+2]. */
export function oklabToRgb8(L: number, a: number, b: number, out: Uint8ClampedArray, o: number): void {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  out[o] = linTo8(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
  out[o + 1] = linTo8(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
  out[o + 2] = linTo8(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);
}

export function hexToOklab(hex: string): Lab {
  const n = parseInt(hex.slice(1), 16);
  return rgb8ToOklab((n >> 16) & 255, (n >> 8) & 255, n & 255);
}

/**
 * Parses what people type into a colour box. Accepts:
 *   #abc  abc  #aabbcc  aabbcc  rgb(170, 187, 204)  170,187,204  170 187 204
 * Returns a lowercase "#rrggbb", or null if it isn't a colour.
 */
export function parseColor(input: string): string | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;

  const hex = s.replace(/^#/, '');
  if (/^[0-9a-f]{3}$/.test(hex)) return '#' + [...hex].map((c) => c + c).join('');
  if (/^[0-9a-f]{6}$/.test(hex)) return '#' + hex;

  const nums = s.replace(/^rgba?\s*\(|\)$/g, '').split(/[\s,]+/).filter(Boolean);
  if (nums.length === 3 && nums.every((n) => /^\d{1,3}$/.test(n))) {
    const v = nums.map(Number);
    if (v.every((n) => n <= 255)) return '#' + v.map((n) => n.toString(16).padStart(2, '0')).join('');
  }
  return null;
}

export function hexToRgbText(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

/** Readable text colour on top of a swatch. */
export function textOn(hex: string): string {
  return hexToOklab(hex)[0] > 0.62 ? '#111' : '#fff';
}
