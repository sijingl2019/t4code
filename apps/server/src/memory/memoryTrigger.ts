import type { OrchestrationV2RunStatus } from "@t3tools/contracts";

/** Run end states that count as a turn worth remembering. */
export const COUNTED_RUN_STATUSES: ReadonlySet<OrchestrationV2RunStatus> = new Set([
  "completed",
  "failed",
  "interrupted",
]);

/** Due after `everyTurns` pending runs or `everyMinutes` since the oldest one, whichever comes first. */
export const isSummaryDue = (
  cursor: { readonly pendingCount: number; readonly oldestPendingAt: string | null },
  settings: { readonly everyTurns: number; readonly everyMinutes: number },
  nowMs: number,
): boolean => {
  if (cursor.pendingCount <= 0) return false;
  if (cursor.pendingCount >= settings.everyTurns) return true;
  if (cursor.oldestPendingAt === null) return false;
  return nowMs - Date.parse(cursor.oldestPendingAt) >= settings.everyMinutes * 60_000;
};
