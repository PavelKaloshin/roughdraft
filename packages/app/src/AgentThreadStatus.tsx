import { Check, CircleDashed, Clock, GitFork, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
  type AgentThreadTiming,
  formatAgentElapsed,
  getThreadAgentStatusLabel,
  isActiveThreadStatus,
  QUEUED_BUSY_HINT,
  QUEUED_BUSY_HINT_AFTER_MS,
  type ThreadAgentDisplayStatus,
} from "./comment-agent";

function parseTime(value: string | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

/** Re-renders every second while `enabled`, returning the current time. */
function useNow(enabled: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [enabled]);
  return now;
}

function StatusIcon({ status }: { status: ThreadAgentDisplayStatus }) {
  switch (status) {
    case "sending":
    case "working":
      return <Loader2 className="size-3 animate-spin" />;
    case "pending":
      return <CircleDashed className="size-3" />;
    case "queued":
      return <Clock className="size-3" />;
    case "delegated":
      return <GitFork className="size-3" />;
    default:
      return (
        <Check className="size-3 text-emerald-600 dark:text-emerald-500" />
      );
  }
}

/**
 * The status line under an Ask/Change thread: where the request is in the
 * agent lifecycle, how long ago the user asked (ticking live while Claude
 * still owes an answer), and a hint when a session holds it queued a while.
 */
export function AgentThreadStatusLine({
  status,
  listening,
  since,
  requestedAt,
  delegatedTo,
  testId,
}: {
  status: ThreadAgentDisplayStatus;
  listening: boolean;
  /** When the thread entered `status` (server time, ISO 8601). */
  since?: string;
  /** When the user's latest request reached the server (ISO 8601). */
  requestedAt?: string;
  /** A `delegated` thread handed to a headless fork, not a subagent. */
  delegatedTo?: AgentThreadTiming["delegatedTo"];
  testId: string;
}) {
  const active = isActiveThreadStatus(status);
  const requestedTime = active ? parseTime(requestedAt) : null;
  const statusTime = parseTime(since);
  const now = useNow(requestedTime !== null || status === "queued");
  const showBusyHint =
    status === "queued" &&
    statusTime !== null &&
    now - statusTime > QUEUED_BUSY_HINT_AFTER_MS;

  return (
    <div data-testid={testId} data-agent-status={status} className="mt-1">
      <div className="flex flex-wrap items-center gap-x-1 text-[11px] leading-4 font-medium text-stone-500 dark:text-slate-400">
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
          <StatusIcon status={status} />
          <span data-testid={`${testId}-label`}>
            {getThreadAgentStatusLabel(status, { listening, delegatedTo })}
          </span>
        </span>
        {requestedTime !== null ? (
          <span className="whitespace-nowrap">
            <span aria-hidden="true">· </span>
            <span
              data-testid={`${testId}-elapsed`}
              className="tabular-nums"
              title="Time since your comment"
            >
              {formatAgentElapsed(now - requestedTime)}
            </span>
          </span>
        ) : null}
      </div>
      {showBusyHint ? (
        <p
          data-testid={`${testId}-busy-hint`}
          className="mt-0.5 text-[11px] leading-4 text-stone-400 dark:text-slate-500"
        >
          {QUEUED_BUSY_HINT}
        </p>
      ) : null}
    </div>
  );
}
