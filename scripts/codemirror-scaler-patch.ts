// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Upstream ViewState.measure rebuilds the height scaler only when the viewport
// changes, so a height change alone leaves the gutter on pre-measure heights.
// Remove this patch once @codemirror/view fixes that: the match then fails.
const OLD = `        if (viewportChange) {
            if (result & 2 /* UpdateFlag.Height */)
                result |= this.updateScaler();
            this.viewport = this.getViewport(bias, this.scrollTarget);
            result |= this.updateForViewport();
        }
`;

const NEW = `        if (result & 2 /* UpdateFlag.Height */)
            result |= this.updateScaler();
        if (viewportChange) {
            this.viewport = this.getViewport(bias, this.scrollTarget);
            result |= this.updateForViewport();
        }
`;

const VIEW_MODULE = /\/@codemirror\/view\/dist\/index\.js$/;

export function patchViewScaler(code: string): string {
  const parts = code.split(OLD);
  if (parts.length !== 2) {
    throw new Error(
      `@codemirror/view scaler patch: expected exactly 1 match, found ${parts.length - 1}`,
    );
  }
  return parts.join(NEW);
}

export function codemirrorScalerPatch() {
  return {
    name: 'codemirror-scaler-patch',
    transform(code: string, id: string) {
      if (!VIEW_MODULE.test(id.split('?')[0]!.replaceAll('\\', '/'))) {
        return null;
      }
      return { code: patchViewScaler(code), map: null };
    },
  };
}
