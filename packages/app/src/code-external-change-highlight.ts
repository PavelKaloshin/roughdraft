import {
  type EditorState,
  type Extension,
  type Range,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import {
  EXTERNAL_CHANGE_HIGHLIGHT_CLASS,
  EXTERNAL_CHANGE_HIGHLIGHT_MS,
} from "./external-change-highlight";

// The raw (CodeMirror) counterpart of `ExternalChangeHighlight`: the text an
// external change inserted briefly flashes with the same class, duration, and
// reduced-motion fallback as the rich-text editor. Decorations only; the
// document is never touched.

const addHighlight = StateEffect.define<{
  id: number;
  from: number;
  to: number;
}>();
const removeHighlight = StateEffect.define<number>();

let nextHighlightId = 1;

const highlightAttributes = {
  class: EXTERNAL_CHANGE_HIGHLIGHT_CLASS,
  "data-testid": "external-change-highlight",
};

function createDecorations(
  state: EditorState,
  id: number,
  from: number,
  to: number,
): Range<Decoration>[] {
  const size = state.doc.length;
  const start = Math.max(0, Math.min(from, size));
  const end = Math.max(start, Math.min(to, size));

  if (end > start && /\S/.test(state.doc.sliceString(start, end))) {
    return [
      Decoration.mark({
        attributes: highlightAttributes,
        externalChangeId: id,
      }).range(start, end),
    ];
  }

  // Pure deletions and whitespace-only inserts have no text to tint, so flash
  // the line where the change landed instead.
  const line = state.doc.lineAt(start);
  return [
    Decoration.line({
      attributes: highlightAttributes,
      externalChangeId: id,
    }).range(line.from),
  ];
}

const highlightField = StateField.define<{
  decorations: DecorationSet;
  ids: number[];
}>({
  create: () => ({ decorations: Decoration.none, ids: [] }),
  update(value, tr) {
    let decorations = value.decorations.map(tr.changes);
    let ids = value.ids;
    for (const effect of tr.effects) {
      if (effect.is(addHighlight)) {
        decorations = decorations.update({
          add: createDecorations(
            tr.state,
            effect.value.id,
            effect.value.from,
            effect.value.to,
          ),
          sort: true,
        });
        ids = [...ids, effect.value.id];
      } else if (effect.is(removeHighlight)) {
        const id = effect.value;
        decorations = decorations.update({
          filter: (_from, _to, decoration) =>
            decoration.spec.externalChangeId !== id,
        });
        ids = ids.filter((existing) => existing !== id);
      }
    }
    return { decorations, ids };
  },
  provide: (field) =>
    EditorView.decorations.from(field, (value) => value.decorations),
});

const highlightTimers = ViewPlugin.fromClass(
  class {
    private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();

    constructor(private readonly view: EditorView) {}

    update(update: ViewUpdate) {
      for (const id of update.state.field(highlightField).ids) {
        if (this.timers.has(id)) continue;
        this.timers.set(
          id,
          setTimeout(() => {
            this.timers.delete(id);
            this.view.dispatch({ effects: removeHighlight.of(id) });
          }, EXTERNAL_CHANGE_HIGHLIGHT_MS),
        );
      }
    }

    destroy() {
      for (const timer of this.timers.values()) clearTimeout(timer);
      this.timers.clear();
    }
  },
);

export function codeExternalChangeHighlight(): Extension {
  return [highlightField, highlightTimers];
}

/** The effect that flashes `[from, to)` of the document after the change. */
export function externalChangeHighlightEffect(from: number, to: number) {
  return addHighlight.of({ id: nextHighlightId++, from, to });
}
