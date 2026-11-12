import {
  type GlobalMemorySettings,
  type MemoryObservation,
  type MemoryStats,
  type MemoryStoreError,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RunStatus,
  type ProjectId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { buildMemoryPrompt, parseMemoryObservations, type MemoryTurn } from "./memoryPrompt.ts";
import * as MemoryStore from "./MemoryStore.ts";
import { COUNTED_RUN_STATUSES, isSummaryDue } from "./memoryTrigger.ts";

export interface MemorySettingsView {
  readonly globalMemory: GlobalMemorySettings;
  readonly textGenerationModelSelection: ModelSelection;
}

export interface MemoryThreadSource {
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly threadTitle: string;
  readonly branch: string | null;
  /** Delegated child threads repeat what their parent already concludes. */
  readonly delegated: boolean;
  /** Runs with ordinal above the requested one. */
  readonly runs: ReadonlyArray<{
    readonly id: RunId;
    readonly ordinal: number;
    readonly status: OrchestrationV2RunStatus;
  }>;
  readonly messages: ReadonlyArray<{
    readonly runId: RunId | null;
    readonly role: "user" | "assistant" | "system";
    readonly text: string;
  }>;
}

export class MemorySourceError extends Schema.TaggedError<MemorySourceError>()(
  "MemorySourceError",
  { operation: Schema.String, detail: Schema.String },
) {}

const sourceError = (operation: string) => (cause: unknown) =>
  new MemorySourceError({ operation, detail: String(cause) });

export interface MemoryDeps {
  readonly settings: Effect.Effect<MemorySettingsView, MemorySourceError>;
  /** Null when the thread or its project is gone. */
  readonly readThread: (
    threadId: ThreadId,
    afterOrdinal: number,
  ) => Effect.Effect<MemoryThreadSource | null, MemorySourceError>;
  readonly generate: (input: {
    readonly prompt: string;
    readonly modelSelection: ModelSelection;
  }) => Effect.Effect<string, MemorySourceError>;
}

interface MemoryListInput {
  readonly projectId: ProjectId | null;
  readonly limit: number;
}

export class MemoryService extends Context.Service<
  MemoryService,
  {
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    readonly applySettings: (settings: GlobalMemorySettings) => Effect.Effect<void>;
    readonly tick: Effect.Effect<void>;
    /** Summarizes everything queued, waiting for a summary already in flight. */
    readonly drain: Effect.Effect<void>;
    /** Wakes when something is queued; `start` runs `drain` on each wake. */
    readonly queued: Effect.Effect<void>;
    readonly stats: Effect.Effect<MemoryStats, MemoryStoreError>;
    readonly clear: Effect.Effect<MemoryStats, MemoryStoreError>;
    readonly search: (
      input: MemoryListInput & { readonly query: string },
    ) => Effect.Effect<
      { readonly enabled: boolean; readonly memories: ReadonlyArray<MemoryObservation> },
      MemoryStoreError
    >;
    readonly recent: (
      input: MemoryListInput,
    ) => Effect.Effect<
      { readonly enabled: boolean; readonly memories: ReadonlyArray<MemoryObservation> },
      MemoryStoreError
    >;
  }
>()("t3/memory/MemoryService") {}

const EXISTING_TITLES_LIMIT = 20;
/** After this many failed summaries in a row the pending turns are skipped, not retried forever. */
const MAX_SUMMARY_FAILURES = 5;

export const makeWith = Effect.fn("MemoryService.makeWith")(function* (deps: MemoryDeps) {
  const store = yield* MemoryStore.MemoryStore;
  const queue = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
  const wake = yield* Queue.sliding<void>(1);
  const processing = yield* Semaphore.make(1);
  // ponytail: in memory, so a restart forgets backoff; persist it if restarts loop on a bad thread.
  const failures = yield* Ref.make(
    new Map<ThreadId, { readonly count: number; readonly retryAtMs: number }>(),
  );
  const initial = yield* deps.settings.pipe(Effect.option);
  const lastEnabled = yield* Ref.make(Option.isSome(initial) && initial.value.globalMemory.enabled);

  const currentSettings = deps.settings.pipe(Effect.option, Effect.map(Option.getOrNull));
  const enabledSettings = currentSettings.pipe(
    Effect.map((settings) => (settings?.globalMemory.enabled ? settings : null)),
  );

  const enqueue = Effect.fnUntraced(function* (threadId: ThreadId) {
    const failure = (yield* Ref.get(failures)).get(threadId);
    if (failure !== undefined && (yield* Clock.currentTimeMillis) < failure.retryAtMs) return;
    const added = yield* Ref.modify(queue, (ids) =>
      ids.includes(threadId) ? [false, ids] : [true, [...ids, threadId]],
    );
    if (added) yield* Queue.offer(wake, undefined);
  });

  /** Exponential backoff (2, 4, 8, 16 minutes); the fifth failure skips the pending turns. */
  const recordFailure = Effect.fn("MemoryService.recordFailure")(function* (threadId: ThreadId) {
    const count = ((yield* Ref.get(failures)).get(threadId)?.count ?? 0) + 1;
    if (count < MAX_SUMMARY_FAILURES) {
      const retryAtMs = (yield* Clock.currentTimeMillis) + 2 ** count * 60_000;
      yield* Ref.update(failures, (map) => new Map(map).set(threadId, { count, retryAtMs }));
      return;
    }
    yield* Ref.update(failures, (map) => {
      const next = new Map(map);
      next.delete(threadId);
      return next;
    });
    const cursor = yield* store.getCursor(threadId);
    if (cursor === null) return;
    yield* Effect.logWarning("global memory gave up summarizing a thread", { threadId });
    yield* store.commitSummary({
      threadId,
      projectId: cursor.projectId,
      throughOrdinal: cursor.latestOrdinal,
      observations: [],
      createdAt: yield* nowIso,
    });
  });

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const summarize = Effect.fn("MemoryService.summarize")(function* (threadId: ThreadId) {
    const settings = yield* enabledSettings;
    if (settings === null) return;
    const cursor = yield* store.getCursor(threadId);
    // Queued while due; an earlier summary may have consumed the runs since.
    if (
      cursor === null ||
      !isSummaryDue(cursor, settings.globalMemory, yield* Clock.currentTimeMillis)
    ) {
      return;
    }
    const source = yield* deps.readThread(threadId, cursor.summarizedThrough);
    const createdAt = yield* nowIso;
    const ended = (source?.runs ?? [])
      .filter((run) => COUNTED_RUN_STATUSES.has(run.status))
      .toSorted((a, b) => a.ordinal - b.ordinal);
    const last = ended.at(-1);
    if (source === null || last === undefined) {
      // Thread gone or its pending runs were rolled back: nothing left to remember.
      yield* store.commitSummary({
        threadId,
        projectId: cursor.projectId,
        throughOrdinal: cursor.latestOrdinal,
        observations: [],
        createdAt,
      });
      return;
    }
    const turns: Array<MemoryTurn> = ended.map((run) => {
      const own = source.messages.filter((message) => message.runId === run.id);
      return {
        user: own.find((message) => message.role === "user")?.text ?? "",
        assistant: own.findLast((message) => message.role === "assistant")?.text ?? "",
      };
    });
    const prompt = buildMemoryPrompt({
      projectName: source.projectName,
      threadTitle: source.threadTitle,
      branch: source.branch,
      existingTitles: yield* store.titlesForThread(threadId, EXISTING_TITLES_LIMIT),
      turns,
    });
    const text = yield* deps.generate({
      prompt,
      modelSelection: settings.globalMemory.modelSelection ?? settings.textGenerationModelSelection,
    });
    const observations = yield* parseMemoryObservations(text);
    yield* store.commitSummary({
      threadId,
      projectId: source.projectId,
      throughOrdinal: last.ordinal,
      observations,
      createdAt,
    });
  });

  const drain: Effect.Effect<void> = processing.withPermits(1)(
    Effect.gen(function* () {
      while (true) {
        const next = yield* Ref.modify(queue, (ids) => [ids[0], ids.slice(1)]);
        if (next === undefined) return;
        yield* summarize(next).pipe(
          Effect.tap(() =>
            Ref.update(failures, (map) => {
              const after = new Map(map);
              after.delete(next);
              return after;
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("global memory summary failed; will retry", {
              threadId: next,
              cause,
            }).pipe(Effect.andThen(recordFailure(next)), Effect.ignore),
          ),
        );
      }
    }),
  );

  const handle = Effect.fnUntraced(
    function* (event: OrchestrationV2DomainEvent) {
      if (event.type !== "run.updated") return;
      const run = event.payload;
      if (!COUNTED_RUN_STATUSES.has(run.status) || run.delegatedTaskId !== undefined) return;
      const settings = yield* enabledSettings;
      if (settings === null) return;
      const source = yield* deps.readThread(event.threadId, run.ordinal);
      if (source === null || source.delegated) return;
      const completedAt =
        run.completedAt === null ? yield* nowIso : DateTime.formatIso(run.completedAt);
      yield* store.recordRunEnded({
        threadId: event.threadId,
        projectId: source.projectId,
        ordinal: run.ordinal,
        completedAt,
      });
      const cursor = yield* store.getCursor(event.threadId);
      const now = yield* Clock.currentTimeMillis;
      if (cursor !== null && isSummaryDue(cursor, settings.globalMemory, now)) {
        yield* enqueue(event.threadId);
      }
    },
    Effect.catchCause((cause) => Effect.logWarning("global memory event failed", { cause })),
  );

  const tick: Effect.Effect<void> = Effect.gen(function* () {
    const settings = yield* enabledSettings;
    if (settings === null) return;
    const now = yield* Clock.currentTimeMillis;
    for (const cursor of yield* store.pendingCursors) {
      if (isSummaryDue(cursor, settings.globalMemory, now)) yield* enqueue(cursor.threadId);
    }
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("global memory tick failed", { cause })));

  const applySettings = Effect.fn("MemoryService.applySettings")(
    function* (settings: GlobalMemorySettings) {
      const was = yield* Ref.getAndSet(lastEnabled, settings.enabled);
      // Runs that ended while off are not owed a summary.
      if (!was && settings.enabled) yield* store.resetCursors;
    },
    Effect.catchCause((cause) => Effect.logWarning("global memory settings failed", { cause })),
  );

  const listed = <A>(effect: Effect.Effect<A, MemoryStoreError>, empty: A) =>
    enabledSettings.pipe(
      Effect.flatMap((settings) =>
        settings === null
          ? Effect.succeed({ enabled: false, memories: empty })
          : effect.pipe(Effect.map((memories) => ({ enabled: true, memories }))),
      ),
    );

  return MemoryService.of({
    handle,
    applySettings,
    tick,
    drain,
    queued: Queue.take(wake),
    stats: store.count.pipe(Effect.map((count) => ({ count }))),
    clear: store.clear.pipe(Effect.as({ count: 0 })),
    search: Effect.fn("MemoryService.search")((input) => listed(store.search(input), [])),
    recent: Effect.fn("MemoryService.recent")((input) => listed(store.recent(input), [])),
  });
});

/** Runs the service: event subscription, settings watch, the due-check timer and the summary worker. */
const start = Effect.fn("MemoryService.start")(function* (
  service: MemoryService["Service"],
  events: Stream.Stream<OrchestrationV2DomainEvent, Orchestrator.OrchestratorV2Error>,
  settingsChanges: Stream.Stream<{ readonly globalMemory: GlobalMemorySettings }>,
) {
  yield* forkParked(
    Stream.runForEach(events, service.handle).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("global memory event stream failed", { cause }),
      ),
    ),
  );
  yield* forkParked(
    Stream.runForEach(settingsChanges, (settings) => service.applySettings(settings.globalMemory)),
  );
  yield* forkParked(Effect.repeat(service.tick, Schedule.spaced("1 minute")));
  yield* forkParked(Effect.forever(service.queued.pipe(Effect.andThen(service.drain))));
});

export const layer = Layer.effect(
  MemoryService,
  Effect.gen(function* () {
    const store = yield* MemoryStore.MemoryStore;
    const settingsService = yield* ServerSettings.ServerSettingsService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const textGeneration = yield* TextGeneration.TextGeneration;
    const fileSystem = yield* FileSystem.FileSystem;
    yield* store.ensureSchema.pipe(
      Effect.catchCause((cause) => Effect.logWarning("global memory schema failed", { cause })),
    );

    const service = yield* makeWith({
      settings: settingsService.getSettings.pipe(Effect.mapError(sourceError("settings"))),
      readThread: Effect.fn("MemoryService.readThread")(
        function* (threadId: ThreadId, afterOrdinal: number) {
          const runRecords = yield* projections.getThreadRecords(threadId, ["runs"]);
          const thread = runRecords.thread;
          if (thread.deletedAt !== null) return null;
          const project = yield* projects.get(thread.projectId);
          if (Option.isNone(project)) return null;
          const runs = runRecords.runs.filter((run) => run.ordinal > afterOrdinal);
          const messages =
            runs.length === 0
              ? []
              : (yield* projections.getThreadRecords(threadId, ["messages"], {
                  messageRoles: ["user", "assistant"],
                  messageRunIds: runs.map((run) => run.id),
                })).messages.filter((message) => !message.streaming);
          return {
            projectId: thread.projectId,
            projectName: project.value.title,
            threadTitle: thread.title,
            branch: thread.branch,
            delegated: thread.delegatedFrom !== undefined,
            runs,
            messages,
          };
        },
        Effect.mapError(sourceError("readThread")),
      ),
      // Providers run in a working directory; summaries must not read a checkout.
      generate: Effect.fn("MemoryService.generate")(
        function* (input: { readonly prompt: string; readonly modelSelection: ModelSelection }) {
          const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t4-memory-" });
          const result = yield* textGeneration.generateTranscriptionPostProcessing({
            cwd,
            prompt: input.prompt,
            modelSelection: input.modelSelection,
          });
          return result.transcription;
        },
        Effect.scoped,
        Effect.mapError(sourceError("generate")),
      ),
    });
    yield* start(service, orchestrator.streamDomainEvents, settingsService.streamChanges);
    return service;
  }),
);
