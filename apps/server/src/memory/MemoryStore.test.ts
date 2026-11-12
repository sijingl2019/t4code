import { describe, expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as MemoryStore from "./MemoryStore.ts";

const layer = MemoryStore.layer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");
const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const t1 = "2026-11-12T10:00:00.000Z";
const t2 = "2026-11-12T10:05:00.000Z";

const setup = Effect.gen(function* () {
  const store = yield* MemoryStore.MemoryStore;
  yield* store.ensureSchema;
  return store;
});

const ended = (ordinal: number, threadId = threadA, completedAt = t1) => ({
  threadId,
  projectId: threadId === threadA ? projectA : projectB,
  ordinal,
  completedAt,
});

describe("MemoryStore cursors", () => {
  it.effect("first run end starts the cursor just before that run", () =>
    Effect.gen(function* () {
      const store = yield* setup;
      yield* store.recordRunEnded(ended(7));
      // An interrupted run reports its terminal status again once its checkpoint lands.
      yield* store.recordRunEnded(ended(7));
      expect(yield* store.getCursor(threadA)).toEqual({
        threadId: threadA,
        projectId: projectA,
        summarizedThrough: 6,
        latestOrdinal: 7,
        pendingCount: 1,
        oldestPendingAt: t1,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps runs that ended after the summarized ordinal pending", () =>
    Effect.gen(function* () {
      const store = yield* setup;
      yield* store.recordRunEnded(ended(7));
      yield* store.recordRunEnded(ended(8));
      yield* store.recordRunEnded(ended(9));
      yield* store.commitSummary({
        threadId: threadA,
        projectId: projectA,
        throughOrdinal: 8,
        observations: [],
        createdAt: t2,
      });
      const cursor = yield* store.getCursor(threadA);
      expect(cursor?.summarizedThrough).toBe(8);
      expect(cursor?.pendingCount).toBe(1);
      expect(cursor?.oldestPendingAt).toBe(t2);
      yield* store.commitSummary({
        threadId: threadA,
        projectId: projectA,
        throughOrdinal: 9,
        observations: [],
        createdAt: t2,
      });
      expect((yield* store.getCursor(threadA))?.oldestPendingAt).toBeNull();
      expect(yield* store.pendingCursors).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("ignores runs at or below the cursor", () =>
    Effect.gen(function* () {
      const store = yield* setup;
      yield* store.recordRunEnded(ended(7));
      yield* store.commitSummary({
        threadId: threadA,
        projectId: projectA,
        throughOrdinal: 7,
        observations: [],
        createdAt: t2,
      });
      yield* store.recordRunEnded(ended(7));
      expect((yield* store.getCursor(threadA))?.pendingCount).toBe(0);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("resetCursors keeps observations", () =>
    Effect.gen(function* () {
      const store = yield* setup;
      yield* store.recordRunEnded(ended(1));
      yield* store.commitSummary({
        threadId: threadA,
        projectId: projectA,
        throughOrdinal: 1,
        observations: [{ type: "decision", title: "Use pnpm", body: "b", files: [] }],
        createdAt: t2,
      });
      yield* store.resetCursors;
      expect(yield* store.getCursor(threadA)).toBeNull();
      expect(yield* store.count).toBe(1);
    }).pipe(Effect.provide(layer)),
  );
});

describe("MemoryStore search", () => {
  const seed = Effect.gen(function* () {
    const store = yield* setup;
    yield* store.commitSummary({
      threadId: threadA,
      projectId: projectA,
      throughOrdinal: 1,
      observations: [
        {
          type: "decision",
          title: "依赖管理",
          body: "统一使用 pnpm 安装依赖",
          files: ["package.json"],
        },
      ],
      createdAt: t1,
    });
    yield* store.commitSummary({
      threadId: threadB,
      projectId: projectB,
      throughOrdinal: 1,
      observations: [
        { type: "bugfix", title: "Fix login", body: "Token expired early", files: [] },
      ],
      createdAt: t2,
    });
    return store;
  });

  it.effect("finds a Chinese observation by a phrase of three or more characters", () =>
    Effect.gen(function* () {
      const store = yield* seed;
      const found = yield* store.search({ query: "pnpm 安装", projectId: null, limit: 10 });
      expect(found.map((memory) => memory.title)).toEqual(["依赖管理"]);
      expect(found[0]?.files).toEqual(["package.json"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("finds a two-character Chinese query", () =>
    Effect.gen(function* () {
      const store = yield* seed;
      const found = yield* store.search({ query: "依赖", projectId: null, limit: 10 });
      expect(found.map((memory) => memory.title)).toEqual(["依赖管理"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("matches every word of a multi-word query, not the exact phrase", () =>
    Effect.gen(function* () {
      const store = yield* seed;
      const titles = (query: string) =>
        store
          .search({ query, projectId: null, limit: 10 })
          .pipe(Effect.map((found) => found.map((memory) => memory.title)));
      expect(yield* titles("early Token")).toEqual(["Fix login"]);
      expect(yield* titles("依赖 pnpm")).toEqual(["依赖管理"]);
      expect(yield* titles("Token pnpm")).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("filters by project", () =>
    Effect.gen(function* () {
      const store = yield* seed;
      expect(yield* store.search({ query: "Token", projectId: projectA, limit: 10 })).toEqual([]);
      expect((yield* store.search({ query: "Token", projectId: projectB, limit: 10 })).length).toBe(
        1,
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("recent returns newest first", () =>
    Effect.gen(function* () {
      const store = yield* seed;
      const found = yield* store.recent({ projectId: null, limit: 10 });
      expect(found.map((memory) => memory.title)).toEqual(["Fix login", "依赖管理"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("clear removes observations and cursors", () =>
    Effect.gen(function* () {
      const store = yield* seed;
      yield* store.recordRunEnded(ended(2));
      yield* store.clear;
      expect(yield* store.count).toBe(0);
      expect(yield* store.getCursor(threadA)).toBeNull();
      expect(yield* store.search({ query: "pnpm 安装", projectId: null, limit: 10 })).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );
});
