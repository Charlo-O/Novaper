import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import path from 'path';

// Adapted for Novaper integration.
const backendTarget = process.env.NOVAPER_BACKEND_URL || 'http://127.0.0.1:3333';

export default defineConfig({
  define: {
    __BACKEND_VERSION__: JSON.stringify(
      process.env.VITE_BACKEND_VERSION || 'unknown'
    ),
  },
  plugins: [
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: "127.0.0.1",
    proxy: {
      '/api': {
        target: backendTarget,
        changeOrigin: true,
      },
      '/artifacts': {
        target: backendTarget,
        changeOrigin: true,
      },
      '/socket.io': {
        target: backendTarget,
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
