import { TicketIcon } from "lucide-react";
import { ThreadDetailsControl } from "../components/chat/ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "../components/chat/threadDetailsPanelStyles";
import { ensureLocalApi } from "../localApi";

/** The issue link an auto-dev thread's opening prompt carries (`buildIssuePrompt` on the server). */
export function autoDevIssueUrl(
  messages: ReadonlyArray<{ readonly id: string; readonly role: string; readonly text: string }>,
): string | null {
  const opening = messages.find((message) => message.role === "user");
  if (opening?.id.startsWith("ones-auto-message:") !== true) return null;
  return opening.text.match(/^链接: (\S+)$/m)?.[1] ?? null;
}

/** "Open Issue" row of the thread details panel, under "Open in". */
export function AutoDevIssueButton({ url }: { readonly url: string }) {
  return (
    <ThreadDetailsControl
      size="sm"
      variant="ghost"
      onClick={() => void ensureLocalApi().shell.openExternal(url)}
    >
      <TicketIcon aria-hidden="true" className={THREAD_DETAILS_PANEL_ICON_CLASS} />
      <span className={THREAD_DETAILS_PANEL_LABEL_CLASS}>Open Issue</span>
    </ThreadDetailsControl>
  );
}
