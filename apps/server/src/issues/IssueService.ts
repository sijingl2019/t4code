// @effect-diagnostics nodeBuiltinImport:off
/**
 * Issue tracker integration (adapters in issueTrackers.ts): listing tracker projects, listing/reading issues for bound T4 projects,
 * and the `#!t4code` auto-development poller.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  hasAutoDevMarker,
  ISSUE_AUTO_DEV_MARKER,
  issueTrackersOf,
  IssueTrackerError,
  LEGACY_ISSUE_TRACKER_ID,
  MessageId,
  ProjectId,
  type IssueBoard,
  type IssueBoardProject,
  type IssueBoardRow,
  type Issue,
  type IssueFile,
  type IssueGetResult,
  type IssueTrackerCatalog,
  type IssueTrackerConnection,
  type IssueTestConnectionResult,
  type IssueTrackerStatus,
  type OrchestrationV2DomainEvent,
  type Project,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as GitManager from "../git/GitManager.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import { connectionKey, effectiveStatusFilter, issueTrackerAdapter } from "./issueTrackers.ts";
import { autoDevCommitMessage } from "./issueCommitMessage.ts";
import type { IssueTrackerClient } from "./IssueTrackerClient.ts";

const LIST_CACHE_MS = 60_000;
/** Per-file cap for attachments sent inline to the composer. */
const MAX_INLINE_FILE_BYTES = 8 * 1024 * 1024;

export class IssueService extends Context.Service<
  IssueService,
  {
    readonly list: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<Issue>, IssueTrackerError>;
    readonly get: (
      issueUuid: string,
      trackerId?: string,
    ) => Effect.Effect<IssueGetResult, IssueTrackerError>;
    readonly testConnection: (trackerId?: string) => Effect.Effect<IssueTestConnectionResult>;
    readonly catalog: (trackerId?: string) => Effect.Effect<IssueTrackerCatalog, IssueTrackerError>;
    /** The user's issues in bound tracker projects, with the thread started for each. */
    readonly board: () => Effect.Effect<IssueBoard, IssueTrackerError>;
    /** Starts the issue's auto-dev thread in the project (idempotent per issue). */
    readonly execute: (
      trackerId: string,
      issueUuid: string,
      projectId: ProjectId,
    ) => Effect.Effect<ThreadId, IssueTrackerError>;
    /** False when the issue's workflow has no transition to `statusId`. */
    readonly setStatus: (
      trackerId: string,
      issueUuid: string,
      statusId: string,
    ) => Effect.Effect<boolean, IssueTrackerError>;
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
      "- 完成后总结改动的文件和验证结果；系统会用工单号、标题和这段总结自动提交并推送。",
    );
  }
  return lines.join("\n");
}

/** Due once per interval, and on the next tick after the ONES or auto-dev settings change. */
export const autoDevPollDue = (
  last: { readonly at: number; readonly key: string } | null,
  key: string,
  intervalMinutes: number,
  now: number,
) => last === null || last.key !== key || now - last.at >= intervalMinutes * 60_000;

const AUTO_MESSAGE_PREFIX = "ones-auto-message:";

/** Auto-dev id of an issue; the legacy tracker keeps the bare uuid so launched issues stay launched. */
export const autoDevKey = (trackerId: string, issueUuid: string) =>
  trackerId === LEGACY_ISSUE_TRACKER_ID ? issueUuid : `${trackerId}/${issueUuid}`;

