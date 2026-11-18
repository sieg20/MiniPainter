import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative asset paths, so the build works at any address (e.g. sieg20.github.io/MiniPainter/).
  base: './',
  server: { port: 5173 },
  worker: { format: 'es' },
  // transformers.js ships its own wasm/onnx loaders; let Vite leave it alone.
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
});
