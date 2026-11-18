import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { stamp } from '../lib/mask';
import { renderScheme } from '../lib/recolor';
import { useStore } from '../store';

interface View {
  x: number;
  y: number;
  z: number;
}

export function Stage() {
  const img = useStore((s) => s.image);
  const parts = useStore((s) => s.parts);
  const selectedId = useStore((s) => s.selectedId);
  const tool = useStore((s) => s.tool);
  const showOriginal = useStore((s) => s.showOriginal);
  const showMask = useStore((s) => s.showMask);
  const brushSize = useStore((s) => s.brushSize);
  const pointLabel = useStore((s) => s.pointLabel);
  const busy = useStore((s) => s.busy);

  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, z: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [spaceDown, setSpaceDown] = useState(false);

  const drag = useRef<
    | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number }
    | {
        kind: 'brush'; pointerId: number; id: string; mode: 'brush' | 'erase'; last: { x: number; y: number };
        paint: Uint8Array; other: Uint8Array;
        /** Layer copies taken at the start of a touch stroke, so a pinch can cancel it. */
        undo?: { paint: Uint8Array; other: Uint8Array };
      }
    // A finger is down in select mode: a tap adds a point, a drag pans.
    | { kind: 'tap'; pointerId: number; sx: number; sy: number; vx: number; vy: number }
    | { kind: 'pinch'; d0: number; mx: number; my: number; v0: View }
    // A gesture ended but fingers are still down: ignore them until all lift.
    | { kind: 'done' }
    | null
  >(null);
  /** Touch points currently down, in client coordinates. */
  const touches = useRef(new Map<number, { x: number; y: number }>());

  const selected = parts.find((p) => p.id === selectedId) ?? null;

  // Fit the photo to the stage when a new one is loaded.
  const fit = () => {
    const box = boxRef.current;
    if (!img || !box) return;
    const r = box.getBoundingClientRect();
    const z = Math.min(r.width / img.w, r.height / img.h) * 0.94;
    setView({ z, x: (r.width - img.w * z) / 2, y: (r.height - img.h * z) / 2 });
  };
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    fit();
    // Re-fit when the stage changes size (window resize, phone rotation).
    const ro = new ResizeObserver(() => fit());
    ro.observe(box);
    return () => ro.disconnect();
  }, [img]);
  useEffect(() => {
    const onFit = () => fit();
    window.addEventListener('stage:fit', onFit);
    return () => window.removeEventListener('stage:fit', onFit);
  });

  // Paint render.
  useEffect(() => {
    const c = canvasRef.current;
    if (!img || !c) return;
    const raf = requestAnimationFrame(() => {
      const ctx = c.getContext('2d')!;
      if (showOriginal) ctx.putImageData(new ImageData(new Uint8ClampedArray(img.rgba), img.w, img.h), 0, 0);
      else ctx.putImageData(renderScheme(img, parts), 0, 0);
    });
    return () => cancelAnimationFrame(raf);
  }, [img, parts, showOriginal]);

  // Selection overlay: tint of the selected part + its click points.
  const drawOverlay = () => {
    const o = overlayRef.current;
    if (!img || !o) return;
    const ctx = o.getContext('2d')!;
    ctx.clearRect(0, 0, o.width, o.height);
    if (!selected || showOriginal || !showMask) return;
    const { mask, bbox } = selected;
    // Once a part has paint, show just its outline so the tint doesn't mask the colour.
    const fill = selected.recipe.base || selected.recipe.shade || selected.recipe.highlight ? 0 : 70;
    if (mask && bbox) {
      const bw = bbox.x1 - bbox.x0, bh = bbox.y1 - bbox.y0;
      const id = ctx.createImageData(bw, bh);
      const d = id.data;
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          const gi = (y + bbox.y0) * img.w + (x + bbox.x0);
          if (!mask[gi]) continue;
          const edge =
            !mask[gi - 1] || !mask[gi + 1] || !mask[gi - img.w] || !mask[gi + img.w];
          if (!edge && !fill) continue;
          const k = (y * bw + x) * 4;
          d[k] = edge ? 255 : 80;
          d[k + 1] = edge ? 255 : 200;
          d[k + 2] = 255;
          d[k + 3] = edge ? 230 : fill;
        }
      }
      ctx.putImageData(id, bbox.x0, bbox.y0);
    }
    const r = Math.max(3, 7 / viewRef.current.z);
    for (const p of selected.points) {
      ctx.beginPath();
      ctx.arc(p.x * img.w, p.y * img.h, r, 0, Math.PI * 2);
      ctx.fillStyle = p.label ? '#2ecc71' : '#e74c3c';
      ctx.fill();
      ctx.lineWidth = r * 0.35;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    }
  };
  useEffect(drawOverlay, [img, selected, showOriginal, showMask, view.z]);

  // Mouse-wheel zoom around the cursor.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = box.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const v = viewRef.current;
      const z = Math.min(20, Math.max(0.05, v.z * Math.exp(-e.deltaY * 0.0015)));
      setView({ z, x: mx - (mx - v.x) * (z / v.z), y: my - (my - v.y) * (z / v.z) });
    };
    box.addEventListener('wheel', onWheel, { passive: false });
    return () => box.removeEventListener('wheel', onWheel);
  }, [img]);

  // Hold space to pan.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        setSpaceDown(true);
      }
    };
    const up = (e: KeyboardEvent) => e.code === 'Space' && setSpaceDown(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  const toImage = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * img!.w, y: ((e.clientY - r.top) / r.height) * img!.h };
  };

  const brushTool = tool === 'brush' || tool === 'erase';
  const panning = tool === 'pan' || spaceDown;

  const boxPoint = (p: { x: number; y: number }) => {
    const r = boxRef.current!.getBoundingClientRect();
    return { x: p.x - r.left, y: p.y - r.top };
  };

  /** Starts a pinch from the first two fingers down. */
  const startPinch = () => {
    const [a, b] = [...touches.current.values()];
    const m = boxPoint({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    drag.current = { kind: 'pinch', d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), mx: m.x, my: m.y, v0: viewRef.current };
  };

  /** Throws away a touch brush stroke (a second finger landed, so it's a pinch). */
  const cancelStroke = () => {
    const d = drag.current;
    if (d?.kind !== 'brush') return;
    if (d.undo) {
      d.paint.set(d.undo.paint);
      d.other.set(d.undo.other);
    }
    drag.current = null;
    useStore.getState().commitBrush(d.id);
    drawOverlay(); // clears the stroke preview
  };

  const startBrush = (e: RPointerEvent<HTMLDivElement>, p: { x: number; y: number }, mode: 'brush' | 'erase') => {
    const st = useStore.getState();
    const id = st.selectedId ?? st.newPart();
    const layers = useStore.getState().brushLayers(id, mode);
    if (!layers || !img) return;
    const undo = e.pointerType === 'touch' ? { paint: layers.paint.slice(), other: layers.other.slice() } : undefined;
    const r = brushSize / 2;
    stamp(layers.paint, img.w, img.h, p.x, p.y, r, 1);
    stamp(layers.other, img.w, img.h, p.x, p.y, r, 0);
    drag.current = { kind: 'brush', pointerId: e.pointerId, id, mode, last: p, ...layers, undo };
    paintPreview(p, p, mode);
  };

  const onTouchDown = (e: RPointerEvent<HTMLDivElement>) => {
    touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    e.currentTarget.setPointerCapture(e.pointerId);
    if (cursorRef.current) cursorRef.current.style.display = 'none';
    const n = touches.current.size;
    if (n === 2) {
      cancelStroke();
      startPinch();
      return;
    }
    if (n > 2 || drag.current) return;
    const v = viewRef.current;
    if (tool === 'select' || panning) {
      drag.current = panning
        ? { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: v.x, vy: v.y }
        : { kind: 'tap', pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, vx: v.x, vy: v.y };
      return;
    }
    const p = toImage(e);
    if (p.x < 0 || p.y < 0 || p.x >= img!.w || p.y >= img!.h) return;
    if (brushTool) startBrush(e, p, tool);
  };

  const onTouchMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (!touches.current.has(e.pointerId)) return;
    touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const d = drag.current;
    if (d?.kind === 'pinch') {
      const [a, b] = [...touches.current.values()];
      const m = boxPoint({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      const z = Math.min(20, Math.max(0.05, (d.v0.z * Math.hypot(a.x - b.x, a.y - b.y)) / d.d0));
      // Keep the photo point that was under the fingers' midpoint under it, so pinch also pans.
      setView({ z, x: m.x - (d.mx - d.v0.x) * (z / d.v0.z), y: m.y - (d.my - d.v0.y) * (z / d.v0.z) });
      return;
    }
    if (d?.kind === 'tap' && d.pointerId === e.pointerId) {
      // Moved too far for a tap: one-finger drag pans instead.
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 10) {
        drag.current = { kind: 'pan', sx: d.sx, sy: d.sy, vx: d.vx, vy: d.vy };
      } else return;
    }
    if (drag.current?.kind === 'brush' && drag.current.pointerId !== e.pointerId) return;
    onMove(e);
  };

  const onTouchUp = (e: RPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    if (!touches.current.delete(e.pointerId)) return;
    const d = drag.current;
    if (d?.kind === 'tap' && d.pointerId === e.pointerId && !cancelled && img) {
      const p = toImage({ clientX: d.sx, clientY: d.sy });
      if (p.x >= 0 && p.y >= 0 && p.x < img.w && p.y < img.h) {
        useStore.getState().addPoint({ x: p.x / img.w, y: p.y / img.h, label: pointLabel });
      }
    }
    if (d?.kind === 'brush' && d.pointerId !== e.pointerId) return;
    if (d?.kind === 'brush' || d?.kind === 'tap' || d?.kind === 'pan') onUp();
    // Lifting one finger of a pinch shouldn't turn the other into a tap, pan or stroke.
    drag.current = touches.current.size ? { kind: 'done' } : null;
  };

  const onDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (!img) return;
    if (e.pointerType === 'touch') return onTouchDown(e);
    if (e.button === 1 || panning) {
      drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    const p = toImage(e);
    if (p.x < 0 || p.y < 0 || p.x >= img.w || p.y >= img.h) return;
    const st = useStore.getState();

    if (tool === 'select') {
      const label: 0 | 1 = e.button === 2 || e.altKey ? 0 : pointLabel;
      st.addPoint({ x: p.x / img.w, y: p.y / img.h, label });
      return;
    }

    if (brushTool) {
      startBrush(e, p, tool);
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  };

  const paintPreview = (a: { x: number; y: number }, b: { x: number; y: number }, mode: 'brush' | 'erase') => {
    const ctx = overlayRef.current?.getContext('2d');
    if (!ctx) return;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = mode === 'brush' ? 'rgba(80,200,255,0.55)' : 'rgba(231,76,60,0.6)';
    ctx.lineWidth = brushSize;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x + 0.01, b.y);
    ctx.stroke();
    ctx.restore();
  };

  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (!img) return;
    const cur = cursorRef.current;
    if (cur && e.pointerType !== 'touch') {
      const p = toImage(e);
      cur.style.display = brushTool && !panning ? 'block' : 'none';
      cur.style.transform = `translate(${p.x - brushSize / 2}px, ${p.y - brushSize / 2}px)`;
    }
    const d = drag.current;
    if (!d || d.kind === 'tap' || d.kind === 'pinch' || d.kind === 'done') return;
    if (d.kind === 'pan') {
      setView((v) => ({ ...v, x: d.vx + e.clientX - d.sx, y: d.vy + e.clientY - d.sy }));
      return;
    }
    const p = toImage(e);
    const r = brushSize / 2;
    const dist = Math.hypot(p.x - d.last.x, p.y - d.last.y);
    const steps = Math.max(1, Math.ceil(dist / Math.max(1, r / 2)));
    for (let s = 1; s <= steps; s++) {
      const x = d.last.x + ((p.x - d.last.x) * s) / steps;
      const y = d.last.y + ((p.y - d.last.y) * s) / steps;
      stamp(d.paint, img.w, img.h, x, y, r, 1);
      stamp(d.other, img.w, img.h, x, y, r, 0);
    }
    paintPreview(d.last, p, d.mode);
    d.last = p;
  };

  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.kind === 'brush') useStore.getState().commitBrush(d.id);
  };

  if (!img) return null;

  const cursor = panning ? (drag.current?.kind === 'pan' ? 'grabbing' : 'grab') : brushTool ? 'none' : 'crosshair';

  return (
    <div
      ref={boxRef}
      className="stage"
      style={{ cursor }}
      onPointerDown={onDown}
      onPointerMove={(e) => (e.pointerType === 'touch' ? onTouchMove(e) : onMove(e))}
      onPointerUp={(e) => (e.pointerType === 'touch' ? onTouchUp(e, false) : onUp())}
      onPointerCancel={(e) => (e.pointerType === 'touch' ? onTouchUp(e, true) : onUp())}
      onPointerLeave={() => cursorRef.current && (cursorRef.current.style.display = 'none')}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        className="stage-layer"
        style={{
          width: img.w,
          height: img.h,
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})`,
        }}
      >
        <canvas id="paint-canvas" ref={canvasRef} width={img.w} height={img.h} />
        <canvas ref={overlayRef} width={img.w} height={img.h} className="overlay" />
        <div
          ref={cursorRef}
          className={`brush-cursor ${tool === 'erase' ? 'erase' : ''}`}
          style={{ width: brushSize, height: brushSize, borderWidth: 1.5 / view.z }}
        />
      </div>
      {busy && <div className="stage-busy">Finding part…</div>}
      {showOriginal && <div className="stage-badge">Original</div>}
    </div>
  );
}
