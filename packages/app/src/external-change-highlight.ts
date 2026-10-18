import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/** How long a change from disk stays highlighted (matches the CSS fade). */
export const EXTERNAL_CHANGE_HIGHLIGHT_MS = 1500;

export const EXTERNAL_CHANGE_HIGHLIGHT_CLASS = "external-change-highlight";

type HighlightMeta =
  | { type: "add"; id: number; from: number; to: number }
  | { type: "remove"; id: number };

interface HighlightState {
  decorations: DecorationSet;
  ids: number[];
}

export const externalChangeHighlightPluginKey = new PluginKey<HighlightState>(
  "externalChangeHighlight",
);

let nextHighlightId = 1;

function createHighlightDecorations(
  doc: ProseMirrorNode,
  id: number,
  from: number,
  to: number,
): Decoration[] {
  const spec = { externalChangeId: id };
  const attrs = {
    class: EXTERNAL_CHANGE_HIGHLIGHT_CLASS,
    "data-testid": "external-change-highlight",
  };
  const size = doc.content.size;
  const start = Math.max(0, Math.min(from, size));
  const end = Math.max(start, Math.min(to, size));

  let hasText = false;
  doc.nodesBetween(start, end, (node) => {
    if (node.isText) hasText = true;
    return !hasText;
  });
  if (end > start && hasText) {
    return [Decoration.inline(start, end, attrs, spec)];
  }

  // Pure deletions and non-text insertions (an image, a rule) have no text to
  // tint, so flash the surrounding top-level block instead.
  const $pos = doc.resolve(start);
  if ($pos.depth >= 1) {
    const blockStart = $pos.before(1);
    const block = doc.nodeAt(blockStart);
    if (block) {
      return [
        Decoration.node(blockStart, blockStart + block.nodeSize, attrs, spec),
      ];
    }
  }

  const block = doc.nodeAt(start);
  return block
    ? [Decoration.node(start, start + block.nodeSize, attrs, spec)]
    : [];
}

/**
 * Marks the range an external change inserted so it can briefly flash. The
 * highlight is a decoration: it never touches the document or the markdown.
 */
export function addExternalChangeHighlight(
  tr: Transaction,
  from: number,
  to: number,
) {
  const meta: HighlightMeta = {
    type: "add",
    id: nextHighlightId++,
    from,
    to,
  };
  return tr.setMeta(externalChangeHighlightPluginKey, meta);
}

export const ExternalChangeHighlight = Extension.create({
  name: "externalChangeHighlight",

  addProseMirrorPlugins() {
    return [
      new Plugin<HighlightState>({
        key: externalChangeHighlightPluginKey,
        state: {
          init: () => ({ decorations: DecorationSet.empty, ids: [] }),
          apply: (tr, pluginState) => {
            const meta = tr.getMeta(externalChangeHighlightPluginKey) as
              | HighlightMeta
              | undefined;
            let { decorations, ids } = pluginState;

            if (tr.docChanged) {
              decorations = decorations.map(tr.mapping, tr.doc);
            }

            if (meta?.type === "add") {
              decorations = decorations.add(
                tr.doc,
                createHighlightDecorations(tr.doc, meta.id, meta.from, meta.to),
              );
              ids = [...ids, meta.id];
            } else if (meta?.type === "remove") {
              decorations = decorations.remove(
                decorations.find(
                  undefined,
                  undefined,
                  (spec) => spec.externalChangeId === meta.id,
                ),
              );
              ids = ids.filter((id) => id !== meta.id);
            }

            if (
              decorations === pluginState.decorations &&
              ids === pluginState.ids
            ) {
              return pluginState;
            }
            return { decorations, ids };
          },
        },
        props: {
          decorations: (state) =>
            externalChangeHighlightPluginKey.getState(state)?.decorations ??
            null,
        },
        view: () => {
          const timers = new Map<number, ReturnType<typeof setTimeout>>();

          return {
            update(view) {
              const pluginState = externalChangeHighlightPluginKey.getState(
                view.state,
              );
              for (const id of pluginState?.ids ?? []) {
                if (timers.has(id)) continue;
                timers.set(
                  id,
                  setTimeout(() => {
                    timers.delete(id);
                    if (view.isDestroyed) return;
                    view.dispatch(
                      view.state.tr.setMeta(externalChangeHighlightPluginKey, {
                        type: "remove",
                        id,
                      } satisfies HighlightMeta),
                    );
                  }, EXTERNAL_CHANGE_HIGHLIGHT_MS),
                );
              }
            },
            destroy() {
              for (const timer of timers.values()) clearTimeout(timer);
              timers.clear();
            },
          };
        },
      }),
    ];
  },
});
