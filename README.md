# Mini Painter

Try paint schemes on a photo of your miniature before you paint it.

**Use it here: https://sieg20.github.io/MiniPainter/**

1. Upload a photo of your model (primed grey or white works best).
2. Tap a part of the model — an AI selector finds the whole area. Refine with the brush or eraser.
3. Pick a base coat, wash and highlight from the full Citadel range (plus some Vallejo), or type any hex/RGB colour.
4. Save schemes, compare with the original, export a PNG, or get a paint shopping list.

Photos are processed in your browser and never uploaded. Your saved models stay on your device.
The AI selector (SlimSAM) downloads once on first use and is then cached.

## Run it locally

```bash
npm install
npm run dev
```

Then open http://localhost:5173.

## Disclaimer

Unofficial fan tool — not affiliated with or endorsed by Games Workshop or any paint manufacturer.
Paint names belong to their owners; colours are approximate.
Opaque Citadel colour values are based on the MIT-licensed
[miniature-paints](https://github.com/Arcturus5404/miniature-paints) dataset.
