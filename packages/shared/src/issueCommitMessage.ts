/**
 * Commit messages for threads started from a tracker issue: `#123 <title>` with the issue
 * description as body. The thread is recognised by its first message, which the issue picker and
 * auto-dev both write with the server's `buildIssuePrompt` (`[ONES-123] <title>` first, then a
 * `## 问题描述` section).
 */
import { ISSUE_AUTO_DEV_MARKER } from "@t3tools/contracts";

export interface ThreadIssue {
  readonly key: string;
  readonly title: string;
  readonly description: string;
}

const MAX_BODY_CHARS = 2_000;

/** `ONES-123` → `#123`, the form commit subjects start with. */
export const commitRef = (key: string) => `#${key.slice(key.lastIndexOf("-") + 1)}`;

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

/** A typed message gets `#<number>` in front unless it already starts with it. */
export function issueCommitMessage(issue: ThreadIssue, typed: string | undefined): string {
  const message = typed?.trim() ?? "";
  const ref = commitRef(issue.key);
  if (message !== "") return message.startsWith(ref) ? message : `${ref} ${message}`;
  const subject = `${ref} ${issue.title}`;
  const body = issue.description.slice(0, MAX_BODY_CHARS).trim();
  return body === "" ? subject : `${subject}\n\n${body}`;
}

/** Auto-dev commit: `#<number> <title>`, then the run summary (the text posted as the issue comment). */
export function autoDevCommitMessage(
  issue: { readonly key: string; readonly title: string },
  summary: string,
): string {
  const subject = `${commitRef(issue.key)} ${issue.title}`;
  // The git action caps commit messages at 10k characters.
  const body = summary.trim().slice(0, 9_000).trim();
  return body === "" ? subject : `${subject}\n\n${body}`;
}

/** The commit message the Commit dialog starts with for a thread whose opening prompt is an issue. */
export function issueCommitDraft(
  messages: ReadonlyArray<{ readonly role: string; readonly text: string }>,
): string | null {
  const opening = messages.find((message) => message.role === "user");
  const issue = opening ? parseIssuePrompt(opening.text) : null;
  return issue ? issueCommitMessage(issue, undefined) : null;
}
