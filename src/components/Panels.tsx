import { useEffect, useMemo, useRef, useState } from 'react';
import { BRANDS, PAINTS, TYPES, isCustom, resolvePaint, typeLabel, type Brand, type PaintType } from '../data/paints';
import { hexToRgbText, parseColor, textOn } from '../lib/color';
import { PART_NAMES, useStore, type Slot, type Tool } from '../store';

/* --------------------------------- Stepper -------------------------------- */

/** Slider with − / + buttons for fine steps. Hold a button to keep stepping. */
function Stepper(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const { label, value, min, max, step, disabled, format, onChange } = props;
  const latest = useRef(value);
  latest.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const timers = useRef<{ delay?: number; repeat?: number }>({});

  const stop = () => {
    window.clearTimeout(timers.current.delay);
    window.clearInterval(timers.current.repeat);
  };
  useEffect(() => stop, []);

  const bump = (dir: 1 | -1) => {
    const v = Math.min(max, Math.max(min, +(latest.current + dir * step).toFixed(4)));
    if (v === latest.current) return stop(); // reached the end
    latest.current = v;
    onChangeRef.current(v);
  };

  const button = (dir: 1 | -1) => (
    <button
      type="button"
      className="step"
      aria-label={`${dir < 0 ? 'Decrease' : 'Increase'} ${label}`}
      title={`${dir < 0 ? 'Decrease' : 'Increase'} (hold to repeat)`}
      disabled={disabled || (dir < 0 ? value <= min : value >= max)}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        stop();
        bump(dir);
        timers.current.delay = window.setTimeout(() => {
          timers.current.repeat = window.setInterval(() => bump(dir), 70);
        }, 400);
      }}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onContextMenu={(e) => e.preventDefault()}
      // Keyboard (Enter/Space) clicks have detail 0; pointer presses are handled above.
      onClick={(e) => e.detail === 0 && bump(dir)}
    >
      {dir < 0 ? '−' : '+'}
    </button>
  );

  return (
    <div className="row stepper">
      <span className="label">{label}</span>
      {button(-1)}
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(+e.target.value)}
      />
      {button(1)}
      <span className="num">{format(value)}</span>
    </div>
  );
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

/* ---------------------------------- Tools --------------------------------- */

const TOOLS: { id: Tool; label: string; key: string; hint: string }[] = [
  { id: 'select', label: 'Select', key: 'S', hint: 'Tap a part of the model. Alt/right-click to exclude an area.' },
  { id: 'brush', label: 'Brush', key: 'B', hint: 'Paint extra area into the selected part.' },
  { id: 'erase', label: 'Erase', key: 'E', hint: 'Remove area from the selected part.' },
  { id: 'pan', label: 'Pan', key: 'H', hint: 'Drag to move. Scroll to zoom. Hold Space to pan from any tool.' },
];

