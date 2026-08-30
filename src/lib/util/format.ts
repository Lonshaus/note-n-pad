// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** Format a byte count as a human-readable size, e.g. 120.5 MB or 1.2 GB.
 *  Bytes are shown whole; larger units keep one decimal place. */
export function formatFileSize(bytes: number): string {
  let n = Math.max(0, bytes);
  let i = 0;
  while (n >= 1024 && i < SIZE_UNITS.length - 1) {
    n /= 1024;
    i += 1;
  }
  const unit = SIZE_UNITS[i] ?? 'B';
  const value = i === 0 ? Math.round(n) : Math.round(n * 10) / 10;
  return `${value} ${unit}`;
}
