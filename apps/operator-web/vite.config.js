import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import path from 'path';

// Adapted for Novaper integration.
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
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3333',
        changeOrigin: true,
      },
      '/artifacts': {
        target: 'http://127.0.0.1:3333',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://127.0.0.1:3333',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