export function ToolsPanel() {
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const pointLabel = useStore((s) => s.pointLabel);
  const setPointLabel = useStore((s) => s.setPointLabel);
  const brushSize = useStore((s) => s.brushSize);
  const setBrushSize = useStore((s) => s.setBrushSize);
  const showMask = useStore((s) => s.showMask);
  const setShowMask = useStore((s) => s.setShowMask);
  const part = useStore((s) => s.parts.find((p) => p.id === s.selectedId) ?? null);
  const setLevel = useStore((s) => s.setLevel);
  const clearPoints = useStore((s) => s.clearPoints);
  const selector = useStore((s) => s.selector);
  const lowMemory = useStore((s) => s.lowMemory);

  const chooseSelector = (s: 'ai' | 'fill') => {
    if (s === selector) return;
    if (
      s === 'ai' && lowMemory &&
      !confirm('The AI selector needs a lot of memory and may crash on phones and tablets. If it does, the page reloads and switches back to Smart fill. Try it?')
    ) return;
    useStore.getState().setSelector(s);
  };

  return (
    <section className="panel">
      <h2>Tools</h2>
      <div className="seg">
        {TOOLS.map((t) => (
          <button key={t.id} className={tool === t.id ? 'on' : ''} onClick={() => setTool(t.id)} title={`${t.label} (${t.key})`}>
            {t.label}
          </button>
        ))}
      </div>
      <p className="hint">{TOOLS.find((t) => t.id === tool)?.hint}</p>

      {tool === 'select' && (
        <div className="row">
          <span className="label">Tap to</span>
          <div className="seg small">
            <button className={pointLabel === 1 ? 'on' : ''} onClick={() => setPointLabel(1)}>Add</button>
            <button className={pointLabel === 0 ? 'on' : ''} onClick={() => setPointLabel(0)}>Exclude</button>
          </div>
        </div>
      )}

      {tool === 'select' && (
        <>
          <div className="row">
            <span className="label">Selector</span>
            <div className="seg small">
              <button className={selector === 'ai' ? 'on' : ''} onClick={() => chooseSelector('ai')}>AI</button>
              <button className={selector === 'fill' ? 'on' : ''} onClick={() => chooseSelector('fill')}>Smart fill</button>
            </div>
          </div>
          <p className="hint">
            {selector === 'ai'
              ? 'AI finds whole parts, even on a primed model. Needs a computer’s memory.'
              : 'Smart fill spreads from your tap through similar colour and stops at edges. Works on any device; best on painted models.'}
          </p>
        </>
      )}

      {(tool === 'brush' || tool === 'erase') && (
        <Stepper label="Size" value={brushSize} min={2} max={120} step={1} format={String} onChange={setBrushSize} />
      )}

      {part && part.samMasks.length > 1 && (
        <div className="row">
          <span className="label">Area size</span>
          <div className="seg small">
            {part.samMasks.map((_, i) => (
              <button key={i} className={part.level === i ? 'on' : ''} onClick={() => setLevel(i)}>
                {['Small', 'Medium', 'Large'][i] ?? i + 1}
              </button>
            ))}
          </div>
        </div>
      )}

      {part && (part.points.length > 0 || part.add) && (
        <div className="row">
          <button className="ghost" onClick={clearPoints}>Clear area</button>
        </div>
      )}

      <label className="check">
        <input type="checkbox" checked={showMask} onChange={(e) => setShowMask(e.target.checked)} />
        Show selected area
      </label>
    </section>
  );
}

/* ---------------------------------- Parts --------------------------------- */

export function PartsPanel() {
  const parts = useStore((s) => s.parts);
  const selectedId = useStore((s) => s.selectedId);
  const { newPart, selectPart, renamePart, deletePart, movePart, setTool } = useStore.getState();

  return (
    <section className="panel grow">
      <div className="panel-head">
        <h2>Parts</h2>
        <button
          className="primary small"
          onClick={() => {
            newPart();
            setTool('select');
          }}
        >
          + New part
        </button>
      </div>
      {parts.length === 0 && (
        <p className="hint">
          Tap the model to select your first part (e.g. the armour). Each part gets its own paints.
        </p>
      )}
      <datalist id="part-names">
        {PART_NAMES.map((n) => <option key={n} value={n} />)}
      </datalist>
      <ul className="parts">
        {parts.map((p, i) => {
          const base = resolvePaint(p.recipe.base);
          return (
            <li key={p.id} className={p.id === selectedId ? 'on' : ''} onClick={() => selectPart(p.id)}>
              <span className="swatch" style={{ background: base?.hex ?? 'transparent' }} />
              <input
                list="part-names"
                value={p.name}
                onChange={(e) => renamePart(p.id, e.target.value)}
                onFocus={() => selectPart(p.id)}
              />
              {!p.mask && <span className="tag">empty</span>}
              <span className="part-actions">
                <button title="Move up" disabled={i === 0} onClick={(e) => { e.stopPropagation(); movePart(p.id, -1); }}>↑</button>
                <button title="Move down" disabled={i === parts.length - 1} onClick={(e) => { e.stopPropagation(); movePart(p.id, 1); }}>↓</button>
                <button title="Delete part" onClick={(e) => { e.stopPropagation(); deletePart(p.id); }}>×</button>
              </span>
            </li>
          );
        })}
      </ul>
      {parts.length > 1 && <p className="hint">Lower parts paint over higher ones where they overlap.</p>}
    </section>
  );
}

/* --------------------------------- Recipe --------------------------------- */

