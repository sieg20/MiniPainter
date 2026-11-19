# Mini Painter — Roadmap

## Done
- Photo upload (file, drag & drop, paste, phone camera)
- AI tap-to-select parts (SlimSAM, runs in the browser; WebGPU with CPU fallback)
- Brush / erase refinement, small/medium/large area options
- Paint library: full current Citadel range (281 paints: Base, Layer, Shade, Contrast, Technical, Dry),
  plus a starter set of Vallejo — approximate colours (Army Painter removed)
- Per-part recipe: base coat, wash, highlight, shading depth; metallic & contrast handling
- Custom colours via picker, hex code (`#9A1115`, `#abc`) or RGB (`154, 17, 21`)
- Schemes, hold-to-compare, PNG export, paint list
- Save work: every photo is a saved model (photo, parts, schemes) in IndexedDB on the device, autosaved;
  a refresh reopens it; "Your models" list on the start screen with rename/delete

- Touch: pinch to zoom (also pans), one-finger drag pans in AI select, tap to select;
  a second finger cancels a half-drawn brush stroke; compact phone header

- Phones: the AI analysis needs 1–2 GB and crashed mobile browsers, so phones/tablets default to
  "Smart fill" (colour + edge region growing, no AI); AI can be switched on, and a crash during
  analysis auto-switches back instead of reload-looping. Phones use 1200px working images.
- Undo / redo (header buttons, Ctrl+Z / Ctrl+Y) for parts, taps, paints, sliders, schemes and
  each brush/erase stroke; history per open model, not saved across refreshes
- − / + buttons on every slider (1% steps, hold to repeat)
- Live at https://sieg20.github.io/MiniPainter/ (GitHub Pages, redeploys on every push to main)

## Next
- Test and tune on real miniature photos (selection quality, colour realism)

## Later
- **PWA** — installable on phone/desktop, works offline:
  - web app manifest (name, icons, theme colour, `display: standalone`)
  - service worker caching the app shell (e.g. `vite-plugin-pwa`)
  - cache the AI model files for offline use
  - "Add to home screen" prompt
- Share a scheme as a link or image card
- Side-by-side comparison of schemes
- Step-by-step painting guide generated from a scheme
- More paint brands (Pro Acryl, AK, Scale75) and better-calibrated colour values
- Optional community gallery (own photos only, with "I took this photo" confirmation)
