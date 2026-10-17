/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// dev: `npm run dev` (port 5173) proxies /api to the backend (python -m fp serve, port 8000)
const backend = process.env.FP_BACKEND ?? 'http://localhost:8000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, proxy: { '/api': backend } },
  build: { outDir: 'dist', sourcemap: true },
  test: { environment: 'node' },
});
