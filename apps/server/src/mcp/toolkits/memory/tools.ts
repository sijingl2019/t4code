import {
  IsoDateTime,
  MemoryObservationType,
  OrchestratorMcpFailure,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as MemoryService from "../../../memory/MemoryService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const scopeFields = {
  projectId: Schema.optional(ProjectId),
  allProjects: Schema.optional(Schema.Boolean),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
};

const MemoryResult = Schema.Struct({
  enabled: Schema.Boolean,
  memories: Schema.Array(
    Schema.Struct({
      type: MemoryObservationType,
      title: Schema.String,
      body: Schema.String,
      files: Schema.Array(Schema.String),
      projectId: ProjectId,
      threadId: ThreadId,
      link: Schema.String,
      createdAt: IsoDateTime,
    }),
  ),
});

const shared = {
  success: MemoryResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    MemoryService.MemoryService,
  ],
};

const MemorySearchTool = Tool.make("t4_memory_search", {
  ...shared,
  description:
    "Search memories distilled from past threads across providers: decisions, fixes, discoveries, preferences. Defaults to your project; `allProjects` searches all. Read the source with t3_thread_read.",
  parameters: Schema.Struct({ query: TrimmedNonEmptyString, ...scopeFields }),
})
  .annotate(Tool.Title, "Search memories")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const MemoryRecentTool = Tool.make("t4_memory_recent", {
  ...shared,
  description: "Newest memories from past threads, to catch up on a project.",
  parameters: Schema.Struct(scopeFields),
})
  .annotate(Tool.Title, "Recent memories")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const MemoryToolkit = Toolkit.make(MemorySearchTool, MemoryRecentTool);
