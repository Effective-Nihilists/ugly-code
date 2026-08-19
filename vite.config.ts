import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import {
  audioWorkletsPlugin,
  dataSourcePlugin,
  staticAssetsPlugin,
} from 'ugly-app/vite';

export default defineConfig({
  plugins: [
    dataSourcePlugin(),
    staticAssetsPlugin(),
    audioWorkletsPlugin(),
    react(),
  ],
  root: 'client',
  base: process.env.VITE_CDN_BASE || '/',
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
  },
});
