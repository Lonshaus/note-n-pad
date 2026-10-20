// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Upstream ViewState.measure rebuilds the height scaler only when the viewport
// changes, so a height change alone leaves the gutter on pre-measure heights.
// Remove this patch once @codemirror/view fixes that: the match then fails.
// The remaining replacements keep the viewport and the wrapped-gap height
// estimate stable so wheel scrolling stays even in documents that need the
// scaler. The constants are measured values, do not tune them.
// With a BigScaler each viewport change maps the same scrollTop to a different
// height, so the scroll anchor is corrected in every measure iteration that
// changes the viewport, not only in the ones that do not.
// Upstream reads the scroll offset before the scroll target is applied, so the
// next anchor is picked away from the target and a centered jump drifts.
const E1_OLD = `        if (viewportChange) {
            if (result & 2 /* UpdateFlag.Height */)
                result |= this.updateScaler();
            this.viewport = this.getViewport(bias, this.scrollTarget);
            result |= this.updateForViewport();
        }
`;

const E1_NEW = `        if (result & 2 /* UpdateFlag.Height */)
            result |= this.updateScaler();
        if (viewportChange) {
            this.viewport = this.getViewport(bias, this.scrollTarget);
            result |= this.updateForViewport();
        }
`;

const VIEW_MODULE = /\/@codemirror\/view\/dist\/index\.js$/;
// Same formula as the expression injected into HeightOracle.heightForGap.
export function wrappedGapHeight(
  lines: number,
  span: number,
  heightForLine: (length: number) => number,
): number {
  return lines * heightForLine(Math.max(0, (span - (lines - 1)) / lines));
}

export interface Replacement {
  name: string;
  old: string;
  new: string;
}

export const REPLACEMENTS: Replacement[] = [
  { name: 'scaler rebuild on height change', old: E1_OLD, new: E1_NEW },
  {
    name: 'viewportIsAppropriate cover margins and outer bound',
    old: `        return (from == 0 || top <= visibleTop - Math.max(10 /* VP.MinCoverMargin */, Math.min(-bias, 250 /* VP.MaxCoverMargin */))) &&
            (to == this.state.doc.length ||
                bottom >= visibleBottom + Math.max(10 /* VP.MinCoverMargin */, Math.min(bias, 250 /* VP.MaxCoverMargin */))) &&
            (top > visibleTop - 2 * 1000 /* VP.Margin */ && bottom < visibleBottom + 2 * 1000 /* VP.Margin */);
`,
    new: `        return (from == 0 || top <= visibleTop - 600) &&
            (to == this.state.doc.length ||
                bottom >= visibleBottom + 600) &&
            (top > visibleTop - 4000 && bottom < visibleBottom + 4000);
`,
  },
  {
    name: 'getViewport margins',
    old: `        let viewport = new Viewport(map.lineAt(visibleTop - marginTop * 1000 /* VP.Margin */, QueryType.ByHeight, oracle, 0, 0).from, map.lineAt(visibleBottom + (1 - marginTop) * 1000 /* VP.Margin */, QueryType.ByHeight, oracle, 0, 0).to);
`,
    new: `        let viewport = new Viewport(map.lineAt(visibleTop - 1200, QueryType.ByHeight, oracle, 0, 0).from, map.lineAt(visibleBottom + 1200, QueryType.ByHeight, oracle, 0, 0).to);
`,
  },
  {
    name: 'heightForGap wrapped estimate',
    old: `        if (this.lineWrapping)
            lines += Math.max(0, Math.ceil(((to - from) - (lines * this.lineLength * 0.5)) / this.lineLength));
        return this.lineHeight * lines;
`,
    new: `        if (this.lineWrapping)
            return lines * this.heightForLine(Math.max(0, (to - from - (lines - 1)) / lines));
        return this.lineHeight * lines;
`,
  },
  {
    name: 'scroll anchor correction on viewport change',
    old: `                if (!update.viewportChanged && this.measureRequests.length == 0) {
`,
    new: `                if (update.viewportChanged && this.viewState.scaler.scale != 1 &&
                    !this.viewState.scrollTarget && scroll == this.scrollDOM &&
                    scrollAnchorPos >= 0 && this.viewState.editorHeight) {
                    let diff = this.viewState.lineBlockAt(scrollAnchorPos).top / this.viewState.scaleY - scrollAnchorHeight / scrollScale;
                    if (diff > 1 || diff < -1) {
                        scrollOffset = scrollOffset + diff;
                        scroll.scrollTop += diff;
                        scrollAnchorHeight = -1;
                    }
                }
                if (!update.viewportChanged && this.measureRequests.length == 0) {
`,
  },
  {
    name: 'scroll offset refresh after scroll target',
    old: `                            this.docView.scrollIntoView(this.viewState.scrollTarget);
                            this.viewState.scrollTarget = null;
                            scrollAnchorHeight = -1;
`,
    new: `                            this.docView.scrollIntoView(this.viewState.scrollTarget);
                            this.viewState.scrollTarget = null;
                            scrollAnchorHeight = -1;
                            scrollOffset = this.viewState.getScrollOffset();
`,
  },
];

export function patchViewScaler(code: string): string {
  let out = code;
  for (const r of REPLACEMENTS) {
    const parts = out.split(r.old);
    if (parts.length !== 2) {
      throw new Error(
        `@codemirror/view scaler patch (${r.name}): expected exactly 1 match, found ${parts.length - 1}`,
      );
    }
    out = parts.join(r.new);
  }
  return out;
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
