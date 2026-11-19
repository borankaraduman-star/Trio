import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import pkg from './package.json'

// Node's own global; typed here so the web package needs no @types/node.
declare const process: { env: Record<string, string | undefined> }

const BACKEND = 'http://localhost:8000'

// CONTRACT-V4 A2: the version from package.json, and a build id: TRIO_BUILD when
// the build sets it, else the build's UTC time. No git here: the Docker build has no .git.
const VERSION: string = pkg.version
const BUILD = process.env.TRIO_BUILD?.trim() || new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')

export default defineConfig({
  plugins: [react()],
  define: {
    __TRIO_VERSION__: JSON.stringify(VERSION),
    __TRIO_BUILD__: JSON.stringify(BUILD),
  },
  // Two pages: the app, and the public download page /indir (CONTRACT-V6-DOWNLOAD).
  build: {
    rollupOptions: { input: { index: 'index.html', indir: 'indir.html' } },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true },
      '/ws': { target: BACKEND, ws: true, changeOrigin: true },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