const SLOTS: { id: Slot; label: string; desc: string }[] = [
  { id: 'base', label: 'Base coat', desc: 'Main colour' },
  { id: 'shade', label: 'Wash', desc: 'Pools in recesses' },
  { id: 'highlight', label: 'Highlight', desc: 'Lifts raised edges' },
];

export function RecipePanel() {
  const part = useStore((s) => s.parts.find((p) => p.id === s.selectedId) ?? null);
  const activeSlot = useStore((s) => s.activeSlot);
  const { setActiveSlot, clearSlot, setRecipeValue, applyPaint } = useStore.getState();

  if (!part) {
    return (
      <section className="panel">
        <h2>Recipe</h2>
        <p className="hint">Select a part to choose its paints.</p>
      </section>
    );
  }
  const r = part.recipe;
  const currentHex = resolvePaint(r[activeSlot])?.hex ?? null;
  const slotLabel = SLOTS.find((s) => s.id === activeSlot)!.label.toLowerCase();

  return (
    <section className="panel">
      <h2>Recipe · {part.name || 'Unnamed'}</h2>
      <div className="slots">
        {SLOTS.map((s) => {
          const paint = resolvePaint(r[s.id]);
          return (
            <div
              key={s.id}
              className={`slot ${activeSlot === s.id ? 'on' : ''}`}
              onClick={() => setActiveSlot(s.id)}
              role="button"
              tabIndex={0}
            >
              <span className="slot-swatch" style={{ background: paint?.hex ?? 'transparent' }}>
                {!paint && '+'}
              </span>
              <span className="slot-text">
                <strong>{s.label}</strong>
                <small>{paint ? `${paint.name}${isCustom(r[s.id]) ? '' : ` · ${paint.brand}`}` : s.desc}</small>
              </span>
              {paint && (
                <button className="x" title="Remove" onClick={(e) => { e.stopPropagation(); clearSlot(s.id); }}>×</button>
              )}
            </div>
          );
        })}
      </div>
      <p className="hint">Pick a paint below for the highlighted step.</p>

      <ColorCodeInput
        key={`${part.id}-${activeSlot}-${currentHex}`}
        current={currentHex}
        slotLabel={slotLabel}
        onApply={applyPaint}
      />
      <Stepper label="Shading" value={r.depth} min={0} max={2} step={0.01} format={pct} onChange={(v) => setRecipeValue('depth', v)} />
      <Stepper label="Wash" value={r.shadeAmt} min={0} max={1} step={0.01} disabled={!r.shade} format={pct} onChange={(v) => setRecipeValue('shadeAmt', v)} />
      <Stepper label="Highlight" value={r.hiAmt} min={0} max={1} step={0.01} disabled={!r.highlight} format={pct} onChange={(v) => setRecipeValue('hiAmt', v)} />
    </section>
  );
}

/** Custom colour: a picker plus a text box that takes a hex code or RGB values. */
function ColorCodeInput({
  current,
  slotLabel,
  onApply,
}: {
  current: string | null;
  slotLabel: string;
  onApply: (hex: string) => void;
}) {
  const [text, setText] = useState(current?.toUpperCase() ?? '');
  const [error, setError] = useState(false);

  const apply = () => {
    if (!text.trim()) return;
    const hex = parseColor(text);
    if (!hex) {
      setError(true);
      return;
    }
    setError(false);
    onApply(hex);
  };

  return (
    <div className="color-code">
      <div className="row">
        <span className="label">Custom</span>
        <input
          type="color"
          value={current ?? '#8899aa'}
          onChange={(e) => onApply(e.target.value)}
          title={`Pick a custom ${slotLabel} colour`}
        />
        <input
          className={error ? 'invalid' : ''}
          value={text}
          placeholder="#9A1115 or 154, 17, 21"
          aria-label={`Hex or RGB colour for ${slotLabel}`}
          onChange={(e) => {
            setText(e.target.value);
            setError(false);
          }}
          onKeyDown={(e) => e.key === 'Enter' && apply()}
        />
        <button className="small" onClick={apply} disabled={!text.trim()}>
          Apply
        </button>
      </div>
      <p className={`hint ${error ? 'error' : ''}`}>
        {error
          ? 'Use a hex code like #9A1115 or RGB like 154, 17, 21 (each 0–255).'
          : current
            ? `Current ${slotLabel}: ${current.toUpperCase()} · RGB ${hexToRgbText(current)}`
            : `Type a hex code or RGB values for the ${slotLabel}.`}
      </p>
    </div>
  );
}

