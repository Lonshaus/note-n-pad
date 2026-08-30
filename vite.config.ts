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
  },
});
