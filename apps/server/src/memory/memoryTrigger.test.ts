import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { isSummaryDue } from "./memoryTrigger.ts";

const settings = { everyTurns: 5, everyMinutes: 30 };
const now = Date.parse("2026-11-12T12:00:00.000Z");
const minutesAgo = (minutes: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(now - minutes * 60_000));

describe("isSummaryDue", () => {
  it("is never due without pending runs", () => {
    expect(isSummaryDue({ pendingCount: 0, oldestPendingAt: minutesAgo(999) }, settings, now)).toBe(
      false,
    );
  });

  it("is due once pending runs reach everyTurns", () => {
    expect(isSummaryDue({ pendingCount: 5, oldestPendingAt: minutesAgo(0) }, settings, now)).toBe(
      true,
    );
    expect(isSummaryDue({ pendingCount: 4, oldestPendingAt: minutesAgo(0) }, settings, now)).toBe(
      false,
    );
  });

  it("is due once the oldest pending run is older than everyMinutes", () => {
    expect(isSummaryDue({ pendingCount: 2, oldestPendingAt: minutesAgo(31) }, settings, now)).toBe(
      true,
    );
    expect(isSummaryDue({ pendingCount: 2, oldestPendingAt: minutesAgo(29) }, settings, now)).toBe(
      false,
    );
  });

  it("uses only the turn count without a pending timestamp", () => {
    expect(isSummaryDue({ pendingCount: 2, oldestPendingAt: null }, settings, now)).toBe(false);
  });
});
