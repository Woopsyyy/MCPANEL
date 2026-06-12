import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import * as path from 'path';

// The CLI serves this build from <repo>/dist/dashboard/public via @fastify/static,
// so we emit there directly. base './' keeps asset URLs relative.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  build: {
    outDir: path.resolve(__dirname, '../../dist/dashboard/public'),
    emptyOutDir: true,
  },
  server: {
    // For `npm run dev`, proxy API + WS to a locally running CLI dashboard.
    proxy: {
      '/api': 'http://127.0.0.1:8910',
      '/ws': { target: 'ws://127.0.0.1:8910', ws: true },
    },
  },
});
