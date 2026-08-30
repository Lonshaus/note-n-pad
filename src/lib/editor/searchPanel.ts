// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import {
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  runScopeHandlers,
  type Panel,
  type ViewUpdate,
} from '@codemirror/view';
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  search,
  selectMatches,
  setSearchQuery,
} from '@codemirror/search';

// Custom search/replace panel: a faithful rebuild of @codemirror/search's
// built-in SearchPanel that adds an "in selection" checkbox. It reuses the CM
// class names (cm-search, cm-textfield, cm-button, [name='close']) so the
// existing app.css rules style it unchanged, and delegates every action to the
// stock search commands so behaviour matches upstream exactly.

// Captured "in selection" scope: whether the option is on, plus the range it
// was captured over. A null range (empty capture selection) means the whole
// document, so ticking the box with no selection never restricts anything.
export interface ScopeState {
  on: boolean;
  scope: { from: number; to: number } | null;
}

// Pure filter predicate for a match [from, to): off or a null scope never
// restricts; otherwise the match must sit fully inside the captured range.
export function inScope(state: ScopeState, from: number, to: number): boolean {
  if (!state.on || state.scope === null) {
    return true;
  }
  return from >= state.scope.from && to <= state.scope.to;
}

const setScope = StateEffect.define<ScopeState>();

// Highlights the captured scope so the user sees where search is confined.
const scopeMark = Decoration.mark({ class: 'cm-searchScope' });

// Holds the current scope and maps its range through document edits, so
// inserts and deletions move the range with the text. Provides the scope
// highlight decoration.
const scopeField = StateField.define<ScopeState>({
  create() {
    return { on: false, scope: null };
  },
  update(value, tr) {
    let set = false;
    for (const effect of tr.effects) {
      if (effect.is(setScope)) {
        value = effect.value;
        set = true;
      }
    }
    if (!set && value.scope !== null && tr.docChanged) {
      const from = tr.changes.mapPos(value.scope.from, 1);
      const to = tr.changes.mapPos(value.scope.to, -1);
      value = { on: value.on, scope: from < to ? { from, to } : null };
    }
    return value;
  },
  provide: (f) =>
    EditorView.decorations.from(f, (value) =>
      value.on && value.scope !== null
        ? Decoration.set(scopeMark.range(value.scope.from, value.scope.to))
        : Decoration.none,
    ),
});

// Match filter handed to SearchQuery. Reading the scope from the live state (not
// a capture-time closure) means every command sees the current, mapped range.
function scopeTest(
  _match: string,
  state: EditorState,
  from: number,
  to: number,
): boolean {
  const s = state.field(scopeField, false);
  return s ? inScope(s, from, to) : true;
}

// Rebuild a SearchQuery from a spec, always re-attaching scopeTest. Passing the
// same function reference keeps SearchQuery.eq() stable across rebuilds.
function withScopeTest(spec: SearchQuery): SearchQuery {
  return new SearchQuery({
    search: spec.search,
    caseSensitive: spec.caseSensitive,
    literal: spec.literal,
    regexp: spec.regexp,
    replace: spec.replace,
    wholeWord: spec.wholeWord,
    test: scopeTest,
  });
}

// Capture the scope for a given on/off state from the current main selection.
function captureScope(view: EditorView, on: boolean): ScopeState {
  if (!on) {
    return { on: false, scope: null };
  }
  const sel = view.state.selection.main;
  return { on: true, scope: sel.empty ? null : { from: sel.from, to: sel.to } };
}

// Toggle "in selection": capture (or clear) the scope and refresh the query so
// the highlight and every command pick up the new restriction immediately.
// Shared by the panel checkbox and the DEV automation hook.
export function setSearchInSelection(view: EditorView, on: boolean): void {
  view.dispatch({
    effects: [
      setScope.of(captureScope(view, on)),
      setSearchQuery.of(withScopeTest(getSearchQuery(view.state))),
    ],
  });
}

export function getSearchInSelection(view: EditorView): boolean {
  return view.state.field(scopeField, false)?.on ?? false;
}

function input(attrs: Record<string, string>): HTMLInputElement {
  const el = document.createElement('input');
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  return el;
}

