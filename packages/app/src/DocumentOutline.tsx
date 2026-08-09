import { Hash, ListTree, PanelLeftClose } from "lucide-react";
import type { CSSProperties } from "react";
import { outlineBaseLevel, type OutlineHeading } from "./markdown-outline";
import { Button } from "./components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./components/ui/tooltip";
import { cn } from "./lib/utils";

const OUTLINE_INDENT_STEP_REM = 0.6;

interface DocumentOutlineListProps {
  headings: OutlineHeading[];
  onSelectHeading: (heading: OutlineHeading) => void;
  /** `${testIdPrefix}-heading-<index>` identifies each entry. */
  testIdPrefix: string;
}

/**
 * The heading list itself. Entries are indented by heading depth relative to
 * the shallowest heading in the document, so a doc that starts at `##` is not
 * pushed off to the right.
 */
function DocumentOutlineList({
  headings,
  onSelectHeading,
  testIdPrefix,
}: DocumentOutlineListProps) {
  const baseLevel = outlineBaseLevel(headings);

  return (
    <ul className="m-0 list-none p-0">
      {headings.map((heading) => (
        <li key={`${heading.index}:${heading.line}`}>
          <button
            type="button"
            onClick={() => onSelectHeading(heading)}
            title={heading.text}
            data-testid={`${testIdPrefix}-heading-${heading.index}`}
            className="flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-xs text-sky-950/80 hover:bg-sky-200/50 dark:text-sky-100/80 dark:hover:bg-sky-400/15"
            style={{
              paddingLeft: `${
                0.375 + (heading.level - baseLevel) * OUTLINE_INDENT_STEP_REM
              }rem`,
            }}
          >
            <Hash
              className={cn(
                "size-3 shrink-0",
                heading.level - baseLevel === 0 ? "opacity-60" : "opacity-35",
              )}
            />
            <span
              className={cn(
                "truncate",
                heading.level - baseLevel === 0 && "font-medium",
              )}
            >
              {heading.text || "—"}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

interface DocumentOutlineBoxProps {
  headings: OutlineHeading[];
  onSelectHeading: (heading: OutlineHeading) => void;
  testIdPrefix: string;
  testId: string;
  /** Rendered instead of the list while the file is being read. */
  status: "loading" | "ready" | "error";
  className?: string;
  style?: CSSProperties;
}

/**
 * A tinted, accent-bordered box that visually binds an outline to the file row
 * above it, so heading entries never read as files in the tree.
 */
export function DocumentOutlineBox({
  headings,
  onSelectHeading,
  testIdPrefix,
  testId,
  status,
  className,
  style,
}: DocumentOutlineBoxProps) {
  return (
    <div
      data-testid={testId}
      style={style}
      className={cn(
        "my-0.5 rounded-md border-l-2 border-sky-400/70 bg-sky-100/60 py-1 pr-1 pl-0.5 dark:border-sky-400/50 dark:bg-sky-400/10",
        className,
      )}
    >
      {status === "loading" ? (
        <p className="px-2 py-0.5 text-xs text-slate-400">Reading headings…</p>
      ) : status === "error" ? (
        <p className="px-2 py-0.5 text-xs text-slate-400">
          Could not read headings.
        </p>
      ) : headings.length === 0 ? (
        <p className="px-2 py-0.5 text-xs text-slate-400">No headings.</p>
      ) : (
        <DocumentOutlineList
          headings={headings}
          onSelectHeading={onSelectHeading}
          testIdPrefix={testIdPrefix}
        />
      )}
    </div>
  );
}

interface DocumentOutlineRailProps {
  headings: OutlineHeading[];
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onSelectHeading: (heading: OutlineHeading) => void;
}

/**
 * Single-file mode has no directory tree, so the outline gets its own
 * collapsible rail left of the document. Collapsed it is a thin strip with just
 * the toggle, so the document keeps the width.
 */
export function DocumentOutlineRail({
  headings,
  expanded,
  onExpandedChange,
  onSelectHeading,
}: DocumentOutlineRailProps) {
  const toggleLabel = expanded ? "Hide outline" : "Show outline";
  const toggleButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button variant="ghost" size="icon-sm">
            {expanded ? <PanelLeftClose /> : <ListTree />}
          </Button>
        }
        aria-label={toggleLabel}
        aria-expanded={expanded}
        data-testid="document-outline-toggle"
        onClick={() => onExpandedChange(!expanded)}
      />
      <TooltipContent>{toggleLabel}</TooltipContent>
    </Tooltip>
  );

  if (!expanded) {
    return (
      <nav
        aria-label="Document outline"
        data-testid="document-outline-rail"
        className="flex h-screen w-10 shrink-0 flex-col items-center border-r border-slate-200 bg-slate-50 pt-3 dark:border-slate-800 dark:bg-slate-900/40"
      >
        {toggleButton}
      </nav>
    );
  }

  return (
    <nav
      aria-label="Document outline"
      data-testid="document-outline-rail"
      className="flex h-screen w-60 shrink-0 flex-col border-r border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/40"
    >
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-800">
        <p className="text-xs font-medium tracking-wide text-slate-400 uppercase">
          Outline
        </p>
        {toggleButton}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <DocumentOutlineBox
          headings={headings}
          onSelectHeading={onSelectHeading}
          status="ready"
          testId="document-outline-box"
          testIdPrefix="document-outline"
        />
      </div>
    </nav>
  );
}
