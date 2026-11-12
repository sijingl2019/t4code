import { describe, expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  type GlobalMemorySettings,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RunStatus,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as MemoryService from "./MemoryService.ts";
import * as MemoryStore from "./MemoryStore.ts";

const storeLayer = MemoryStore.layer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

const threadId = ThreadId.make("thread-1");
const childThreadId = ThreadId.make("thread-child");
const projectId = ProjectId.make("project-1");
const model: ModelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "cheap" };
const ONE_MEMORY = '[{"type":"decision","title":"Use pnpm","body":"Faster."}]';

const enabledSettings: GlobalMemorySettings = {
  enabled: true,
  everyTurns: 3,
  everyMinutes: 30,
  modelSelection: null,
};

interface Harness {
  readonly service: MemoryService.MemoryService["Service"];
  readonly store: MemoryStore.MemoryStore["Service"];
  readonly settings: Ref.Ref<GlobalMemorySettings>;
  readonly runs: Ref.Ref<ReadonlyArray<{ ordinal: number; status: OrchestrationV2RunStatus }>>;
  readonly generations: Ref.Ref<number>;
  readonly reply: Ref.Ref<Effect.Effect<string>>;
}

const harness = (initial: GlobalMemorySettings) =>
  Effect.gen(function* () {
    const store = yield* MemoryStore.MemoryStore;
    yield* store.ensureSchema;
    const settings = yield* Ref.make(initial);
    const runs = yield* Ref.make<
      ReadonlyArray<{ ordinal: number; status: OrchestrationV2RunStatus }>
    >([]);
    const generations = yield* Ref.make(0);
    const reply = yield* Ref.make<Effect.Effect<string>>(Effect.succeed(ONE_MEMORY));
    const service = yield* MemoryService.makeWith({
      settings: Ref.get(settings).pipe(
        Effect.map((globalMemory) => ({ globalMemory, textGenerationModelSelection: model })),
      ),
      readThread: (id, afterOrdinal) =>
        Ref.get(runs).pipe(
          Effect.map((all) => ({
            projectId,
            projectName: "Project",
            threadTitle: "Thread",
            branch: null,
            delegated: id === childThreadId,
            runs: all
              .filter((run) => run.ordinal > afterOrdinal)
              .map((run) => ({ id: RunId.make(`run-${run.ordinal}`), ...run })),
            messages: all.flatMap((run) => [
              { runId: RunId.make(`run-${run.ordinal}`), role: "user" as const, text: "q" },
              { runId: RunId.make(`run-${run.ordinal}`), role: "assistant" as const, text: "a" },
            ]),
          })),
        ),
      generate: () =>
        Ref.update(generations, (n) => n + 1).pipe(Effect.andThen(Ref.get(reply)), Effect.flatten),
    });
    return { service, store, settings, runs, generations, reply } satisfies Harness;
  });

/** Appends a run to the fake thread and delivers its run.updated event. */
const endRun = (h: Harness, ordinal: number, id = threadId) =>
  Effect.gen(function* () {
    yield* Ref.update(h.runs, (runs) => [...runs, { ordinal, status: "completed" as const }]);
    yield* h.service.handle({
      type: "run.updated",
      threadId: id,
      payload: { ordinal, status: "completed", completedAt: null },
    } as unknown as OrchestrationV2DomainEvent);
  });

