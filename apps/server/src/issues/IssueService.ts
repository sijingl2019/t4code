// @effect-diagnostics nodeBuiltinImport:off
/**
 * Issue tracker integration (adapters in issueTrackers.ts): listing tracker projects, listing/reading issues for bound T4 projects,
 * and the `#!auto` auto-development poller.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  hasAutoDevMarker,
  ISSUE_AUTO_DEV_MARKER,
  IssueTrackerError,
  MessageId,
  ProjectId,
  type Issue,
  type IssueFile,
  type IssueGetResult,
  type IssueTrackerCatalog,
  type IssueTestConnectionResult,
  type Project,
  type ServerSettings,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import { issueTrackerFor } from "./issueTrackers.ts";
import type { IssueTrackerClient } from "./IssueTrackerClient.ts";

const LIST_CACHE_MS = 60_000;
/** Per-file cap for attachments sent inline to the composer. */
const MAX_INLINE_FILE_BYTES = 8 * 1024 * 1024;

export class IssueService extends Context.Service<
  IssueService,
  {
    readonly list: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<Issue>, IssueTrackerError>;
    readonly get: (issueUuid: string) => Effect.Effect<IssueGetResult, IssueTrackerError>;
    readonly testConnection: Effect.Effect<IssueTestConnectionResult>;
    readonly catalog: Effect.Effect<IssueTrackerCatalog, IssueTrackerError>;
  }
>()("t3/issues/IssueService") {}

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const fail = (cause: unknown) => new IssueTrackerError({ message: errorMessage(cause) });

/** Comparable form of a local path (Windows paths are case-insensitive). */
function normalizeLocalPath(path: string, platform: NodeJS.Platform): string {
  const resolved = NodePath.resolve(path).replace(/[\\/]+$/, "");
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Prompt text for an issue. `auto` adds the no-commit rule and drops the marker. */
export function buildIssuePrompt(
  issue: Issue,
  options: { readonly auto: boolean; readonly attachmentPaths?: ReadonlyArray<string> },
): string {
  let description = issue.descriptionText.trim();
  if (options.auto && hasAutoDevMarker(description)) {
    description = description.slice(ISSUE_AUTO_DEV_MARKER.length).trim();
  }
  const lines = [`[${issue.key}] ${issue.title}`, `链接: ${issue.url}`];
  if (issue.status) lines.push(`状态: ${issue.status}`);
  lines.push("", "## 问题描述", description || "(无描述)");
  if (issue.comments.length > 0) {
    lines.push("", "## 评论");
    for (const comment of issue.comments) {
      lines.push(
        `- ${comment.author}${comment.createdAt ? ` (${comment.createdAt})` : ""}: ${comment.text}`,
      );
    }
  }
  if (options.attachmentPaths && options.attachmentPaths.length > 0) {
    lines.push(
      "",
      "## 附件（已下载到本地）",
      ...options.attachmentPaths.map((path) => `- ${path}`),
    );
  }
  if (options.auto) {
    lines.push(
      "",
      "## 约束",
      "- 这是自动开发任务：请根据以上问题信息直接完成开发与必要的验证。",
      "- 禁止执行任何提交操作：不要运行 git commit、git push、git tag、git merge、git rebase，也不要创建 PR。",
      "- 完成后总结改动的文件和验证结果，由开发者人工审查后再提交。",
    );
  }
  return lines.join("\n");
}

const safeFileName = (name: string) =>
  name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 120);

