import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: '../ui-dist',
    emptyOutDir: true,
  },
  server: { port: 5174, strictPort: true },
});
