import type { MemoryObservation, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as MemoryService from "../../../memory/MemoryService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller, unavailable } from "../../threadAccess.ts";
import { MemoryToolkit } from "./tools.ts";

const DEFAULT_LIMIT = 10;

/** `allProjects`, else the named project, else the caller's, else every project. */
const resolveScope = Effect.fn("mcp.memory.resolveScope")(function* (input: {
  readonly projectId?: ProjectId | undefined;
  readonly allProjects?: boolean | undefined;
}) {
  if (input.allProjects === true) return null;
  if (input.projectId !== undefined) return input.projectId;
  const { caller } = yield* loadCaller();
  return caller?.projectId ?? null;
});

const withLinks = Effect.fn("mcp.memory.withLinks")(function* (result: {
  readonly enabled: boolean;
  readonly memories: ReadonlyArray<MemoryObservation>;
}) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  return {
    enabled: result.enabled,
    memories: result.memories.map((memory) => ({
      type: memory.type,
      title: memory.title,
      body: memory.body,
      files: memory.files,
      projectId: memory.projectId,
      threadId: memory.threadId,
      link: McpInvocationContext.threadLinkFor(scope, memory.threadId),
      createdAt: memory.createdAt,
    })),
  };
});

export const layer = McpToolAccess.toLayer(MemoryToolkit, {
  t4_memory_search: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const memory = yield* MemoryService.MemoryService;
      const projectId = yield* resolveScope(input);
      const result = yield* memory
        .search({ query: input.query, projectId, limit: input.limit ?? DEFAULT_LIMIT })
        .pipe(Effect.mapError(unavailable));
      return yield* withLinks(result);
    }),
  ),
  t4_memory_recent: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const memory = yield* MemoryService.MemoryService;
      const projectId = yield* resolveScope(input);
      const result = yield* memory
        .recent({ projectId, limit: input.limit ?? DEFAULT_LIMIT })
        .pipe(Effect.mapError(unavailable));
      return yield* withLinks(result);
    }),
  ),
});
