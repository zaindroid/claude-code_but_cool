import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
      '/ws': { target: 'ws://localhost:8080', ws: true },
      '/preview': 'http://localhost:8080',
    },
  },
  build: {
    outDir: '../backend/public',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Split by how often a thing actually changes, not by what it is.
        //
        // Everything used to land in one 600 kB file, two thirds of which was the terminal
        // emulator and the avatar renderer -- neither of which has changed in weeks. Every deploy
        // gave that file a new hash, so every deploy made every browser download all of it again
        // to pick up a few edited lines of app code.
        //
        // Split this way, a normal deploy invalidates `index` alone and the three big vendor
        // chunks stay in cache. They also download in parallel on a first visit instead of as one
        // serial 600 kB parse.
        manualChunks: {
          xterm: ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-web-links'],
          avatar: ['blobatar', '@blobatar/react'],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
});
