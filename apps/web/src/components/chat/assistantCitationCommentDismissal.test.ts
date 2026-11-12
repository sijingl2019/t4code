import { ASSISTANT_CITATION_MAX_COMMENT_LENGTH } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveAssistantCitationCommentDismissal } from "./assistantCitationCommentDismissal";

describe("resolveAssistantCitationCommentDismissal", () => {
  it("discards the draft like Cancel when the popover is dismissed", () => {
    for (const reason of ["outside-press", "focus-out", "escape-key"]) {
      expect(
        resolveAssistantCitationCommentDismissal({
          reason,
          draft: "second thought",
          savedComment: "first thought",
        }),
      ).toEqual({ kind: "close" });
    }
  });

  it("commits typed text when the editor closes without a dismissal", () => {
    expect(
      resolveAssistantCitationCommentDismissal({
        reason: "none",
        draft: "needs a retry",
        savedComment: undefined,
      }),
    ).toEqual({ kind: "commit", comment: "needs a retry" });
  });

  it("keeps the popover open instead of dropping an over-length draft", () => {
    expect(
      resolveAssistantCitationCommentDismissal({
        reason: "none",
        draft: "x".repeat(ASSISTANT_CITATION_MAX_COMMENT_LENGTH + 1),
        savedComment: undefined,
      }),
    ).toEqual({ kind: "keep-open" });
  });
});
