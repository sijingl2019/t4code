import { MemoryObservationDraft } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface MemoryTurn {
  readonly user: string;
  readonly assistant: string;
}

export const MEMORY_PROMPT_CHAR_BUDGET = 24_000;

export class MemoryParseError extends Schema.TaggedError<MemoryParseError>()("MemoryParseError", {
  detail: Schema.String,
}) {}

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const INSTRUCTIONS = `You maintain long-term memory for a developer's coding-agent threads.
Read the conversation turns below and extract only what is worth remembering in future threads:
decisions and their reasons, bug fixes and root causes, non-obvious discoveries about the codebase
or tools, the developer's stated preferences, and notable changes.

Reply with ONLY a JSON array, no prose. Each element:
{"type": "decision" | "bugfix" | "discovery" | "preference" | "change",
 "title": "one short sentence",
 "body": "a few sentences: what, and why",
 "files": ["relative/paths", "..."]}
Reply [] when nothing is worth remembering (small talk, unfinished work, no conclusions).
Write in the language the conversation uses. Do not repeat a memory listed under "Already remembered".`;

const formatTurn = (turn: MemoryTurn, index: number) =>
  `### Turn ${index + 1}\nUser:\n${turn.user}\n\nAssistant:\n${turn.assistant}\n`;

/** Newest turns first into the budget; the oldest are dropped, an oversized single turn is cut. */
export const buildMemoryPrompt = (input: {
  readonly projectName: string;
  readonly threadTitle: string;
  readonly branch: string | null;
  readonly existingTitles: ReadonlyArray<string>;
  readonly turns: ReadonlyArray<MemoryTurn>;
}): string => {
  const kept: Array<string> = [];
  let used = 0;
  for (let index = input.turns.length - 1; index >= 0; index--) {
    const turn = input.turns[index]!;
    let text = formatTurn(turn, index);
    const remaining = MEMORY_PROMPT_CHAR_BUDGET - used;
    if (text.length > remaining) {
      if (kept.length > 0) break;
      text = `${text.slice(0, remaining)}\n[truncated]\n`;
    }
    kept.unshift(text);
    used += text.length;
  }
  const remembered =
    input.existingTitles.length === 0
      ? "(none)"
      : input.existingTitles.map((title) => `- ${title}`).join("\n");
  return [
    INSTRUCTIONS,
    `## Context\nProject: ${input.projectName}\nThread: ${input.threadTitle}\nBranch: ${input.branch ?? "(none)"}`,
    `## Already remembered\n${remembered}`,
    `## Conversation\n${kept.join("\n")}`,
  ].join("\n\n");
};

const decodeDraft = Schema.decodeUnknownOption(MemoryObservationDraft);

export const parseMemoryObservations = Effect.fn("memoryPrompt.parseMemoryObservations")(function* (
  text: string,
) {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end < start) {
    return yield* new MemoryParseError({ detail: "no JSON array in model output" });
  }
  const value = yield* decodeJson(text.slice(start, end + 1)).pipe(
    Effect.mapError(() => new MemoryParseError({ detail: "model output is not valid JSON" })),
  );
  if (!Array.isArray(value)) {
    return yield* new MemoryParseError({ detail: "model output is not a JSON array" });
  }
  return value.flatMap((item) => Option.toArray(decodeDraft(item)));
});
