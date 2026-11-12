import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import {
  buildMemoryPrompt,
  MEMORY_PROMPT_CHAR_BUDGET,
  parseMemoryObservations,
} from "./memoryPrompt.ts";

const base = { projectName: "t4code", threadTitle: "Memory", branch: "main", existingTitles: [] };

describe("buildMemoryPrompt", () => {
  it("keeps the newest turns within the budget", () => {
    const turns = ["A", "B", "C"].map((letter) => ({
      user: `${letter}-user`,
      assistant: letter.repeat(10_000),
    }));
    const prompt = buildMemoryPrompt({ ...base, turns });
    expect(prompt).not.toContain("A-user");
    expect(prompt).toContain("B-user");
    expect(prompt).toContain("C-user");
    expect(prompt.length).toBeLessThanOrEqual(MEMORY_PROMPT_CHAR_BUDGET + 3_000);
  });

  it("truncates a single turn that exceeds the budget", () => {
    const prompt = buildMemoryPrompt({
      ...base,
      turns: [{ user: "only-user", assistant: "x".repeat(50_000) }],
    });
    expect(prompt).toContain("only-user");
    expect(prompt.length).toBeLessThanOrEqual(MEMORY_PROMPT_CHAR_BUDGET + 3_000);
  });

  it("lists existing titles so the model avoids repeating them", () => {
    const prompt = buildMemoryPrompt({
      ...base,
      existingTitles: ["Use pnpm"],
      turns: [{ user: "u", assistant: "a" }],
    });
    expect(prompt).toContain("Use pnpm");
  });
});

describe("parseMemoryObservations", () => {
  const parse = (text: string) => Effect.exit(parseMemoryObservations(text));

  it.effect("parses a plain array", () =>
    Effect.gen(function* () {
      const exit = yield* parse('[{"type":"decision","title":"Use pnpm","body":"b"}]');
      expect(exit).toEqual(
        Exit.succeed([{ type: "decision", title: "Use pnpm", body: "b", files: [] }]),
      );
    }),
  );

  it.effect("parses an array inside a code fence with prose around it", () =>
    Effect.gen(function* () {
      const exit = yield* parse(
        'Here you go:\n```json\n[{"type":"bugfix","title":"Fix","body":"b","files":["a.ts"]}]\n```\nDone.',
      );
      expect(exit).toEqual(
        Exit.succeed([{ type: "bugfix", title: "Fix", body: "b", files: ["a.ts"] }]),
      );
    }),
  );

  it.effect("parses an empty array", () =>
    Effect.gen(function* () {
      expect(yield* parse("[]")).toEqual(Exit.succeed([]));
    }),
  );

  it.effect("drops invalid entries and keeps valid ones", () =>
    Effect.gen(function* () {
      const exit = yield* parse(
        '[{"type":"note","title":"x","body":"y"},{"type":"change","title":"Ok","body":"b"}]',
      );
      expect(exit).toEqual(Exit.succeed([{ type: "change", title: "Ok", body: "b", files: [] }]));
    }),
  );

  it.effect("fails on text without a JSON array", () =>
    Effect.gen(function* () {
      expect(Exit.isFailure(yield* parse("no memories"))).toBe(true);
    }),
  );
});
