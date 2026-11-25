import path from 'node:path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dev: run `SHMAKK_WEB_TOKEN=dev shmakk --web --no-open` in one terminal and
// `SHMAKK_WEB_TOKEN=dev npm run dev` here. The proxy attaches the token so
// the Vite dev server can talk to the real backend with hot reload.
const backend = process.env.SHMAKK_WEB_URL || 'http://127.0.0.1:4317';
const token = process.env.SHMAKK_WEB_TOKEN || '';
const auth = token ? { authorization: `Bearer ${token}` } : undefined;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  build: {
    outDir: path.resolve(import.meta.dirname, '../src/webui/public'),
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: backend, headers: auth },
      '/ws': { target: backend.replace(/^http/, 'ws'), ws: true, headers: auth },
    },
  },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
