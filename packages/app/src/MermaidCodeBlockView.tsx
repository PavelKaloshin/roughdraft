import {
  NodeViewContent,
  type NodeViewProps,
  NodeViewWrapper,
} from "@tiptap/react";
import { useEffect, useState } from "react";

type MermaidApi = {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, code: string) => Promise<{ svg: string }>;
};

let mermaidPromise: Promise<MermaidApi> | null = null;

// Lazy-load mermaid so its weight only lands when a diagram is actually shown.
async function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((module) => {
      const mermaid = module.default as unknown as MermaidApi;
      return mermaid;
    });
  }
  return mermaidPromise;
}

function isDarkTheme(): boolean {
  return (
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark")
  );
}

let renderCounter = 0;

async function renderDiagram(code: string, dark: boolean): Promise<string> {
  const mermaid = await loadMermaid();
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: dark ? "dark" : "default",
  });
  renderCounter += 1;
  const { svg } = await mermaid.render(`mermaid-${renderCounter}`, code);
  return svg;
}

function MermaidDiagram({ code }: { code: string }) {
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const dark = isDarkTheme();

  useEffect(() => {
    let active = true;
    const trimmed = code.trim();
    if (!trimmed) {
      setSvg("");
      setError(null);
      return;
    }

    renderDiagram(trimmed, dark)
      .then((nextSvg) => {
        if (!active) return;
        setSvg(nextSvg);
        setError(null);
      })
      .catch((renderError: unknown) => {
        if (!active) return;
        setSvg("");
        setError(
          renderError instanceof Error
            ? renderError.message
            : String(renderError),
        );
      });

    return () => {
      active = false;
    };
  }, [code, dark]);

  if (error) {
    return (
      <div className="mermaid-diagram mermaid-diagram--error" role="img">
        <p className="mermaid-diagram__error-title">Could not render diagram</p>
        <pre className="mermaid-diagram__source">
          <code>{code}</code>
        </pre>
        <p className="mermaid-diagram__error-detail">{error}</p>
      </div>
    );
  }

  if (!svg) {
    return (
      <div
        className="mermaid-diagram mermaid-diagram--loading"
        aria-busy="true"
      >
        Rendering diagram…
      </div>
    );
  }

  return (
    <div
      className="mermaid-diagram"
      data-testid="mermaid-diagram-rendered"
      // mermaid output is sanitized via securityLevel: "strict"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted mermaid SVG
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export function MermaidCodeBlockView(props: NodeViewProps) {
  const language = (props.node.attrs.language as string | null) ?? "";

  if (language === "mermaid") {
    return (
      <NodeViewWrapper
        as="div"
        className="mermaid-block"
        data-testid="mermaid-diagram"
        contentEditable={false}
        // ProseMirror should treat the rendered diagram as an opaque leaf in
        // the editor; the markdown source still lives in the node and is what
        // serializes back to a ```mermaid fence.
      >
        <MermaidDiagram code={props.node.textContent} />
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper as="pre">
      <NodeViewContent<"code"> as="code" />
    </NodeViewWrapper>
  );
}
