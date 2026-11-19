# Mini Painter — notes for Claude Code

Photo-based paint-scheme previewer for Warhammer miniatures. The user uploads a photo,
taps parts of the model, and assigns paints (base / wash / highlight); the app recolours
the photo while keeping its shading.

- Live site: https://sieg20.github.io/MiniPainter/ (GitHub Pages, repo `sieg20/MiniPainter`, branch `main`)
- Plans and history of what's done: [ROADMAP.md](ROADMAP.md) — keep it updated when features land.
- User-facing intro: [README.md](README.md).

## Commands

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # tsc --noEmit && vite build — run before every commit
```

`.claude/launch.json` has two preview configs: `mini-painter` (dev server) and
`mini-painter-build` (serves `dist/` under `/MiniPainter/`, like GitHub Pages).

## Deploying

Every push to `main` runs `.github/workflows/deploy.yml`, which builds and publishes to
GitHub Pages (takes ~1–2 min; check the run before saying it's live).
- `npm ci --ignore-scripts` is deliberate: transformers.js pulls in `onnxruntime-node`/`sharp`,
  whose install scripts try to download native Linux binaries and fail in CI. The browser build doesn't need them.
- `vite.config.ts` uses `base: './'` so the build works under `/MiniPainter/`.

## Stack

React 18 + TypeScript + Vite 5, zustand for state, `@huggingface/transformers` 3.0.2 running
SlimSAM (`Xenova/slimsam-77-uniform`) in a Web Worker. No backend: everything runs in the browser.

## Code map

| File | What it does |
|---|---|
| `src/store.ts` | zustand store: image, parts, recipes, schemes, tools, saved projects, autosave, selector choice |
| `src/components/Stage.tsx` | Canvas view: render, selection overlay, zoom/pan, brush, mouse + touch (pinch, tap, drag) |
| `src/components/Panels.tsx` | Tools, Parts, Recipe (paint slots + hex/RGB input), Paint library, Schemes panels |
| `src/App.tsx` | Header, start screen ("Your models" list), shortcuts, paste/drag-drop, paint shopping list |
| `src/lib/recolor.ts` | Recolour engine in OKLab: keeps the photo's relative lightness (normalised per part, p3–p97), takes hue/chroma from the paint; wash pools in darks, highlight lifts brights; metallic/contrast tweaks |
| `src/lib/mask.ts` | Combines AI/fill mask + brush add/erase layers → final mask, 1px feather, bbox, lightness stats |
| `src/lib/sam.ts` / `samWorker.ts` | AI selector worker client / worker (WebGPU fp32, falls back to wasm q8) |
| `src/lib/smartfill.ts` | "Smart fill": non-AI selector — region growing in OKLab that follows shading but stops at sharp edges; returns 3 sizes like SAM |
| `src/lib/device.ts` | Low-memory/phone detection, AI on/off preference, crash flag |
| `src/lib/persist.ts` | IndexedDB saving (projects / images / work stores), RLE-encoded masks, thumbnails |
| `src/lib/color.ts` | sRGB↔OKLab, colour parsing (`#abc`, `#aabbcc`, `rgb()`, `r,g,b`) |
| `src/data/paints.ts` | Paint library: full current Citadel range (281), starter Vallejo / Army Painter sets |

## Decisions to respect

- **Photos stay on the device.** Nothing is uploaded; no backend. Don't add server-side processing.
- **No Games Workshop content in the app or repo.** Users may upload any image (including official
  photos) for their own use, but don't bundle GW images, add URL import or scraping, and any future
  public gallery must be limited to users' own photos. Keep the "unofficial / not affiliated" disclaimer.
- **Paint colours:** opaque Citadel colours come from the MIT-licensed
  github.com/Arcturus5404/miniature-paints dataset. Shade and Contrast colours are hand-set to
  "how it looks over a light primer" (the dataset's swatches for translucent paints don't suit the
  engine). Some estimated values are noted in ROADMAP as needing calibration. Edit `paints.ts` directly.
- Paint references in recipes are paint ids (`citadel:mephiston-red`) or custom hex strings (`#9a1115`).

## Gotchas

- **The AI analysis needs 1–2 GB of memory** (SlimSAM's global attention over 64×64 tokens). Phone
  browsers kill and reload the page. So phones/tablets default to Smart fill, the AI is opt-in via
  the Selector switch, and `sam.embed` sets a sessionStorage flag: if the page reloads mid-analysis,
  the next load switches to Smart fill instead of crash-looping. Phones use 1200px working images (desktop 1600).
- **Brush layers (`part.add` / `part.erase`) are mutated in place** during a stroke; `commitBrush`
  publishes the change. Because of that, persist.ts never caches their RLE encoding (it does cache AI masks).
- **Autosave** watches `parts` / `schemes` / `selectedId` and saves 700 ms later; `saveNow()` flushes.
  Switching projects (`openProject`, `loadFile`, `closeImage`) flushes first. Refreshing reopens the
  last project (`localStorage['mini-painter:last']`).
- Editing `store.ts` or anything it imports causes a full page reload in dev (not hot reload) —
  harmless now because work is saved, but don't be surprised.
- `window.__store` exposes the store in dev builds only (handy for tests).
- Line endings: `.gitattributes` has `* text=auto`; git warns about LF→CRLF on Windows — harmless.

## How changes have been tested

Verify in the browser before calling something done, at desktop and phone width (375px).
- Dev: create a synthetic image on a canvas, `await __store.getState().loadFile(new File([blob], 'x.png', {type:'image/png'}))`,
  then drive the store (`newPart`, `addPoint`, `brushLayers` + `commitBrush`, `applyPaint`). Delete test projects afterwards.
- Production build / live site (no `__store`): load a test image by dispatching a `paste` ClipboardEvent
  with a DataTransfer holding the File; read the overlay canvas pixels to confirm a selection.
- Touch: dispatch `PointerEvent`s with `pointerType: 'touch'` on `.stage` (stub `Element.prototype.setPointerCapture`
  for synthetic pointers). Real-phone testing is still worth doing — so far only simulated.
- Check there's no sideways scroll on phones: `document.documentElement.scrollWidth` should equal the viewport width.

## Working with the owner

- Explain changes in plain language; say what was tested and what wasn't.
- Commit and push when asked (or when a change is meant to go live); end commit messages with the
  usual Claude co-author line. Pushing to `main` publishes the site.
- Development machine so far: Windows, PowerShell + Git Bash, Node 24; no Python, no `gh` CLI
  (GitHub Desktop is installed and signed in as `sieg20`).
