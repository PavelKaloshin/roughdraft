import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { CopyCommandButton } from "./AgentConnection";
import {
  type AgentSessionSummary,
  type CommentAgentContextValue,
  formatAgentElapsed,
  getSessionFolderName,
  getSessionName,
  isSessionInDocumentFolder,
  SETUP_CLAUDE_COMMAND,
  sortSessionsForDocument,
} from "./comment-agent";
import { Button } from "./components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckmark,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuNote,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { cn } from "./lib/utils";

export const NO_SESSION_LABEL = "Claude · No session";
export const NO_LIVE_SESSIONS_TEXT =
  "No Claude Code sessions are running Roughdraft live review.";

/** "Claude · auth refactor · roughdraft", or the no-session label. */
export function formatOwnerLabel(
  owner: NonNullable<CommentAgentContextValue["status"]>["owner"],
) {
  if (!owner?.live) return NO_SESSION_LABEL;
  const folder = getSessionFolderName(owner.cwd);
  return ["Claude", getSessionName(owner), ...(folder ? [folder] : [])].join(
    " · ",
  );
}

function sessionDetails(session: AgentSessionSummary, now: number) {
  const parts: string[] = [];
  const folder = getSessionFolderName(session.cwd);
  if (folder) parts.push(folder);
  const lastActive = Date.parse(session.lastActiveAt);
  if (Number.isFinite(lastActive)) {
    parts.push(`active ${formatAgentElapsed(now - lastActive)} ago`);
  }
  const count = session.documents.length;
  parts.push(`${count} ${count === 1 ? "file" : "files"}`);
  return parts.join(" · ");
}

/**
 * Header control for document ownership (ADR 0007): which Claude Code
 * session receives this document's comments, and a menu to connect another
 * live session.
 */
export function AgentSessionMenu({
  agent,
}: {
  agent: Pick<
    CommentAgentContextValue,
    "status" | "connectSession" | "documentAbsolutePath"
  >;
}) {
  const [connecting, setConnecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const owner = agent.status?.owner ?? null;
  const live = owner?.live === true;
  const sessions = sortSessionsForDocument(
    agent.status?.sessions ?? [],
    agent.documentAbsolutePath ?? null,
  );
  const now = Date.now();
  const label = formatOwnerLabel(owner);

  const connect = async (sessionId: string) => {
    if (!agent.connectSession) return;
    setConnecting(sessionId);
    setError(null);
    try {
      await agent.connectSession(sessionId);
    } catch {
      setError("Could not connect the session. Is Roughdraft still running?");
    } finally {
      setConnecting(null);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="agent-connection-indicator"
            data-listening={live ? "true" : "false"}
            data-owner={owner?.sessionId ?? ""}
            className="h-7 min-w-0 shrink gap-1 px-1.5 text-[0.72rem] font-medium text-stone-500 dark:text-slate-400"
            title={
              live && owner
                ? `Claude Code session ${owner.sessionId} receives Ask and Change comments on this file`
                : owner
                  ? `Session ${owner.sessionId} owns this file but is not running. Connect another session.`
                  : "No Claude Code session receives Ask and Change comments on this file. Connect one."
            }
          />
        }
      >
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            live ? "bg-emerald-500" : "bg-stone-300 dark:bg-slate-600",
          )}
        />
        <span className="truncate">{label}</span>
        <ChevronDown className="size-3 shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        data-testid="agent-session-menu"
        className="w-80"
        align="end"
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel>Connect session</DropdownMenuLabel>
          {owner && !live ? (
            <DropdownMenuNote data-testid="agent-session-menu-offline-owner">
              {`${getSessionName(owner)} owned this file but is not running.`}
            </DropdownMenuNote>
          ) : null}
          {sessions.map((session) => {
            const isOwner = owner?.sessionId === session.sessionId;
            return (
              <DropdownMenuItem
                key={session.sessionId}
                data-testid={`agent-session-option-${session.sessionId}`}
                data-owner={isOwner ? "true" : "false"}
                disabled={
                  !agent.connectSession || isOwner || connecting !== null
                }
                onClick={() => void connect(session.sessionId)}
              >
                <DropdownMenuCheckmark checked={isOwner} />
                <span className="flex min-w-0 flex-col">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate font-medium">
                      {getSessionName(session)}
                    </span>
                    {isSessionInDocumentFolder(
                      session,
                      agent.documentAbsolutePath ?? null,
                    ) ? (
                      <span className="shrink-0 rounded bg-emerald-50 px-1 text-[0.65rem] text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                        this folder
                      </span>
                    ) : null}
                  </span>
                  <span className="truncate text-xs text-stone-500 dark:text-slate-400">
                    {sessionDetails(session, now)}
                  </span>
                </span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
        {sessions.length === 0 ? (
          <DropdownMenuNote data-testid="agent-session-menu-empty">
            <p>{NO_LIVE_SESSIONS_TEXT}</p>
            <p className="mt-1">
              Install the Claude Code plugin once, then start or resume a
              session:
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <code
                data-testid="agent-session-menu-setup-command"
                className="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[0.68rem] text-stone-800 dark:bg-slate-800 dark:text-slate-200"
              >
                {SETUP_CLAUDE_COMMAND}
              </code>
              <CopyCommandButton
                command={SETUP_CLAUDE_COMMAND}
                testId="agent-session-menu-copy-setup"
                className="h-6 text-[0.68rem]"
              />
            </div>
          </DropdownMenuNote>
        ) : null}
        {error ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuNote
              data-testid="agent-session-menu-error"
              className="text-red-700 dark:text-red-300"
            >
              {error}
            </DropdownMenuNote>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
