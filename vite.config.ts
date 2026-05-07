import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    sourcemap: false, // never emit source maps in production
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        'test-stream': resolve(__dirname, 'test-stream.html'),
        'test-zoom': resolve(__dirname, 'test-zoom.html'),
      },
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        proxyTimeout: 120_000,
        timeout: 120_000,
      }
    }
  }
})
