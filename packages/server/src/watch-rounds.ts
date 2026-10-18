/**
 * Long-polling `/api/review-events/watch` without tripping Node's fetch.
 *
 * Node's built-in fetch (undici) fails a request whose response sends no
 * headers within 300s (`UND_ERR_HEADERS_TIMEOUT`), so one unbounded long-poll
 * crashes on a slow reviewer. Clients poll in bounded rounds instead and
 * carry the event cursor between rounds so nothing is missed in the gaps.
 */

/** Well under undici's default 300s headers timeout. */
export const WATCH_ROUND_SECONDS = 50;

export interface WatchRoundPayload {
  events?: unknown[];
  timedOut?: boolean;
  nextSequence: number;
}

export interface WatchRoundCursor {
  fromNow: boolean;
  afterSequence?: number;
  timeoutSeconds: number;
}

/**
 * Client-side abort for one round: the server's wait plus some slack. The
 * last round waits for whatever time is left, which is rarely a whole number
 * of milliseconds, and AbortSignal.timeout() throws on non-integers.
 */
export function roundTimeoutSignal(
  timeoutSeconds: number,
  slackSeconds: number,
): AbortSignal {
  return AbortSignal.timeout(Math.ceil((timeoutSeconds + slackSeconds) * 1000));
}

/** Undici timeouts and our own round abort: retry, the server is fine. */
export function isRetryableWatchError(error: unknown): boolean {
  if (error instanceof Error && error.name === "TimeoutError") return true;
  const cause = error instanceof Error ? error.cause : undefined;
  const code =
    cause && typeof cause === "object" && "code" in cause
      ? (cause as { code?: unknown }).code
      : undefined;
  return code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT";
}

/**
 * Waits for the first round that returns events, or until `timeoutSeconds`
 * (unbounded when omitted). `afterSequence` resumes from a known cursor;
 * without it the cursor is pinned to "now" with an immediate first round so
 * later rounds resume from it instead of re-anchoring to whatever is latest.
 */
export async function watchInRounds<T extends WatchRoundPayload>(options: {
  poll: (cursor: WatchRoundCursor) => Promise<T>;
  afterSequence?: number;
  timeoutSeconds?: number;
  roundSeconds?: number;
}): Promise<T | WatchRoundPayload> {
  const roundLimit = options.roundSeconds ?? WATCH_ROUND_SECONDS;
  const deadline =
    options.timeoutSeconds !== undefined
      ? Date.now() + options.timeoutSeconds * 1000
      : undefined;
  const poll = async (cursor: WatchRoundCursor): Promise<T | null> => {
    try {
      return await options.poll(cursor);
    } catch (error) {
      if (isRetryableWatchError(error)) return null;
      throw error;
    }
  };

  let afterSequence = options.afterSequence;
  while (afterSequence === undefined) {
    const anchor = await poll({ fromNow: true, timeoutSeconds: 0 });
    if (anchor) afterSequence = anchor.nextSequence - 1;
  }

  for (;;) {
    const remainingSeconds =
      deadline !== undefined
        ? Math.max(0, (deadline - Date.now()) / 1000)
        : Number.POSITIVE_INFINITY;
    const roundSeconds = Math.min(remainingSeconds, roundLimit);
    const result = await poll({
      fromNow: false,
      afterSequence,
      timeoutSeconds: roundSeconds,
    });
    if (result) {
      afterSequence = result.nextSequence - 1;
      if (!result.timedOut || remainingSeconds <= roundSeconds) {
        return result;
      }
    } else if (deadline !== undefined && Date.now() >= deadline) {
      return { events: [], timedOut: true, nextSequence: afterSequence + 1 };
    }
  }
}
