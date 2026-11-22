import { useEffect, useRef, useState } from 'react';
import { PaintLibrary, PartsPanel, RecipePanel, SchemesPanel, ToolsPanel } from './components/Panels';
import { Stage } from './components/Stage';
import { isCustom, resolvePaint, typeLabel, type Paint } from './data/paints';
import { sam } from './lib/sam';
import type { ProjectMeta } from './lib/persist';
import { useStore } from './store';

export default function App() {
  const image = useStore((s) => s.image);
  const toast = useStore((s) => s.toast);
  const [dragOver, setDragOver] = useState(false);
  const [showList, setShowList] = useState(false);

  // Drag & drop and paste anywhere.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith('image/'));
      if (f) useStore.getState().loadFile(f);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const st = useStore.getState();
      if (!st.image) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault();
        st.redo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        st.undo();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 's') st.setTool('select');
      else if (k === 'b') st.setTool('brush');
      else if (k === 'e') st.setTool('erase');
      else if (k === 'h') st.setTool('pan');
      else if (k === 'n') st.newPart();
      else if (k === 'f') window.dispatchEvent(new Event('stage:fit'));
      else if (k === 'c' && !e.repeat) st.setShowOriginal(true);
      else if (k === '[') st.setBrushSize(Math.max(2, st.brushSize - 4));
      else if (k === ']') st.setBrushSize(Math.min(120, st.brushSize + 4));
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'c') useStore.getState().setShowOriginal(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) useStore.getState().loadFile(f);
  };

  return (
    <div
      className={`app ${dragOver ? 'drag' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragOver(false)}
      onDrop={onDrop}
    >
      <Header onShoppingList={() => setShowList(true)} />
      {image ? (
        <main className="workspace">
          <aside className="side left">
            <ToolsPanel />
            <PartsPanel />
          </aside>
          <div className="center">
            <Stage />
          </div>
          <aside className="side right">
            <RecipePanel />
            <PaintLibrary />
            <SchemesPanel />
          </aside>
        </main>
      ) : (
        <Welcome />
      )}
      <footer className="footer">
        Unofficial fan tool — not affiliated with Games Workshop or any paint manufacturer. Photos are processed on
        your device and never uploaded.
      </footer>
      {showList && <ShoppingList onClose={() => setShowList(false)} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function UploadButton({ label, className }: { label: string; className?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <button className={className} onClick={() => ref.current?.click()}>{label}</button>
      <input
        ref={ref}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) useStore.getState().loadFile(f);
          e.target.value = '';
        }}
      />
    </>
  );
}

function SamStatusBadge() {
  const status = useStore((s) => s.samStatus);
  const detail = useStore((s) => s.samDetail);
  const selector = useStore((s) => s.selector);
  if (selector === 'fill') {
    return <span className="status ready" title="Smart fill selector (AI off)"><i />Smart fill selector</span>;
  }
  const text =
    status === 'loading' ? detail || 'Loading AI selector…'
    : status === 'embedding' ? 'Analysing photo…'
    : status === 'ready' ? `AI selector ready${detail ? ` (${detail})` : ''}`
    : status === 'error' ? `AI selector error — use the brush (${detail})`
    : 'AI selector idle';
  return <span className={`status ${status}`} title={text}><i />{text}</span>;
}

function Header({ onShoppingList }: { onShoppingList: () => void }) {
  const image = useStore((s) => s.image);
  const setShowOriginal = useStore((s) => s.setShowOriginal);

  const exportPng = () => {
    const c = document.getElementById('paint-canvas') as HTMLCanvasElement | null;
    if (!c) return;
    c.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${(image?.name ?? 'mini').replace(/\.[^.]+$/, '')}-painted.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, 'image/png');
  };

  return (
    <header className="header">
      <div className="brand">
        <span className="logo">◆</span> Mini Painter
      </div>
      {image && (
        <div className="header-actions">
          <SamStatusBadge />
          <div className="header-buttons">
          <UndoRedo />
          <button
            className="compare"
            onPointerDown={() => setShowOriginal(true)}
            onPointerUp={() => setShowOriginal(false)}
            onPointerLeave={() => setShowOriginal(false)}
            onPointerCancel={() => setShowOriginal(false)}
            onContextMenu={(e) => e.preventDefault()}
            title="Hold to see the original photo (or hold C)"
          >
            Hold to compare
          </button>
          <button onClick={() => window.dispatchEvent(new Event('stage:fit'))} title="Fit to screen (F)">Fit</button>
          <button onClick={onShoppingList}>Paint list</button>
          <button onClick={exportPng}>Export PNG</button>
          <UploadButton label="New photo" className="ghost" />
          <button className="ghost" onClick={() => useStore.getState().closeImage()} title="Back to your saved models">
            My models
          </button>
          </div>
        </div>
      )}
    </header>
  );
}

function Welcome() {
  const restoring = useStore((s) => s.restoring);
  useEffect(() => {
    // Start fetching the AI model while the user picks a photo.
    if (useStore.getState().selector === 'ai') sam.preload();
  }, []);
  if (restoring) {
    return (
      <main className="welcome">
        <p className="hint">Opening your saved model…</p>
      </main>
    );
  }
  return (
    <main className="welcome">
      <div className="welcome-card">

        <h1>Try paint schemes on your miniature</h1>
        <p>Upload a photo, tap the parts of the model, and pick paints. The shading in your photo is kept, so the result looks painted, not flat.</p>
        <UploadButton label="Upload or take a photo" className="primary big" />
        <p className="hint">…or drag an image here, or paste one with Ctrl+V.</p>
        <SavedModels />
        <ul className="tips">
          <li><strong>Best results:</strong> a primed (grey or white) model, plain background, even light.</li>
          <li>Already-painted models work too — the lightness is remapped so dark armour can go light.</li>
          <li>Photos stay on your device. On computers an AI selector finds parts (it downloads once); phones use the lighter Smart fill.</li>
        </ul>
        <SamStatusBadge />
      </div>
    </main>
  );
}

function UndoRedo() {
  const undoLabel = useStore((s) => s.undoLabel);
  const redoLabel = useStore((s) => s.redoLabel);
  const { undo, redo } = useStore.getState();
  return (
    <>
      <button onClick={undo} disabled={!undoLabel} title={undoLabel ? `Undo: ${undoLabel} (Ctrl+Z)` : 'Nothing to undo'}>
        ↶ Undo
      </button>
      <button onClick={redo} disabled={!redoLabel} title={redoLabel ? `Redo: ${redoLabel} (Ctrl+Y)` : 'Nothing to redo'}>
        ↷ Redo
      </button>
    </>
  );
}

function SavedModels() {
  const projects = useStore((s) => s.projects);
  if (!projects.length) return null;
  return (
    <section className="saved">
      <h2>Your models</h2>
      <div className="saved-grid">
        {projects.map((p) => (
          <SavedCard key={p.id} project={p} />
        ))}
      </div>
      <p className="hint">Saved on this device only. Clearing your browser data removes them.</p>
    </section>
  );
}

function SavedCard({ project: p }: { project: ProjectMeta }) {
  const [url, setUrl] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!p.thumb) return;
    const u = URL.createObjectURL(p.thumb);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [p.thumb]);
  const st = useStore.getState();
  const when = new Date(p.updated).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

  return (
    <div className="saved-card">
      <button className="saved-open" onClick={() => st.openProject(p.id)} title={`Open ${p.name}`}>
        {url ? <img src={url} alt="" /> : <span className="saved-noimg">No preview</span>}
      </button>
      <div className="saved-info">
        {editing ? (
          <input
            autoFocus
            defaultValue={p.name}
            maxLength={60}
            onBlur={(e) => {
              setEditing(false);
              st.renameProject(p.id, e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') setEditing(false);
            }}
          />
        ) : (
          <button className="saved-name" onClick={() => setEditing(true)} title="Rename">
            {p.name}
          </button>
        )}
        <span className="saved-meta">
          {p.partCount} {p.partCount === 1 ? 'part' : 'parts'} · {when}
        </span>
      </div>
      <button
        className="x saved-del"
        title="Delete"
        onClick={() => confirm(`Delete "${p.name}"? This can't be undone.`) && st.deleteProject(p.id)}
      >
        ×
      </button>
    </div>
  );
}

