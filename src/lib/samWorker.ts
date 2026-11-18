// Runs Segment Anything (SlimSAM) entirely in the browser.
// The photo never leaves the device; only the model weights are downloaded (once, then cached).
import { AutoProcessor, RawImage, SamModel, Tensor, env } from '@huggingface/transformers';

env.allowLocalModels = false;

const MODEL_ID = 'Xenova/slimsam-77-uniform';
const ctx = self as unknown as Worker;

/* eslint-disable @typescript-eslint/no-explicit-any */
let model: any = null;
let processor: any = null;
let inputs: any = null;
let embeddings: any = null;

type InMsg =
  | { type: 'load' }
  | { type: 'embed'; rgba: ArrayBuffer; w: number; h: number }
  | { type: 'decode'; id: number; points: { x: number; y: number; label: 0 | 1 }[] };

const progress = (p: any) => {
  if (p.status === 'progress' && typeof p.progress === 'number') {
    ctx.postMessage({ type: 'progress', file: p.file, progress: p.progress });
  }
};

async function load() {
  if (model) return;
  ctx.postMessage({ type: 'status', status: 'loading' });
  processor = await AutoProcessor.from_pretrained(MODEL_ID, { progress_callback: progress });
  let device = 'wasm';
  const gpu = (navigator as any).gpu;
  if (gpu) {
    try {
      const adapter = await gpu.requestAdapter();
      if (adapter) {
        model = await SamModel.from_pretrained(MODEL_ID, { device: 'webgpu', dtype: 'fp32', progress_callback: progress });
        device = 'webgpu';
      }
    } catch {
      model = null;
    }
  }
  if (!model) {
    model = await SamModel.from_pretrained(MODEL_ID, { device: 'wasm', dtype: 'q8', progress_callback: progress });
  }
  ctx.postMessage({ type: 'status', status: 'ready', device });
}

async function embed(rgba: ArrayBuffer, w: number, h: number) {
  await load();
  ctx.postMessage({ type: 'status', status: 'embedding' });
  const image = new RawImage(new Uint8ClampedArray(rgba), w, h, 4).rgb();
  inputs = await processor(image);
  embeddings = await model.get_image_embeddings(inputs);
  ctx.postMessage({ type: 'status', status: 'ready' });
}

async function decode(id: number, points: { x: number; y: number; label: 0 | 1 }[]) {
  if (!embeddings) throw new Error('No image embedded yet');
  const [rh, rw] = inputs.reshaped_input_sizes[0];
  const coords = new Float32Array(points.flatMap((p) => [p.x * rw, p.y * rh]));
  const labels = BigInt64Array.from(points.map((p) => BigInt(p.label)));
  const input_points = new Tensor('float32', coords, [1, 1, points.length, 2]);
  const input_labels = new Tensor('int64', labels, [1, 1, points.length]);
  const out = await model({ ...embeddings, input_points, input_labels });
  const masks = await processor.post_process_masks(out.pred_masks, inputs.original_sizes, inputs.reshaped_input_sizes);
  const t = masks[0];
  const [, k, H, W] = t.dims as number[];
  const data = t.data as Uint8Array;
  const list: Uint8Array[] = [];
  for (let j = 0; j < k; j++) list.push(data.slice(j * H * W, (j + 1) * H * W));
  const scores = Array.from(out.iou_scores.data as Float32Array);
  ctx.postMessage({ type: 'decoded', id, masks: list, scores, w: W, h: H }, list.map((m) => m.buffer));
}

let chain: Promise<void> = Promise.resolve();
ctx.onmessage = (e: MessageEvent<InMsg>) => {
  const msg = e.data;
  chain = chain
    .then(async () => {
      if (msg.type === 'load') await load();
      else if (msg.type === 'embed') await embed(msg.rgba, msg.w, msg.h);
      else if (msg.type === 'decode') await decode(msg.id, msg.points);
    })
    .catch((err) => {
      ctx.postMessage({
        type: 'error',
        id: msg.type === 'decode' ? msg.id : undefined,
        message: err instanceof Error ? err.message : String(err),
      });
    });
};
