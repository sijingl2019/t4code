import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

export const MIN_GLOBAL_MEMORY_EVERY_TURNS = 1;
export const MAX_GLOBAL_MEMORY_EVERY_TURNS = 50;
export const MIN_GLOBAL_MEMORY_EVERY_MINUTES = 1;
export const MAX_GLOBAL_MEMORY_EVERY_MINUTES = 1440;

/** Off by default: summarizing threads spends model calls. */
export const GlobalMemorySettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  everyTurns: Schema.Int.check(
    Schema.isBetween({
      minimum: MIN_GLOBAL_MEMORY_EVERY_TURNS,
      maximum: MAX_GLOBAL_MEMORY_EVERY_TURNS,
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed(5))),
  everyMinutes: Schema.Int.check(
    Schema.isBetween({
      minimum: MIN_GLOBAL_MEMORY_EVERY_MINUTES,
      maximum: MAX_GLOBAL_MEMORY_EVERY_MINUTES,
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed(30))),
  // Null follows textGenerationModelSelection.
  modelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type GlobalMemorySettings = typeof GlobalMemorySettings.Type;

export const MemoryObservationType = Schema.Literals([
  "decision",
  "bugfix",
  "discovery",
  "preference",
  "change",
]);
export type MemoryObservationType = typeof MemoryObservationType.Type;

export const MemoryObservationDraft = Schema.Struct({
  type: MemoryObservationType,
  title: TrimmedNonEmptyString,
  body: Schema.String,
  files: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type MemoryObservationDraft = typeof MemoryObservationDraft.Type;

export const MemoryObservation = Schema.Struct({
  ...MemoryObservationDraft.fields,
  id: Schema.Int,
  projectId: ProjectId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});
export type MemoryObservation = typeof MemoryObservation.Type;

export const MemoryStats = Schema.Struct({ count: NonNegativeInt });
export type MemoryStats = typeof MemoryStats.Type;

export const MemoryEmptyInput = Schema.Struct({});

export class MemoryStoreError extends Schema.TaggedError<MemoryStoreError>()("MemoryStoreError", {
  detail: Schema.String,
}) {}
