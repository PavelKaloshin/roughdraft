import { type NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import { renderKatex } from "./markdown";

/**
 * Renders a `mathInline` / `mathBlock` node as KaTeX. The node is an opaque
 * atom in the editor: the LaTeX source lives in `node.attrs.latex` and is what
 * serializes back to `$…$` / `$$…$$`, while this view only paints the rendered
 * formula.
 */
export function MathView(props: NodeViewProps) {
  const latex = (props.node.attrs.latex as string) ?? "";
  const display = props.node.type.name === "mathBlock";
  const html = renderKatex(latex, display);

  return (
    <NodeViewWrapper
      as={display ? "div" : "span"}
      className={display ? "math-block" : "math-inline"}
      data-testid={display ? "math-block" : "math-inline"}
      contentEditable={false}
    >
      <span
        // KaTeX output is generated locally from the document's own LaTeX and
        // never contains untrusted scripts.
        // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted KaTeX HTML
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </NodeViewWrapper>
  );
}