describe("MemoryService", () => {
  it.effect("does nothing while disabled", () =>
    Effect.gen(function* () {
      const h = yield* harness({ ...enabledSettings, enabled: false });
      for (const ordinal of [1, 2, 3, 4, 5]) yield* endRun(h, ordinal);
      yield* h.service.tick;
      yield* h.service.drain;
      expect(yield* Ref.get(h.generations)).toBe(0);
      expect(yield* h.store.pendingCursors).toEqual([]);
    }).pipe(Effect.provide(storeLayer)),
  );

  it.effect("summarizes after everyTurns runs", () =>
    Effect.gen(function* () {
      const h = yield* harness(enabledSettings);
      for (const ordinal of [1, 2, 3]) yield* endRun(h, ordinal);
      yield* h.service.drain;
      expect(yield* Ref.get(h.generations)).toBe(1);
      expect(yield* h.store.count).toBe(1);
      expect((yield* h.store.getCursor(threadId))?.summarizedThrough).toBe(3);
    }).pipe(Effect.provide(storeLayer)),
  );

  it.effect("summarizes on tick after everyMinutes", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-12T10:00:00.000Z"));
      const h = yield* harness(enabledSettings);
      yield* endRun(h, 1);
      yield* h.service.tick;
      yield* h.service.drain;
      expect(yield* Ref.get(h.generations)).toBe(0);
      yield* TestClock.adjust("31 minutes");
      yield* h.service.tick;
      yield* h.service.drain;
      expect(yield* Ref.get(h.generations)).toBe(1);
    }).pipe(Effect.provide(storeLayer)),
  );

  it.effect("leaves the cursor when the model output cannot be parsed", () =>
    Effect.gen(function* () {
      const h = yield* harness(enabledSettings);
      yield* Ref.set(h.reply, Effect.succeed("no memories"));
      for (const ordinal of [1, 2, 3]) yield* endRun(h, ordinal);
      yield* h.service.drain;
      expect(yield* h.store.count).toBe(0);
      expect((yield* h.store.getCursor(threadId))?.pendingCount).toBe(3);
    }).pipe(Effect.provide(storeLayer)),
  );

  it.effect("backs off after a failed summary instead of retrying every minute", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-12T10:00:00.000Z"));
      const h = yield* harness(enabledSettings);
      yield* Ref.set(h.reply, Effect.succeed("no memories"));
      for (const ordinal of [1, 2, 3]) yield* endRun(h, ordinal);
      yield* h.service.drain;
      expect(yield* Ref.get(h.generations)).toBe(1);
      yield* TestClock.adjust("1 minute");
      yield* h.service.tick;
      yield* h.service.drain;
      expect(yield* Ref.get(h.generations)).toBe(1);
      yield* TestClock.adjust("2 minutes");
      yield* h.service.tick;
      yield* h.service.drain;
      expect(yield* Ref.get(h.generations)).toBe(2);
    }).pipe(Effect.provide(storeLayer)),
  );

  it.effect("gives up on a thread after five failed summaries", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-12T10:00:00.000Z"));
      const h = yield* harness(enabledSettings);
      yield* Ref.set(h.reply, Effect.succeed("no memories"));
      for (const ordinal of [1, 2, 3]) yield* endRun(h, ordinal);
      yield* h.service.drain;
      for (let attempt = 0; attempt < 5; attempt++) {
        yield* TestClock.adjust("1 hour");
        yield* h.service.tick;
        yield* h.service.drain;
      }
      expect(yield* Ref.get(h.generations)).toBe(5);
      expect((yield* h.store.getCursor(threadId))?.pendingCount).toBe(0);
    }).pipe(Effect.provide(storeLayer)),
  );

  it.effect("keeps a run that ends during a summary pending", () =>
    Effect.gen(function* () {
      const h = yield* harness(enabledSettings);
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* Ref.set(
        h.reply,
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(ONE_MEMORY),
        ),
      );
      for (const ordinal of [1, 2, 3]) yield* endRun(h, ordinal);
      const draining = yield* h.service.drain.pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* endRun(h, 4);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(draining);
      const cursor = yield* h.store.getCursor(threadId);
      expect(cursor?.summarizedThrough).toBe(3);
      expect(cursor?.pendingCount).toBe(1);
    }).pipe(Effect.provide(storeLayer)),
  );

  it.effect("re-enabling drops cursors recorded before", () =>
    Effect.gen(function* () {
      const h = yield* harness(enabledSettings);
      yield* endRun(h, 1);
      yield* Ref.set(h.settings, { ...enabledSettings, enabled: false });
      yield* h.service.applySettings({ ...enabledSettings, enabled: false });
      yield* endRun(h, 2);
      yield* endRun(h, 3);
      yield* Ref.set(h.settings, enabledSettings);
      yield* h.service.applySettings(enabledSettings);
      expect(yield* h.store.pendingCursors).toEqual([]);
    }).pipe(Effect.provide(storeLayer)),
  );

  it.effect("skips delegated child threads", () =>
    Effect.gen(function* () {
      const h = yield* harness(enabledSettings);
      for (const ordinal of [1, 2, 3]) yield* endRun(h, ordinal, childThreadId);
      yield* h.service.drain;
      expect(yield* Ref.get(h.generations)).toBe(0);
      expect(yield* h.store.getCursor(childThreadId)).toBeNull();
    }).pipe(Effect.provide(storeLayer)),
  );

  it.effect("does not summarize queued threads once disabled", () =>
    Effect.gen(function* () {
      const h = yield* harness(enabledSettings);
      for (const ordinal of [1, 2, 3]) yield* endRun(h, ordinal);
      yield* Ref.set(h.settings, { ...enabledSettings, enabled: false });
      yield* h.service.drain;
      expect(yield* Ref.get(h.generations)).toBe(0);
    }).pipe(Effect.provide(storeLayer)),
  );

  it.effect("search reports disabled and returns nothing while off", () =>
    Effect.gen(function* () {
      const h = yield* harness(enabledSettings);
      for (const ordinal of [1, 2, 3]) yield* endRun(h, ordinal);
      yield* h.service.drain;
      const on = yield* h.service.search({ query: "pnpm", projectId: null, limit: 10 });
      expect(on.enabled).toBe(true);
      expect(on.memories.map((memory) => memory.title)).toEqual(["Use pnpm"]);
      yield* Ref.set(h.settings, { ...enabledSettings, enabled: false });
      expect(yield* h.service.search({ query: "pnpm", projectId: null, limit: 10 })).toEqual({
        enabled: false,
        memories: [],
      });
      expect(yield* h.service.recent({ projectId: null, limit: 10 })).toEqual({
        enabled: false,
        memories: [],
      });
    }).pipe(Effect.provide(storeLayer)),
  );

  it.effect("stops enqueueing on tick once disabled", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-12T10:00:00.000Z"));
      const h = yield* harness(enabledSettings);
      yield* endRun(h, 1);
      yield* Ref.set(h.settings, { ...enabledSettings, enabled: false });
      yield* TestClock.adjust("31 minutes");
      yield* h.service.tick;
      yield* h.service.drain;
      expect(yield* Ref.get(h.generations)).toBe(0);
    }).pipe(Effect.provide(storeLayer)),
  );
});
