/**
 * Commit messages for threads started from a tracker issue. While auto development is on, a commit
 * from such a thread must carry the issue: `#123 <title>` with the issue description as body.
 * The thread is recognised by its first message, which the issue picker and auto-dev both write
 * with `buildIssuePrompt` (`[ONES-123] <title>` first, then a `## 问题描述` section).
 */
import type { ThreadId } from "@t3tools/contracts";
import { issueCommitMessage, parseIssuePrompt } from "@t3tools/shared/issueCommitMessage";
import * as Effect from "effect/Effect";

import type * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type * as ServerSettings from "../serverSettings.ts";

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
