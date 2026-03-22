import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  root: '.',
  publicDir: 'public',

  plugins: [tailwindcss()],

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, 'index.html'),
    },
  },

  resolve: {
    alias: {
      '@client': path.resolve(__dirname, 'src/client'),
      '@types': path.resolve(__dirname, 'src/types'),
    },
  },

  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
      },
    },
  },
});