/** The issue an auto-dev thread was launched for, read from its first message id. */
export const autoDevIssueRef = (
  firstMessageId: string | undefined,
): { readonly trackerId: string; readonly issueUuid: string } | null => {
  if (firstMessageId?.startsWith(AUTO_MESSAGE_PREFIX) !== true) return null;
  const key = firstMessageId.slice(AUTO_MESSAGE_PREFIX.length);
  const slash = key.indexOf("/");
  const ref =
    slash === -1
      ? { trackerId: LEGACY_ISSUE_TRACKER_ID, issueUuid: key }
      : { trackerId: key.slice(0, slash), issueUuid: key.slice(slash + 1) };
  return ref.trackerId === "" || ref.issueUuid === "" ? null : ref;
};

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
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const git = yield* GitManager.GitManager;
    const sql = yield* SqlClient.SqlClient;

    // One client per tracker connection so its login token is reused.
    const clients = new Map<string, { key: string; value: IssueTrackerClient }>();
    const listCaches = new Map<string, { key: string; at: number; issues: Issue[] }>();

    const readSettings = settingsService.getSettings.pipe(Effect.mapError(fail));

    const trackerFor = (settings: ServerSettings, trackerId: string | undefined) => {
      const trackers = issueTrackersOf(settings);
      const tracker =
        trackerId === undefined ? trackers[0] : trackers.find((t) => t.id === trackerId);
      if (tracker) return Effect.succeed(tracker);
      return Effect.fail(
        fail(trackerId ? `Unknown issue tracker: ${trackerId}` : "No issue tracker configured."),
      );
    };

    const clientFor = Effect.fn("IssueService.clientFor")(function* (
      tracker: IssueTrackerConnection,
    ) {
      const adapter = issueTrackerAdapter(tracker.kind);
      if (!adapter) {
        return yield* fail(`${tracker.kind} issue trackers are not supported yet.`);
      }
      const key = connectionKey(tracker);
      let client = clients.get(tracker.id);
      if (client?.key !== key) {
        client = { key, value: adapter.create(tracker) };
        clients.set(tracker.id, client);
        listCaches.delete(tracker.id);
      }
      return client.value;
    });

    const listAll = Effect.fn("IssueService.listAll")(function* (
      tracker: IssueTrackerConnection,
      fresh = false,
    ) {
      const client = yield* clientFor(tracker);
      const filter = effectiveStatusFilter(tracker);
      const key = `${connectionKey(tracker)}|${filter.mode}:${filter.statusIds.join(",")}`;
      const now = yield* Clock.currentTimeMillis;
      const cached = listCaches.get(tracker.id);
      if (!fresh && cached?.key === key && now - cached.at < LIST_CACHE_MS) return cached.issues;
      const listed = yield* Effect.tryPromise({
        try: () => client.listMyIssues(filter),
        catch: fail,
      });
      const issues = listed.map((issue) => ({ ...issue, trackerId: tracker.id }));
      listCaches.set(tracker.id, { key, at: now, issues });
      return issues;
    });

    const bindingsFor = (settings: ServerSettings, project: Project) => {
      const root = normalizeLocalPath(project.workspaceRoot, platform);
      return settings.issueProjectBindings.filter(
        (binding) => normalizeLocalPath(binding.localPath, platform) === root,
      );
    };

    /** Issues from every supported tracker bound to the project; unsupported kinds are skipped. */
    const issuesForProject = Effect.fn("IssueService.issuesForProject")(function* (
      settings: ServerSettings,
      project: Project,
      fresh = false,
    ) {
      const bindings = bindingsFor(settings, project);
      const result: Issue[] = [];
      for (const tracker of issueTrackersOf(settings)) {
        if (!issueTrackerAdapter(tracker.kind)) continue;
        const ids = new Set(
          bindings.filter((b) => b.trackerId === tracker.id).map((b) => b.onesProjectUuid),
        );
        if (ids.size === 0) continue;
        const issues = yield* listAll(tracker, fresh);
        result.push(...issues.filter((issue) => ids.has(issue.trackerProjectId)));
      }
      return result;
    });

    const list: IssueService["Service"]["list"] = Effect.fn("IssueService.list")(
      function* (projectId) {
        const settings = yield* readSettings;
        const project = yield* projects.getById(projectId).pipe(Effect.mapError(fail));
        if (Option.isNone(project)) return [];
        return yield* issuesForProject(settings, project.value);
      },
    );

    const get: IssueService["Service"]["get"] = Effect.fn("IssueService.get")(
      function* (issueUuid, trackerId) {
        const settings = yield* readSettings;
        const tracker = yield* trackerFor(settings, trackerId);
        const ones = yield* clientFor(tracker);
        const loaded = yield* Effect.tryPromise({
          try: () => ones.loadIssue(issueUuid),
          catch: fail,
        });
        const issue: Issue = { ...loaded, trackerId: tracker.id };
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

    const clientById = (trackerId: string | undefined) =>
      readSettings.pipe(
        Effect.flatMap((settings) => trackerFor(settings, trackerId)),
        Effect.flatMap(clientFor),
      );

    const testConnection: IssueService["Service"]["testConnection"] = (trackerId) =>
      clientById(trackerId).pipe(
        Effect.flatMap((client) =>
          Effect.tryPromise({ try: () => client.testConnection(), catch: fail }),
        ),
        Effect.match({
          onFailure: (error) => ({ ok: false, message: error.message }),
          onSuccess: (message) => ({ ok: true, message }),
        }),
        Effect.withSpan("IssueService.testConnection"),
      );

    const catalog: IssueService["Service"]["catalog"] = (trackerId) =>
      clientById(trackerId).pipe(
        Effect.flatMap((client) =>
          Effect.tryPromise({
            try: async () => {
              const [projects, statuses] = await Promise.all([
                client.listProjects(),
                client.listStatuses(),
              ]);
              return { projects, statuses, lastAutoDevPollAt: lastPoll?.at ?? null };
            },
            catch: fail,
          }),
        ),
        Effect.withSpan("IssueService.catalog"),
      );

    /** Auto-dev / board thread per `autoDevKey`, newest first wins. */
    const issueThreads = Effect.gen(function* () {
      // A range on the primary key; the prefix ends in ':' and ';' sorts right after it.
      const rows = yield* sql<{ readonly threadId: ThreadId; readonly messageId: string }>`
        SELECT m.thread_id AS threadId, m.message_id AS messageId
        FROM orchestration_v2_projection_messages m
        JOIN orchestration_v2_projection_threads t ON t.thread_id = m.thread_id
        WHERE m.message_id >= ${AUTO_MESSAGE_PREFIX}
          AND m.message_id < ${`${AUTO_MESSAGE_PREFIX.slice(0, -1)};`}
          AND t.deleted_at IS NULL
        ORDER BY t.created_at DESC
      `.pipe(Effect.mapError(fail));
      const byKey = new Map<string, ThreadId>();
      for (const row of rows) {
        const ref = autoDevIssueRef(row.messageId);
        const key = ref && autoDevKey(ref.trackerId, ref.issueUuid);
        if (key && !byKey.has(key)) byKey.set(key, row.threadId);
      }
      return byKey;
    });

    const board: IssueService["Service"]["board"] = Effect.fn("IssueService.board")(function* () {
      const settings = yield* readSettings;
      const boundProjects = new Map<string, IssueBoardProject[]>();
      for (const binding of settings.issueProjectBindings) {
        const project = yield* projects
          .getByWorkspaceRoot(NodePath.resolve(binding.localPath))
          .pipe(Effect.mapError(fail));
        if (Option.isNone(project)) continue;
        const key = `${binding.trackerId}/${binding.onesProjectUuid}`;
        const list = boundProjects.get(key) ?? [];
        if (!list.some((p) => p.id === project.value.id)) {
          list.push({ id: project.value.id, name: project.value.title });
        }
        boundProjects.set(key, list);
      }
      const threads = yield* issueThreads;
      const rows: IssueBoardRow[] = [];
      const statuses: Record<string, ReadonlyArray<IssueTrackerStatus>> = {};
      const errors: string[] = [];
      for (const tracker of issueTrackersOf(settings)) {
        if (!issueTrackerAdapter(tracker.kind)) continue;
        if (!settings.issueProjectBindings.some((b) => b.trackerId === tracker.id)) continue;
        const loaded = yield* Effect.gen(function* () {
          const client = yield* clientFor(tracker);
          const issues = yield* listAll(tracker, true);
          const [trackerProjects, trackerStatuses] = yield* Effect.tryPromise({
            try: () => Promise.all([client.listProjects(), client.listStatuses()]),
            catch: fail,
          });
          return { issues, trackerProjects, trackerStatuses };
        }).pipe(
          Effect.catch((error: IssueTrackerError) =>
            Effect.sync(() => {
              errors.push(`${tracker.name || tracker.kind}: ${error.message}`);
              return null;
            }),
          ),
        );
        if (loaded === null) continue;
        statuses[tracker.id] = loaded.trackerStatuses;
        const projectNames = new Map(loaded.trackerProjects.map((p) => [p.id, p.name]));
        for (const issue of loaded.issues) {
          const bound = boundProjects.get(`${tracker.id}/${issue.trackerProjectId}`);
          if (!bound) continue;
          rows.push({
            issue,
            trackerProjectName: projectNames.get(issue.trackerProjectId) ?? "",
            projects: bound,
            threadId: threads.get(autoDevKey(tracker.id, issue.uuid)) ?? null,
          });
        }
      }
      return { rows, statuses, errors };
    });

    const execute: IssueService["Service"]["execute"] = Effect.fn("IssueService.execute")(
      function* (trackerId, issueUuid, projectId) {
        const settings = yield* readSettings;
        const project = yield* projects.getById(projectId).pipe(Effect.mapError(fail));
        if (Option.isNone(project)) return yield* fail(`Unknown project: ${projectId}`);
        return yield* launchAuto(settings, project.value, { trackerId, uuid: issueUuid });
      },
    );

    const setStatus: IssueService["Service"]["setStatus"] = (trackerId, issueUuid, statusId) =>
      clientById(trackerId).pipe(
        Effect.flatMap((client) =>
          Effect.tryPromise({ try: () => client.moveToStatus(issueUuid, statusId), catch: fail }),
        ),
        Effect.tap(() => Effect.sync(() => listCaches.delete(trackerId))),
        Effect.withSpan("IssueService.setStatus"),
      );

    let lastPoll: { at: number; key: string } | null = null;
    // Launch is idempotent per commandId; this only saves the repeat round trips.
    const launched = new Set<string>();

    const downloadForAuto = (ones: IssueTrackerClient, issue: Pick<Issue, "key" | "attachments">) =>
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
      listed: Pick<Issue, "trackerId" | "uuid"> & { readonly status?: string },
    ) {
      // Settings → Project defaults live in project overrides, not on the project row.
      const modelSelection = resolveProjectSettings(settings, project.id, project).settings
        .defaultModelSelection;
      if (modelSelection === null) {
        return yield* fail(`No default model set for project ${project.title}.`);
      }
      const tracker = yield* trackerFor(settings, listed.trackerId);
      const client = yield* clientFor(tracker);
      const loaded = yield* Effect.tryPromise({
        try: () => client.loadIssue(listed.uuid, listed.status),
        catch: fail,
      });
      const issue: Issue = { ...loaded, trackerId: tracker.id };
      const attachmentPaths = yield* downloadForAuto(client, issue);
      const key = autoDevKey(tracker.id, issue.uuid);
      const result = yield* threadLaunch
        .launch({
          commandId: CommandId.make(`ones-auto:${key}`),
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
            messageId: MessageId.make(`${AUTO_MESSAGE_PREFIX}${key}`),
            text: buildIssuePrompt(issue, { auto: true, attachmentPaths }),
            attachments: [],
          },
          createdBy: "system",
          creationSource: "server",
        })
        .pipe(Effect.mapError(fail));
      launched.add(key);
      yield* Effect.logInfo("ONES auto-dev thread launched", { issue: issue.key });
      return result.threadId;
    });

    const pollAutoDev = Effect.gen(function* () {
      const settings = yield* readSettings;
      const { enabled, intervalMinutes } = settings.issueAutoDev;
      if (!enabled || settings.issueProjectBindings.length === 0) {
        lastPoll = null;
        return;
      }
      const now = yield* Clock.currentTimeMillis;
      const key = [
        intervalMinutes,
        ...issueTrackersOf(settings).map(
          (t) => `${t.id}=${connectionKey(t)}:${t.statusFilter.mode}:${t.statusFilter.statusIds}`,
        ),
        ...settings.issueProjectBindings.map(
          (b) => `${b.trackerId}/${b.onesProjectUuid}@${b.localPath}`,
        ),
      ].join("|");
      if (!autoDevPollDue(lastPoll, key, intervalMinutes, now)) return;
      lastPoll = { at: now, key };
      const seen = new Set<string>();
      for (const binding of settings.issueProjectBindings) {
        const project = yield* projects
          .getByWorkspaceRoot(NodePath.resolve(binding.localPath))
          .pipe(Effect.mapError(fail));
        if (Option.isNone(project) || seen.has(project.value.id)) continue;
        seen.add(project.value.id);
        const issues = yield* issuesForProject(settings, project.value, true);
        for (const issue of issues) {
          if (launched.has(autoDevKey(issue.trackerId, issue.uuid))) continue;
          if (!hasAutoDevMarker(issue.descriptionText)) continue;
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

    /** Commits and pushes the thread's changes as `<key> <title>` with the run summary as body. */
    const commitAndPush = Effect.fn("IssueService.commitAndPush")(function* (
      threadId: ThreadId,
      runId: string,
      client: IssueTrackerClient,
      issueUuid: string,
      summary: string,
    ) {
      const shell = yield* projections.getThreadShell(threadId);
      if (shell === null) return;
      const project = yield* projects.getById(shell.projectId).pipe(Effect.mapError(fail));
      const cwd = shell.worktreePath ?? Option.getOrUndefined(project)?.workspaceRoot;
      if (cwd === undefined) return;
      const issue = yield* Effect.tryPromise({
        try: () => client.loadIssue(issueUuid),
        catch: fail,
      });
      const result = yield* git.runStackedAction({
        actionId: `issue-auto-commit:${runId}`,
        cwd,
        action: "commit_push",
        commitMessage: autoDevCommitMessage(issue, summary),
        threadId,
        projectId: shell.projectId,
      });
      yield* Effect.logInfo("Issue auto-dev commit", {
        issue: issue.key,
        commit: result.commit.status,
        sha: result.commit.commitSha,
        push: result.push.status,
      });
    });

    // A run can report "completed" more than once; post each run's summary once per process.
    const commented = new Set<string>();
    const commentRunSummary = Effect.fn("IssueService.commentRunSummary")(
      function* (event: OrchestrationV2DomainEvent) {
        if (event.type !== "run.updated") return;
        const run = event.payload;
        if (run.status !== "completed" || run.delegatedTaskId !== undefined) return;
        if (commented.has(run.id)) return;
        const settings = yield* readSettings;
        if (!settings.issueAutoDev.enabled) return;
        const { runs } = yield* projections.getThreadRecords(event.threadId, ["runs"]);
        const firstRun = runs.reduce<(typeof runs)[number] | undefined>(
          (first, r) => (first === undefined || r.ordinal < first.ordinal ? r : first),
          undefined,
        );
        const ref = autoDevIssueRef(firstRun?.userMessageId);
        if (ref === null) return;
        const { messages } = yield* projections.getThreadRecords(event.threadId, ["messages"], {
          messageRoles: ["assistant"],
          messageRunIds: [run.id],
        });
        const summary = messages.findLast((m) => !m.streaming)?.text.trim() ?? "";
        if (summary === "") return;
        commented.add(run.id);
        const { tracker, client } = yield* Effect.gen(function* () {
          const tracker = yield* trackerFor(settings, ref.trackerId);
          const client = yield* clientFor(tracker);
          yield* Effect.tryPromise({
            try: () => client.addComment(ref.issueUuid, summary),
            catch: fail,
          });
          return { tracker, client };
        }).pipe(Effect.onError(() => Effect.sync(() => commented.delete(run.id))));
        yield* Effect.logInfo("Issue auto-dev summary posted", { ...ref, runId: run.id });
        yield* commitAndPush(event.threadId, run.id, client, ref.issueUuid, summary).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Issue auto-dev commit failed", { ...ref, cause }),
          ),
        );
        const overrides = tracker.projectDoneStatusIds;
        const doneStatusId =
          Object.keys(overrides).length === 0
            ? tracker.doneStatusId
            : ((yield* Effect.tryPromise({
                try: async () =>
                  overrides[(await client.loadIssue(ref.issueUuid)).trackerProjectId],
                catch: fail,
              })) ?? tracker.doneStatusId);
        if (doneStatusId === "") return;
        // Later runs find no transition once the issue is there, so this moves it once.
        const moved = yield* Effect.tryPromise({
          try: () => client.moveToStatus(ref.issueUuid, doneStatusId),
          catch: fail,
        });
        yield* Effect.logInfo(
          moved
            ? "Issue auto-dev status updated"
            : "Issue auto-dev status unchanged (no transition)",
          { ...ref, statusId: doneStatusId },
        );
      },
      Effect.catchCause((cause) => Effect.logWarning("ONES auto-dev comment failed", { cause })),
    );
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, commentRunSummary).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("ONES auto-dev event stream failed", { cause }),
        ),
      ),
    );

    return IssueService.of({
      list,
      get,
      testConnection,
      catalog,
      board,
      execute,
      setStatus,
    });
  }),
);
