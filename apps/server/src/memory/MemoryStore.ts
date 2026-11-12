import {
  MemoryStoreError,
  type MemoryObservation,
  type MemoryObservationDraft,
  type MemoryObservationType,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export interface MemoryCursor {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  /** Highest run ordinal already summarized, inclusive. */
  readonly summarizedThrough: number;
  readonly latestOrdinal: number;
  readonly pendingCount: number;
  readonly oldestPendingAt: string | null;
}

export interface RunEnded {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly ordinal: number;
  readonly completedAt: string;
}

export interface SummaryCommit {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly throughOrdinal: number;
  readonly observations: ReadonlyArray<MemoryObservationDraft>;
  readonly createdAt: string;
}

export interface MemoryQuery {
  readonly query: string;
  readonly projectId: ProjectId | null;
  readonly limit: number;
}

type E<A> = Effect.Effect<A, MemoryStoreError>;

export class MemoryStore extends Context.Service<
  MemoryStore,
  {
    readonly ensureSchema: E<void>;
    readonly recordRunEnded: (input: RunEnded) => E<void>;
    readonly pendingCursors: E<ReadonlyArray<MemoryCursor>>;
    readonly getCursor: (threadId: ThreadId) => E<MemoryCursor | null>;
    readonly commitSummary: (input: SummaryCommit) => E<void>;
    readonly titlesForThread: (threadId: ThreadId, limit: number) => E<ReadonlyArray<string>>;
    readonly search: (input: MemoryQuery) => E<ReadonlyArray<MemoryObservation>>;
    readonly recent: (input: Omit<MemoryQuery, "query">) => E<ReadonlyArray<MemoryObservation>>;
    readonly count: E<number>;
    readonly clear: E<void>;
    readonly resetCursors: E<void>;
  }
>()("t3/memory/MemoryStore") {}

interface CursorRow {
  readonly thread_id: string;
  readonly project_id: string;
  readonly summarized_through: number;
  readonly latest_ordinal: number;
  readonly pending_count: number;
  readonly oldest_pending_at: string | null;
}

interface ObservationRow {
  readonly id: number;
  readonly project_id: string;
  readonly thread_id: string;
  readonly type: string;
  readonly title: string;
  readonly body: string;
  readonly files_json: string;
  readonly created_at: string;
}

const toCursor = (row: CursorRow): MemoryCursor => ({
  threadId: ThreadId.make(row.thread_id),
  projectId: ProjectId.make(row.project_id),
  summarizedThrough: row.summarized_through,
  latestOrdinal: row.latest_ordinal,
  pendingCount: row.pending_count,
  oldestPendingAt: row.oldest_pending_at,
});

const FilesJson = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeFiles = Schema.decodeUnknownOption(FilesJson);
const encodeFiles = Schema.encodeEffect(FilesJson);
const parseFiles = (json: string): ReadonlyArray<string> =>
  Option.getOrElse(decodeFiles(json), () => []);

const toObservation = (row: ObservationRow): MemoryObservation => ({
  id: row.id,
  projectId: ProjectId.make(row.project_id),
  threadId: ThreadId.make(row.thread_id),
  type: row.type as MemoryObservationType,
  title: row.title,
  body: row.body,
  files: parseFiles(row.files_json),
  createdAt: row.created_at,
});

// Trigram FTS needs three characters; shorter queries (common in Chinese) scan instead.
const FTS_MIN_QUERY_LENGTH = 3;
const ftsPhrase = (query: string) => `"${query.replaceAll('"', '""')}"`;
const likePattern = (query: string) => `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const ftsAvailable = yield* Ref.make(false);

  const fail = (operation: string) => (cause: unknown) =>
    new MemoryStoreError({ detail: `${operation}: ${String(cause)}` });

  const ensureSchema: E<void> = Effect.gen(function* () {
    yield* sql`
      CREATE TABLE IF NOT EXISTS t4_memory_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        files_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `;
    yield* sql`
      CREATE INDEX IF NOT EXISTS t4_memory_observations_project
      ON t4_memory_observations (project_id, created_at)
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS t4_memory_cursors (
        thread_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        summarized_through INTEGER NOT NULL,
        latest_ordinal INTEGER NOT NULL,
        pending_count INTEGER NOT NULL,
        oldest_pending_at TEXT
      )
    `;
    // Older system SQLite builds may lack trigram; search then scans with LIKE.
    const created = yield* sql`
      CREATE VIRTUAL TABLE IF NOT EXISTS t4_memory_search
      USING fts5(title, body, tokenize = 'trigram')
    `.pipe(
      Effect.as(true),
      Effect.catchIf(
        (cause) =>
          Predicate.hasProperty(cause.reason.cause, "errcode") && cause.reason.cause.errcode === 1,
        (cause) =>
          Effect.logWarning("Memory search index unavailable; search will scan.", cause).pipe(
            Effect.as(false),
          ),
      ),
    );
    yield* Ref.set(ftsAvailable, created);
  }).pipe(Effect.mapError(fail("ensureSchema")));

  const getCursor = (threadId: ThreadId): E<MemoryCursor | null> =>
    sql<CursorRow>`SELECT * FROM t4_memory_cursors WHERE thread_id = ${threadId}`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? null : toCursor(rows[0]))),
      Effect.mapError(fail("getCursor")),
    );

  const recordRunEnded = (input: RunEnded): E<void> =>
    sql`
      INSERT INTO t4_memory_cursors (
        thread_id, project_id, summarized_through, latest_ordinal, pending_count, oldest_pending_at
      )
      VALUES (
        ${input.threadId}, ${input.projectId}, ${input.ordinal - 1}, ${input.ordinal}, 1,
        ${input.completedAt}
      )
      ON CONFLICT (thread_id) DO UPDATE SET
        latest_ordinal = MAX(latest_ordinal, excluded.latest_ordinal),
        pending_count = pending_count + (excluded.latest_ordinal > t4_memory_cursors.latest_ordinal),
        oldest_pending_at = COALESCE(oldest_pending_at, excluded.oldest_pending_at)
      WHERE excluded.latest_ordinal > t4_memory_cursors.summarized_through
    `.pipe(Effect.asVoid, Effect.mapError(fail("recordRunEnded")));

  const commitSummary = Effect.fn("MemoryStore.commitSummary")(
    function* (input: SummaryCommit) {
      const fts = yield* Ref.get(ftsAvailable);
      for (const observation of input.observations) {
        const rows = yield* sql<{ readonly id: number }>`
          INSERT INTO t4_memory_observations (
            project_id, thread_id, type, title, body, files_json, created_at
          )
          VALUES (
            ${input.projectId}, ${input.threadId}, ${observation.type}, ${observation.title},
            ${observation.body}, ${yield* encodeFiles(observation.files)}, ${input.createdAt}
          )
          RETURNING id
        `;
        const id = rows[0]?.id;
        if (fts && id !== undefined) {
          yield* sql`
            INSERT INTO t4_memory_search (rowid, title, body)
            VALUES (${id}, ${observation.title}, ${observation.body})
          `;
        }
      }
      // ponytail: oldest_pending_at for leftover runs becomes the commit time, not their real end time.
      yield* sql`
        UPDATE t4_memory_cursors SET
          summarized_through = ${input.throughOrdinal},
          pending_count = MAX(latest_ordinal - ${input.throughOrdinal}, 0),
          oldest_pending_at = CASE
            WHEN latest_ordinal > ${input.throughOrdinal} THEN ${input.createdAt}
            ELSE NULL
          END
        WHERE thread_id = ${input.threadId}
      `;
    },
    sql.withTransaction,
    Effect.mapError(fail("commitSummary")),
  );

  const search = Effect.fn("MemoryStore.search")(
    function* (input: MemoryQuery) {
      // Every word must match somewhere, so natural multi-word queries still find memories.
      const words = input.query.split(/\s+/).filter((word) => word.length > 0);
      if (words.length === 0) return [];
      const projectFilter =
        input.projectId === null ? sql`1 = 1` : sql`o.project_id = ${input.projectId}`;
      const useFts =
        (yield* Ref.get(ftsAvailable)) &&
        words.every((word) => word.length >= FTS_MIN_QUERY_LENGTH);
      const rows = useFts
        ? yield* sql<ObservationRow>`
            SELECT o.* FROM t4_memory_search s
            JOIN t4_memory_observations o ON o.id = s.rowid
            WHERE t4_memory_search MATCH ${words.map(ftsPhrase).join(" ")} AND ${projectFilter}
            ORDER BY s.rank
            LIMIT ${input.limit}
          `
        : yield* sql<ObservationRow>`
            SELECT o.* FROM t4_memory_observations o
            WHERE ${sql.and(
              words.map(
                (word) =>
                  sql`(o.title LIKE ${likePattern(word)} ESCAPE '\\' OR o.body LIKE ${likePattern(word)} ESCAPE '\\')`,
              ),
            )}
              AND ${projectFilter}
            ORDER BY o.created_at DESC, o.id DESC
            LIMIT ${input.limit}
          `;
      return rows.map(toObservation);
    },
    Effect.mapError(fail("search")),
  );

  const recent = (input: Omit<MemoryQuery, "query">): E<ReadonlyArray<MemoryObservation>> =>
    (input.projectId === null
      ? sql<ObservationRow>`
          SELECT * FROM t4_memory_observations
          ORDER BY created_at DESC, id DESC LIMIT ${input.limit}
        `
      : sql<ObservationRow>`
          SELECT * FROM t4_memory_observations WHERE project_id = ${input.projectId}
          ORDER BY created_at DESC, id DESC LIMIT ${input.limit}
        `
    ).pipe(
      Effect.map((rows) => rows.map(toObservation)),
      Effect.mapError(fail("recent")),
    );

  return MemoryStore.of({
    ensureSchema,
    recordRunEnded,
    getCursor,
    commitSummary,
    search,
    recent,
    pendingCursors: sql<CursorRow>`
      SELECT * FROM t4_memory_cursors WHERE pending_count > 0
    `.pipe(
      Effect.map((rows) => rows.map(toCursor)),
      Effect.mapError(fail("pendingCursors")),
    ),
    titlesForThread: Effect.fn("MemoryStore.titlesForThread")((threadId, limit) =>
      sql<{ readonly title: string }>`
        SELECT title FROM t4_memory_observations WHERE thread_id = ${threadId}
        ORDER BY id DESC LIMIT ${limit}
      `.pipe(
        Effect.map((rows) => rows.map((row) => row.title)),
        Effect.mapError(fail("titlesForThread")),
      ),
    ),
    count: sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM t4_memory_observations
    `.pipe(
      Effect.map((rows) => rows[0]?.count ?? 0),
      Effect.mapError(fail("count")),
    ),
    clear: Effect.gen(function* () {
      yield* sql`DELETE FROM t4_memory_observations`;
      yield* sql`DELETE FROM t4_memory_cursors`;
      if (yield* Ref.get(ftsAvailable)) yield* sql`DELETE FROM t4_memory_search`;
    }).pipe(sql.withTransaction, Effect.mapError(fail("clear"))),
    resetCursors: sql`DELETE FROM t4_memory_cursors`.pipe(
      Effect.asVoid,
      Effect.mapError(fail("resetCursors")),
    ),
  });
});

export const layer = Layer.effect(MemoryStore, make);
