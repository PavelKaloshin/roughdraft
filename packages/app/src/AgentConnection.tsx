import { Check, Copy, TerminalSquare } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CommentAgentContextValue } from "./comment-agent";
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert";
import { Button } from "./components/ui/button";
import { cn } from "./lib/utils";

export const NO_LISTENER_TITLE = "No Claude session is listening";
export const NO_LISTENER_BODY =
  "Roughdraft saved the comment and queued the event. It reaches Claude once a session in this project runs:";

export function formatSessionLabel(sessionId: string) {
  return sessionId.slice(0, 8);
}

export function CopyCommandButton({
  command,
  testId,
  className,
}: {
  command: string;
  testId?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    };
  }, []);

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-testid={testId}
      className={cn("shrink-0", className)}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        void navigator.clipboard
          ?.writeText(command)
          .then(() => {
            setCopied(true);
            if (timeoutRef.current !== null) {
              window.clearTimeout(timeoutRef.current);
            }
            timeoutRef.current = window.setTimeout(
              () => setCopied(false),
              1500,
            );
          })
          .catch(() => {});
      }}
    >
      {copied ? <Check /> : <Copy />}
      {copied ? "Copied" : "Copy command"}
    </Button>
  );
}

/** The "nobody is listening" notice, shared by the header and the thread. */
export function NoListenerNotice({
  listenCommand,
  testId,
  className,
}: {
  listenCommand: string | null;
  testId?: string;
  className?: string;
}) {
  return (
    <Alert
      data-testid={testId}
      className={cn(
        "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100",
        className,
      )}
    >
      <TerminalSquare />
      <AlertTitle>{NO_LISTENER_TITLE}</AlertTitle>
      <AlertDescription className="text-amber-900 dark:text-amber-200">
        <p>{NO_LISTENER_BODY}</p>
        {listenCommand ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <code
              data-testid={testId ? `${testId}-command` : undefined}
              className="min-w-0 rounded bg-white/70 px-1.5 py-0.5 font-mono text-[0.68rem] break-all text-amber-950 dark:bg-black/30 dark:text-amber-100"
            >
              {listenCommand}
            </code>
            <CopyCommandButton
              command={listenCommand}
              testId={testId ? `${testId}-copy` : undefined}
              className="h-6 bg-white/70 text-[0.68rem] dark:bg-black/20"
            />
          </div>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

export function AgentConnectionIndicator({
  agent,
}: {
  agent: Pick<CommentAgentContextValue, "available" | "status"> &
    Partial<Pick<CommentAgentContextValue, "threadSummary">>;
}) {
  if (!agent.available) return null;
  const listening = agent.status?.listening === true;
  const sessionId = agent.status?.sessionId;

  return (
    <>
      {agent.threadSummary ? (
        <span
          data-testid="agent-thread-summary"
          title="Ask/Change threads a Claude session has picked up"
          className="shrink-0 px-1 text-[0.72rem] font-medium text-stone-500 tabular-nums dark:text-slate-400"
        >
          {agent.threadSummary}
        </span>
      ) : null}
      <AgentListeningLabel listening={listening} sessionId={sessionId} />
    </>
  );
}

function AgentListeningLabel({
  listening,
  sessionId,
}: {
  listening: boolean;
  sessionId?: string;
}) {
  return (
    <span
      data-testid="agent-connection-indicator"
      data-listening={listening ? "true" : "false"}
      className="inline-flex min-w-0 shrink items-center gap-1 px-1 text-[0.72rem] font-medium text-stone-400 dark:text-slate-400"
      title={
        listening
          ? sessionId
            ? `Claude Code session ${sessionId} is listening for Ask and Change comments`
            : "A Claude Code session is listening for Ask and Change comments"
          : "No Claude Code session is listening. Run `roughdraft listen <file>` from a session to connect."
      }
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          listening ? "bg-emerald-500" : "bg-stone-300 dark:bg-slate-600",
        )}
      />
      <span className="truncate">
        {listening
          ? sessionId
            ? `Claude listening · session ${formatSessionLabel(sessionId)}`
            : "Claude listening"
          : "No Claude session listening"}
      </span>
    </span>
  );
}
