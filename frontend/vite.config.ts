/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// dev: `npm run dev` (port 5173) proxies /api to the backend (python -m fp serve, port 8000)
const backend = process.env.FP_BACKEND ?? 'http://localhost:8000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, proxy: { '/api': { target: backend, ws: true } } },
  base: '/app/',  // served by the backend under /app/; the product site is at /
  build: { outDir: 'dist', sourcemap: true },
  test: { environment: 'node' },
});
