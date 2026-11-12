/**
 * Commit messages for threads started from a tracker issue. While auto development is on, a commit
 * from such a thread must carry the issue: `ONES-123 <title>` with the issue description as body.
 * The thread is recognised by its first message, which the issue picker and auto-dev both write
 * with `buildIssuePrompt` (`[ONES-123] <title>` first, then a `## 问题描述` section).
 */
import { ISSUE_AUTO_DEV_MARKER, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type * as ServerSettings from "../serverSettings.ts";

export interface ThreadIssue {
  readonly key: string;
  readonly title: string;
  readonly description: string;
}

const MAX_BODY_CHARS = 2_000;

/** The issue a thread's first message was built from, or null for other threads. */
export function parseIssuePrompt(text: string): ThreadIssue | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const head = lines[0]?.match(/^\[([A-Z][A-Z0-9]*-\d+)\]\s+(.+)$/);
  if (!head) return null;
  const start = lines.findIndex((line) => line.trim() === "## 问题描述");
  const end =
    start === -1 ? -1 : lines.findIndex((line, index) => index > start && line.startsWith("## "));
  let description =
    start === -1
      ? ""
      : lines
          .slice(start + 1, end === -1 ? undefined : end)
          .join("\n")
          .trim();
  if (description.startsWith(ISSUE_AUTO_DEV_MARKER)) {
    description = description.slice(ISSUE_AUTO_DEV_MARKER.length).trim();
  }
  if (description === "(无描述)") description = "";
  return { key: head[1]!, title: head[2]!.trim(), description };
}

/** A typed message gets the issue key in front unless it already names it. */
export function issueCommitMessage(issue: ThreadIssue, typed: string | undefined): string {
  const message = typed?.trim() ?? "";
  if (message !== "") return message.includes(issue.key) ? message : `${issue.key} ${message}`;
  const subject = `${issue.key} ${issue.title}`;
  const body = issue.description.slice(0, MAX_BODY_CHARS).trim();
  return body === "" ? subject : `${subject}\n\n${body}`;
}

/** The commit message to use for a thread, or `typed` unchanged when no issue rule applies. */
export const resolveIssueCommitMessage = Effect.fn("resolveIssueCommitMessage")(
  function* (
    deps: {
      readonly threads: ProjectionStore.ProjectionStoreV2["Service"];
      readonly settings: ServerSettings.ServerSettingsService["Service"];
    },
    threadId: ThreadId | undefined,
    typed: string | undefined,
  ) {
    if (threadId === undefined) return typed;
    const settings = yield* deps.settings.getSettings;
    if (!settings.issueAutoDev.enabled) return typed;
    const { visibleTurnItems } = yield* deps.threads.getThreadProjection(threadId);
    const first = visibleTurnItems.find(({ item }) => item.type === "user_message")?.item;
    const issue = first?.type === "user_message" ? parseIssuePrompt(first.text) : null;
    return issue ? issueCommitMessage(issue, typed) : typed;
  },
  // Never block a commit on this lookup.
  (effect, _deps, _threadId, typed) => effect.pipe(Effect.orElseSucceed(() => typed)),
);
