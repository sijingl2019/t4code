import type { ProviderApprovalOption } from "@t3tools/contracts";
import { msg } from "gt-react";

export const DEFAULT_APPROVAL_OPTIONS = [
  {
    decision: "cancel",
    label: msg("Cancel", { $context: "verb, response to an approval request" }),
  },
  {
    decision: "decline",
    label: msg("Decline", { $context: "verb, response to an approval request" }),
  },
  { decision: "acceptForSession", label: msg("Always allow this session") },
  {
    decision: "accept",
    label: msg("Approve", { $context: "verb, response to an approval request" }),
  },
] satisfies ReadonlyArray<ProviderApprovalOption>;