function ShoppingList({ onClose }: { onClose: () => void }) {
  const parts = useStore((s) => s.parts);
  const used = new Map<string, { paint: Paint; uses: string[] }>();
  for (const p of parts) {
    for (const [slot, label] of [['base', 'base'], ['shade', 'wash'], ['highlight', 'highlight']] as const) {
      const ref = p.recipe[slot];
      const paint = resolvePaint(ref);
      if (!paint || !ref) continue;
      const entry = used.get(ref) ?? { paint, uses: [] };
      entry.uses.push(`${p.name} ${label}`);
      used.set(ref, entry);
    }
  }
  const groups = new Map<string, { paint: Paint; uses: string[] }[]>();
  for (const [ref, e] of used) {
    const g = isCustom(ref) ? 'Custom mixes' : e.paint.brand;
    groups.set(g, [...(groups.get(g) ?? []), e]);
  }
  const text = [...groups]
    .map(([g, items]) => `${g}\n${items.map((i) => `- ${i.paint.name} (${i.uses.join(', ')})`).join('\n')}`)
    .join('\n\n');

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h2>Paint list</h2>
          <button className="x" onClick={onClose}>×</button>
        </div>
        {used.size === 0 ? (
          <p className="hint">No paints chosen yet.</p>
        ) : (
          <>
            {[...groups].map(([g, items]) => (
              <div key={g} className="list-group">
                <h3>{g}</h3>
                <ul>
                  {items.map((i) => (
                    <li key={i.paint.id}>
                      <span className="swatch" style={{ background: i.paint.hex }} />
                      <span><strong>{i.paint.name}</strong> <small>{typeLabel(i.paint.type)}</small><br /><small>{i.uses.join(', ')}</small></span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <button className="primary" onClick={() => navigator.clipboard.writeText(text)}>Copy list</button>
          </>
        )}
      </div>
    </div>
  );
}
