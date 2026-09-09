// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte()],
  optimizeDeps: {
    // Parsers reach the dev server only through the dynamic import() in
    // src/lib/highlight/languages.ts, so vite discovers them the first time a
    // document is highlighted and forces a client reload right then, which
    // takes window.__auto with it. Naming them up front pre-bundles them at
    // server start. `vite build` does not read optimizeDeps.
    include: [
      '@lezer/common',
      '@lezer/cpp',
      '@lezer/css',
      '@lezer/go',
      '@lezer/highlight',
      '@lezer/html',
      '@lezer/java',
      '@lezer/javascript',
      '@lezer/json',
      '@lezer/markdown',
      '@lezer/php',
      '@lezer/python',
      '@lezer/rust',
      '@lezer/sass',
      '@lezer/xml',
      '@lezer/yaml',
    ],
  },
  server: {
    port: 1420,
    strictPort: true,
    // Never watch cargo's own output: `tauri dev` recompiles into
    // src-tauri/target while vite is running, and without this vite's
    // watcher races the linker and kills the dev server (EBUSY on the
    // freshly-linked .dll). `vite build`, what the packaged app ships,
    // never reads `server` at all.
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
});
