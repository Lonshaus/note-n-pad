// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte()],
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