class InSelectionSearchPanel implements Panel {
  dom: HTMLElement;
  private searchField: HTMLInputElement;
  private replaceField: HTMLInputElement;
  private caseField: HTMLInputElement;
  private reField: HTMLInputElement;
  private wordField: HTMLInputElement;
  private inSelField: HTMLInputElement;
  private query: SearchQuery;
  constructor(private view: EditorView) {
    const phrase = (s: string): string => view.state.phrase(s);
    const query = (this.query = getSearchQuery(view.state));
    this.commit = this.commit.bind(this);
    this.searchField = input({
      value: query.search,
      placeholder: phrase('Find'),
      'aria-label': phrase('Find'),
      class: 'cm-textfield',
      name: 'search',
      form: '',
      'main-field': 'true',
    });
    this.searchField.onchange = this.commit;
    this.searchField.onkeyup = this.commit;
    this.replaceField = input({
      value: query.replace,
      placeholder: phrase('Replace'),
      'aria-label': phrase('Replace'),
      class: 'cm-textfield',
      name: 'replace',
      form: '',
    });
    this.replaceField.onchange = this.commit;
    this.replaceField.onkeyup = this.commit;
    this.caseField = input({ type: 'checkbox', name: 'case', form: '' });
    this.caseField.checked = query.caseSensitive;
    this.caseField.onchange = this.commit;
    this.reField = input({ type: 'checkbox', name: 're', form: '' });
    this.reField.checked = query.regexp;
    this.reField.onchange = this.commit;
    this.wordField = input({ type: 'checkbox', name: 'word', form: '' });
    this.wordField.checked = query.wholeWord;
    this.wordField.onchange = this.commit;
    this.inSelField = input({
      type: 'checkbox',
      name: 'inSelection',
      form: '',
    });
    this.inSelField.checked = getSearchInSelection(view);
    this.inSelField.onchange = () => {
      setSearchInSelection(this.view, this.inSelField.checked);
    };
    const button = (
      name: string,
      onclick: () => void,
      label: string,
    ): HTMLButtonElement => {
      const el = document.createElement('button');
      el.className = 'cm-button';
      el.setAttribute('name', name);
      el.type = 'button';
      el.textContent = phrase(label);
      el.onclick = onclick;
      return el;
    };
    const label = (field: HTMLInputElement, text: string): HTMLLabelElement => {
      const el = document.createElement('label');
      el.append(field, phrase(text));
      return el;
    };
    // Rows instead of the stock flat layout so a narrow window wraps cleanly:
    // options flow as whole checkboxes and the replace row stays intact.
    const row = (cls: string, ...children: HTMLElement[]): HTMLDivElement => {
      const el = document.createElement('div');
      el.className = cls;
      el.append(...children);
      return el;
    };
    const dom = document.createElement('div');
    dom.className = 'cm-search';
    dom.onkeydown = (e): void => this.keydown(e);
    dom.append(
      row(
        'cm-search-row',
        this.searchField,
        button('next', () => findNext(view), 'next'),
        button('prev', () => findPrevious(view), 'previous'),
        button('select', () => selectMatches(view), 'all'),
      ),
      row(
        'cm-search-row cm-search-opts',
        label(this.caseField, 'match case'),
        label(this.reField, 'regexp'),
        label(this.wordField, 'by word'),
        label(this.inSelField, 'in selection'),
      ),
    );
    if (!view.state.readOnly) {
      dom.append(
        row(
          'cm-search-row',
          this.replaceField,
          button('replace', () => replaceNext(view), 'replace'),
          button('replaceAll', () => replaceAll(view), 'replace all'),
        ),
      );
    }
    const close = document.createElement('button');
    close.setAttribute('name', 'close');
    close.setAttribute('aria-label', phrase('close'));
    close.type = 'button';
    // An SVG cross (same glyph as the tab close) centers perfectly inside the
    // round button, unlike the text '×' whose baseline sits off-center.
    const svgNs = 'http://www.w3.org/2000/svg';
    const icon = document.createElementNS(svgNs, 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('width', '11');
    icon.setAttribute('height', '11');
    icon.setAttribute('fill', 'none');
    icon.setAttribute('stroke', 'currentColor');
    icon.setAttribute('stroke-width', '2.4');
    icon.setAttribute('stroke-linecap', 'round');
    const cross = document.createElementNS(svgNs, 'path');
    cross.setAttribute('d', 'M6 6l12 12M18 6L6 18');
    icon.append(cross);
    close.append(icon);
    close.onclick = (): void => {
      closeSearchPanel(view);
    };
    dom.append(close);
    this.dom = dom;
  }
  commit(): void {
    const query = new SearchQuery({
      search: this.searchField.value,
      caseSensitive: this.caseField.checked,
      regexp: this.reField.checked,
      wholeWord: this.wordField.checked,
      replace: this.replaceField.value,
      test: scopeTest,
    });
    if (!query.eq(this.query)) {
      this.query = query;
      this.view.dispatch({ effects: setSearchQuery.of(query) });
    }
  }
  keydown(e: KeyboardEvent): void {
    if (runScopeHandlers(this.view, e, 'search-panel')) {
      e.preventDefault();
    } else if (e.keyCode === 13 && e.target === this.searchField) {
      e.preventDefault();
      (e.shiftKey ? findPrevious : findNext)(this.view);
    } else if (e.keyCode === 13 && e.target === this.replaceField) {
      e.preventDefault();
      replaceNext(this.view);
    }
  }
  update(update: ViewUpdate): void {
    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        if (effect.is(setSearchQuery) && !effect.value.eq(this.query)) {
          this.setQuery(effect.value);
        }
      }
    }
    // Keep the in-selection checkbox in sync with the field (e.g. DEV toggles).
    this.inSelField.checked = update.state.field(scopeField).on;
  }
  setQuery(query: SearchQuery): void {
    this.query = query;
    this.searchField.value = query.search;
    this.replaceField.value = query.replace;
    this.caseField.checked = query.caseSensitive;
    this.reField.checked = query.regexp;
    this.wordField.checked = query.wholeWord;
  }
  mount(): void {
    this.searchField.select();
  }
  get pos(): number {
    return 80;
  }
}

// Editor extension: the scope field plus the search extension configured to use
// the custom panel. Drop into an editor's setup in place of a bare search().
export const searchWithInSelection: Extension = [
  scopeField,
  search({ createPanel: (view) => new InSelectionSearchPanel(view) }),
];