/* ------------------------------ Paint library ----------------------------- */

const SLOT_DEFAULT_TYPE: Record<Slot, PaintType | 'all'> = { base: 'all', shade: 'shade', highlight: 'layer' };

export function PaintLibrary() {
  const activeSlot = useStore((s) => s.activeSlot);
  const current = useStore((s) => s.parts.find((p) => p.id === s.selectedId)?.recipe[s.activeSlot] ?? null);
  const applyPaint = useStore((s) => s.applyPaint);
  const [brand, setBrand] = useState<Brand | 'all'>('all');
  const [typeOverride, setTypeOverride] = useState<Partial<Record<Slot, PaintType | 'all'>>>({});
  const [q, setQ] = useState('');
  const type = typeOverride[activeSlot] ?? SLOT_DEFAULT_TYPE[activeSlot];

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return PAINTS.filter(
      (p) =>
        (brand === 'all' || p.brand === brand) &&
        (type === 'all' || p.type === type) &&
        (!needle || p.name.toLowerCase().includes(needle)),
    ).sort(
      (a, b) =>
        BRANDS.indexOf(a.brand) - BRANDS.indexOf(b.brand) ||
        TYPES.indexOf(a.type) - TYPES.indexOf(b.type) ||
        a.name.localeCompare(b.name),
    );
  }, [brand, type, q]);

  return (
    <section className="panel grow">
      <h2>Paints</h2>
      <input className="search" placeholder="Search paints…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="chips">
        <button className={brand === 'all' ? 'on' : ''} onClick={() => setBrand('all')}>All brands</button>
        {BRANDS.map((b) => (
          <button key={b} className={brand === b ? 'on' : ''} onClick={() => setBrand(b)}>{b}</button>
        ))}
      </div>
      <div className="chips">
        {(['all', ...TYPES] as const).map((t) => (
          <button key={t} className={type === t ? 'on' : ''} onClick={() => setTypeOverride((o) => ({ ...o, [activeSlot]: t }))}>
            {t === 'all' ? 'All types' : typeLabel(t)}
          </button>
        ))}
      </div>
      <div className="paint-grid">
        {list.map((p) => (
          <button
            key={p.id}
            className={`paint ${current === p.id ? 'on' : ''}`}
            style={{ background: p.hex, color: textOn(p.hex) }}
            onClick={() => applyPaint(p.id)}
            title={`${p.name} — ${p.brand} ${typeLabel(p.type)}`}
          >
            <span className="paint-name">{p.name}</span>
            <span className="paint-meta">{p.brand} · {typeLabel(p.type)}</span>
          </button>
        ))}
        {list.length === 0 && <p className="hint">No paints match.</p>}
      </div>
      <p className="hint">Colours are approximate screen matches.</p>
    </section>
  );
}

/* --------------------------------- Schemes -------------------------------- */

export function SchemesPanel() {
  const schemes = useStore((s) => s.schemes);
  const hasParts = useStore((s) => s.parts.length > 0);
  const { saveScheme, applyScheme, deleteScheme } = useStore.getState();
  const [name, setName] = useState('');

  return (
    <section className="panel">
      <h2>Schemes</h2>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          saveScheme(name.trim() || `Scheme ${schemes.length + 1}`);
          setName('');
        }}
      >
        <input placeholder="Name this scheme" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="small" disabled={!hasParts}>Save</button>
      </form>
      {schemes.length === 0 ? (
        <p className="hint">Save a few colour schemes and flip between them.</p>
      ) : (
        <ul className="schemes">
          {schemes.map((s) => (
            <li key={s.id}>
              <button className="link" onClick={() => applyScheme(s.id)}>{s.name}</button>
              <span className="scheme-dots">
                {Object.values(s.recipes).slice(0, 6).map((r, i) => (
                  <span key={i} style={{ background: resolvePaint(r.base)?.hex ?? 'transparent' }} />
                ))}
              </span>
              <button className="x" onClick={() => deleteScheme(s.id)} title="Delete scheme">×</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
