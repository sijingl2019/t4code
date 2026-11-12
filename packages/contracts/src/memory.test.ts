import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { GlobalMemorySettings, MemoryObservationDraft } from "./memory.ts";

const decodeSettings = Schema.decodeUnknownSync(GlobalMemorySettings);
const decodeDraft = Schema.decodeUnknownSync(MemoryObservationDraft);

describe("GlobalMemorySettings", () => {
  it("decodes an empty object to the defaults", () => {
    expect(decodeSettings({})).toEqual({
      enabled: false,
      everyTurns: 5,
      everyMinutes: 30,
      modelSelection: null,
    });
  });

  it("rejects turn and minute counts outside their ranges", () => {
    expect(() => decodeSettings({ everyTurns: 0 })).toThrow();
    expect(() => decodeSettings({ everyTurns: 51 })).toThrow();
    expect(() => decodeSettings({ everyMinutes: 0 })).toThrow();
    expect(() => decodeSettings({ everyMinutes: 1441 })).toThrow();
  });
});

describe("MemoryObservationDraft", () => {
  it("defaults files to an empty list", () => {
    expect(decodeDraft({ type: "decision", title: "Use pnpm", body: "Faster installs." })).toEqual({
      type: "decision",
      title: "Use pnpm",
      body: "Faster installs.",
      files: [],
    });
  });

  it("rejects an unknown type", () => {
    expect(() => decodeDraft({ type: "note", title: "x", body: "y" })).toThrow();
  });
});