export const layer = Layer.effect(
  IssueService,
  Effect.gen(function* () {
    const settingsService = yield* ServerSettingsModule.ServerSettingsService;
    const projects = yield* ProjectService.ProjectService;
    const config = yield* ServerConfig.ServerConfig;
    const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
    const scheduler = yield* Scheduler.Scheduler;
    const platform = yield* HostProcess.Platform;

    // One client per connection so its login token is reused.
    let client: { key: string; value: IssueTrackerClient } | null = null;
    let listCache: { key: string; at: number; issues: Issue[] } | null = null;

    const readSettings = settingsService.getSettings.pipe(Effect.mapError(fail));

    const clientFor = (settings: ServerSettings) => {
      const adapter = issueTrackerFor(settings);
      const key = adapter.connectionKey(settings);
      if (client?.key !== key) {
        client = { key, value: adapter.create(settings) };
        listCache = null;
      }
      return client.value;
    };

    const listAll = Effect.fn("IssueService.listAll")(function* (
      settings: ServerSettings,
      fresh = false,
    ) {
      const ones = clientFor(settings);
      const filter = issueTrackerFor(settings).statusFilter(settings);
      const key = `${client!.key}|${filter.mode}:${filter.statusIds.join(",")}`;
      const now = yield* Clock.currentTimeMillis;
      if (!fresh && listCache?.key === key && now - listCache.at < LIST_CACHE_MS) {
        return listCache.issues;
      }
      const issues = yield* Effect.tryPromise({
        try: () => ones.listMyIssues(filter),
        catch: fail,
      });
      listCache = { key, at: now, issues };
      return issues;
    });

    const bindingsFor = (settings: ServerSettings, project: Project) => {
      const root = normalizeLocalPath(project.workspaceRoot, platform);
      return settings.issueProjectBindings.filter(
        (binding) => normalizeLocalPath(binding.localPath, platform) === root,
      );
    };

    const issuesForProject = (settings: ServerSettings, project: Project, fresh = false) => {
      const uuids = new Set(bindingsFor(settings, project).map((b) => b.onesProjectUuid));
      if (uuids.size === 0) return Effect.succeed([] as Issue[]);
      return listAll(settings, fresh).pipe(
        Effect.map((issues) => issues.filter((issue) => uuids.has(issue.trackerProjectId))),
      );
    };

    const list: IssueService["Service"]["list"] = Effect.fn("IssueService.list")(
      function* (projectId) {
        const settings = yield* readSettings;
        const project = yield* projects.getById(projectId).pipe(Effect.mapError(fail));
        if (Option.isNone(project)) return [];
        return yield* issuesForProject(settings, project.value);
      },
    );

    const get: IssueService["Service"]["get"] = Effect.fn("IssueService.get")(
      function* (issueUuid) {
        const settings = yield* readSettings;
        const ones = clientFor(settings);
        const issue = yield* Effect.tryPromise({
          try: () => ones.loadIssue(issueUuid),
          catch: fail,
        });
        const files: IssueFile[] = [];
        const skipped: string[] = [];
        for (const attachment of issue.attachments) {
          const downloaded = yield* Effect.tryPromise({
            try: () => ones.download(attachment.url),
            catch: fail,
          }).pipe(Effect.option);
          if (
            Option.isNone(downloaded) ||
            downloaded.value.bytes.byteLength > MAX_INLINE_FILE_BYTES
          ) {
            skipped.push(`${attachment.name}: ${attachment.url}`);
            continue;
          }
          files.push({
            name: attachment.name,
            mimeType: downloaded.value.mimeType,
            dataBase64: Buffer.from(downloaded.value.bytes).toString("base64"),
          });
        }
        let prompt = buildIssuePrompt(issue, { auto: false });
        if (skipped.length > 0)
          prompt += `\n\n## 其他附件\n${skipped.map((s) => `- ${s}`).join("\n")}`;
        return { issue, prompt, files };
      },
    );

    const testConnection: IssueService["Service"]["testConnection"] = readSettings.pipe(
      Effect.flatMap((settings) => {
        const ones = clientFor(settings);
        return Effect.tryPromise({ try: () => ones.testConnection(), catch: fail });
      }),
      Effect.match({
        onFailure: (error) => ({ ok: false, message: error.message }),
        onSuccess: (message) => ({ ok: true, message }),
      }),
    );

    const catalog: IssueService["Service"]["catalog"] = readSettings.pipe(
      Effect.flatMap((settings) => {
        const tracker = clientFor(settings);
        return Effect.tryPromise({
          try: async () => {
            const [projects, statuses] = await Promise.all([
              tracker.listProjects(),
              tracker.listStatuses(),
            ]);
            return { projects, statuses };
          },
          catch: fail,
        });
      }),
      Effect.withSpan("IssueService.catalog"),
    );

    let lastPollAt = 0;
    // Launch is idempotent per commandId; this only saves the repeat round trips.
    const launched = new Set<string>();

    const downloadForAuto = (ones: IssueTrackerClient, issue: Issue) =>
      Effect.tryPromise({
        try: async () => {
          const dir = NodePath.join(config.stateDir, "ones-attachments", issue.key);
          const paths: string[] = [];
          for (const [index, attachment] of issue.attachments.entries()) {
            try {
              const { bytes } = await ones.download(attachment.url);
              await NodeFSP.mkdir(dir, { recursive: true });
              const file = NodePath.join(dir, `${index + 1}-${safeFileName(attachment.name)}`);
              await NodeFSP.writeFile(file, bytes);
              paths.push(file);
            } catch {
              paths.push(`${attachment.name}（下载失败）: ${attachment.url}`);
            }
          }
          return paths;
        },
        catch: fail,
      });

    const launchAuto = Effect.fn("IssueService.launchAuto")(function* (
      settings: ServerSettings,
      project: Project,
      listed: Issue,
    ) {
      const modelSelection = project.defaultModelSelection ?? settings.defaultModelSelection;
      if (modelSelection === null) {
        yield* Effect.logWarning("ONES auto-dev skipped: no default model for project", {
          project: project.title,
          issue: listed.key,
        });
        return;
      }
      const issue = yield* Effect.tryPromise({
        try: () => clientFor(settings).loadIssue(listed.uuid, listed.status),
        catch: fail,
      });
      const attachmentPaths = yield* downloadForAuto(clientFor(settings), issue);
      yield* threadLaunch
        .launch({
          commandId: CommandId.make(`ones-auto:${issue.uuid}`),
          projectId: project.id,
          title: `[${issue.key}] ${issue.title}`.slice(0, 200),
          modelSelection,
          runtimeMode: settings.defaultRuntimeMode,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          workspaceStrategy:
            project.defaultThreadEnvMode === "worktree"
              ? { type: "worktree", baseRef: "HEAD" }
              : { type: "root" },
          initialMessage: {
            messageId: MessageId.make(`ones-auto-message:${issue.uuid}`),
            text: buildIssuePrompt(issue, { auto: true, attachmentPaths }),
            attachments: [],
          },
          createdBy: "system",
          creationSource: "server",
        })
        .pipe(Effect.mapError(fail));
      launched.add(issue.uuid);
      yield* Effect.logInfo("ONES auto-dev thread launched", { issue: issue.key });
    });

    const pollAutoDev = Effect.gen(function* () {
      const settings = yield* readSettings;
      const { enabled, intervalMinutes } = settings.issueAutoDev;
      if (!enabled || settings.issueProjectBindings.length === 0) return;
      const now = yield* Clock.currentTimeMillis;
      if (now - lastPollAt < intervalMinutes * 60_000) return;
      lastPollAt = now;
      const seen = new Set<string>();
      for (const binding of settings.issueProjectBindings) {
        const project = yield* projects
          .getByWorkspaceRoot(NodePath.resolve(binding.localPath))
          .pipe(Effect.mapError(fail));
        if (Option.isNone(project) || seen.has(project.value.id)) continue;
        seen.add(project.value.id);
        const issues = yield* issuesForProject(settings, project.value, true);
        for (const issue of issues) {
          if (launched.has(issue.uuid) || !hasAutoDevMarker(issue.descriptionText)) continue;
          yield* launchAuto(settings, project.value, issue).pipe(
            Effect.catch((error: IssueTrackerError) =>
              Effect.logWarning("ONES auto-dev launch failed", {
                issue: issue.key,
                error: error.message,
              }),
            ),
          );
        }
      }
    });

    yield* scheduler.register("ones-auto-dev", pollAutoDev);

    return IssueService.of({ list, get, testConnection, catalog });
  }),
);
