// @effect-diagnostics nodeBuiltinImport:off
/**
 * ONES issue integration: listing/reading issues for bound projects, keeping bound checkouts
 * present as projects, and the `#!auto` auto-development poller.
 */
import { spawn } from "node:child_process";
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  hasAutoDevMarker,
  ISSUE_AUTO_DEV_MARKER,
  IssueTrackerError,
  MessageId,
  ProjectId,
  settingsSecretLiteral,
  type Issue,
  type IssueFile,
  type IssueGetResult,
  type IssueProjectBinding,
  type IssueSyncBindingsResult,
  type IssueTestConnectionResult,
  type Project,
  type ProjectCloneStartInput,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import { OnesClient, type OnesConnection } from "./OnesClient.ts";

const LIST_CACHE_MS = 60_000;
/** Per-file cap for attachments sent inline to the composer. */
const MAX_INLINE_FILE_BYTES = 8 * 1024 * 1024;

export class IssueService extends Context.Service<
  IssueService,
  {
    readonly list: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<Issue>, IssueTrackerError>;
    readonly get: (issueUuid: string) => Effect.Effect<IssueGetResult, IssueTrackerError>;
    readonly testConnection: Effect.Effect<IssueTestConnectionResult>;
    /** `startClone` is the server's clone flow, which also creates the project. */
    readonly syncBindings: <E>(
      startClone: (input: ProjectCloneStartInput) => Effect.Effect<unknown, E>,
    ) => Effect.Effect<IssueSyncBindingsResult>;
  }
>()("t4/issues/IssueService") {}

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const fail = (cause: unknown) => new IssueTrackerError({ message: errorMessage(cause) });

/** Comparable form of a local path (Windows paths are case-insensitive). */
export function normalizeLocalPath(path: string): string {
  const resolved = NodePath.resolve(path).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
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
      lines.push(`- ${comment.author}${comment.createdAt ? ` (${comment.createdAt})` : ""}: ${comment.text}`);
    }
  }
  if (options.attachmentPaths && options.attachmentPaths.length > 0) {
    lines.push("", "## 附件（已下载到本地）", ...options.attachmentPaths.map((path) => `- ${path}`));
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

function onesConnection(settings: ServerSettings): OnesConnection {
  return {
    baseUrl: settings.ones.baseUrl,
    teamUuid: settings.ones.teamUuid,
    email: settings.ones.email,
    // ponytail: secret-provider references (1Password, …) are not resolved here; literals only.
    password: settingsSecretLiteral(settings.ones.password),
  };
}

/** Stores HTTPS credentials in git's credential helper so clones and later pulls can use them. */
function approveGitCredentials(repoUrl: string, username: string, token: string): Promise<void> {
  const url = new URL(repoUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["credential", "approve"], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`git credential approve failed: ${stderr.trim()}`)),
    );
    child.stdin.end(
      `protocol=${url.protocol.slice(0, -1)}\nhost=${url.host}\nusername=${username}\npassword=${token}\n\n`,
    );
  });
}

const pathExists = (path: string) =>
  NodeFs.stat(path).then(
    () => true,
    () => false,
  );

const safeFileName = (name: string) => name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 120);

export const layer = Layer.effect(
  IssueService,
  Effect.gen(function* () {
    const settingsService = yield* ServerSettingsModule.ServerSettingsService;
    const projects = yield* ProjectService.ProjectService;
    const config = yield* ServerConfig.ServerConfig;
    const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
    const scheduler = yield* Scheduler.Scheduler;

    // One client per connection so its login token is reused.
    let client: { key: string; value: OnesClient } | null = null;
    let listCache: { key: string; at: number; issues: Issue[] } | null = null;

    const readSettings = settingsService.getSettings.pipe(Effect.mapError(fail));

    const clientFor = (settings: ServerSettings) => {
      const connection = onesConnection(settings);
      const key = JSON.stringify(connection);
      if (client?.key !== key) {
        client = { key, value: new OnesClient(connection) };
        listCache = null;
      }
      return client.value;
    };

    const listAll = (settings: ServerSettings, fresh = false) =>
      Effect.tryPromise({
        try: async () => {
          const ones = clientFor(settings);
          const key = client!.key;
          if (!fresh && listCache?.key === key && Date.now() - listCache.at < LIST_CACHE_MS) {
            return listCache.issues;
          }
          const issues = await ones.listMyOpenIssues();
          listCache = { key, at: Date.now(), issues };
          return issues;
        },
        catch: fail,
      });

    const bindingsFor = (settings: ServerSettings, project: Project) => {
      const root = normalizeLocalPath(project.workspaceRoot);
      return settings.issueProjectBindings.filter(
        (binding) => normalizeLocalPath(binding.localPath) === root,
      );
    };

    const issuesForProject = (settings: ServerSettings, project: Project, fresh = false) => {
      const uuids = new Set(bindingsFor(settings, project).map((b) => b.onesProjectUuid));
      if (uuids.size === 0) return Effect.succeed([] as Issue[]);
      return listAll(settings, fresh).pipe(
        Effect.map((issues) => issues.filter((issue) => uuids.has(issue.onesProjectUuid))),
      );
    };

    const list: IssueService["Service"]["list"] = Effect.fn("IssueService.list")(function* (
      projectId,
    ) {
      const settings = yield* readSettings;
      const project = yield* projects.getById(projectId).pipe(Effect.mapError(fail));
      if (Option.isNone(project)) return [];
      return yield* issuesForProject(settings, project.value);
    });

    const get: IssueService["Service"]["get"] = Effect.fn("IssueService.get")(function* (
      issueUuid,
    ) {
      const settings = yield* readSettings;
      const ones = clientFor(settings);
      const issue = yield* Effect.tryPromise({ try: () => ones.loadIssue(issueUuid), catch: fail });
      const files: IssueFile[] = [];
      const skipped: string[] = [];
      for (const attachment of issue.attachments) {
        const downloaded = yield* Effect.tryPromise(() => ones.download(attachment.url)).pipe(
          Effect.option,
        );
        if (Option.isNone(downloaded) || downloaded.value.bytes.byteLength > MAX_INLINE_FILE_BYTES) {
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
      if (skipped.length > 0) prompt += `\n\n## 其他附件\n${skipped.map((s) => `- ${s}`).join("\n")}`;
      return { issue, prompt, files };
    });

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

    const syncBinding = <E>(
      settings: ServerSettings,
      binding: IssueProjectBinding,
      startClone: (input: ProjectCloneStartInput) => Effect.Effect<unknown, E>,
    ) =>
      Effect.gen(function* () {
        const localPath = NodePath.resolve(binding.localPath);
        const existing = yield* projects.getByWorkspaceRoot(localPath).pipe(Effect.mapError(fail));
        if (Option.isSome(existing)) return { outcome: "linked" as const, message: "已在项目列表中" };
        const title = NodePath.basename(localPath);
        const projectId = ProjectId.make(crypto.randomUUID());
        if (yield* Effect.promise(() => pathExists(localPath))) {
          yield* projects
            .bootstrap({
              commandId: CommandId.make(`ones-binding-create:${projectId}`),
              projectId,
              title,
              workspaceRoot: localPath,
            })
            .pipe(Effect.mapError(fail));
          return { outcome: "created" as const, message: "已添加到项目列表" };
        }
        if (binding.repoUrl === "") {
          return { outcome: "skipped" as const, message: "本地目录不存在且未配置仓库地址" };
        }
        const { username, token } = settings.issueRepoCredentials;
        const tokenValue = settingsSecretLiteral(token);
        if (username !== "" && tokenValue !== "") {
          yield* Effect.tryPromise({
            try: () => approveGitCredentials(binding.repoUrl, username, tokenValue),
            catch: fail,
          });
        }
        yield* Effect.promise(() => NodeFs.mkdir(NodePath.dirname(localPath), { recursive: true }));
        yield* startClone({
          projectId,
          title,
          createdAt: new Date().toISOString(),
          remoteUrl: binding.repoUrl,
          destinationPath: localPath,
        }).pipe(Effect.mapError(fail));
        return { outcome: "cloning" as const, message: "正在克隆，完成后自动加入项目列表" };
      }).pipe(
        Effect.catch((error: IssueTrackerError) =>
          Effect.succeed({ outcome: "failed" as const, message: error.message }),
        ),
        Effect.map((result) => ({ localPath: binding.localPath, ...result })),
      );

    const syncBindings: IssueService["Service"]["syncBindings"] = (startClone) =>
      settingsService.getSettings.pipe(
        Effect.flatMap((settings) =>
          Effect.forEach(settings.issueProjectBindings, (binding) =>
            syncBinding(settings, binding, startClone),
          ),
        ),
        Effect.orElseSucceed(() => []),
      );

    // ---- Auto development -------------------------------------------------
    let lastPollAt = 0;
    // Launch is idempotent per commandId; this only saves the repeat round trips.
    const launched = new Set<string>();

    const downloadForAuto = (ones: OnesClient, issue: Issue) =>
      Effect.tryPromise({
        try: async () => {
          const dir = NodePath.join(config.stateDir, "ones-attachments", issue.key);
          const paths: string[] = [];
          for (const [index, attachment] of issue.attachments.entries()) {
            try {
              const { bytes } = await ones.download(attachment.url);
              await NodeFs.mkdir(dir, { recursive: true });
              const file = NodePath.join(dir, `${index + 1}-${safeFileName(attachment.name)}`);
              await NodeFs.writeFile(file, bytes);
              paths.push(file);
            } catch {
              paths.push(`${attachment.name}（下载失败）: ${attachment.url}`);
            }
          }
          return paths;
        },
        catch: fail,
      });

    const launchAuto = (settings: ServerSettings, project: Project, issue: Issue) =>
      Effect.gen(function* () {
        const modelSelection = project.defaultModelSelection ?? settings.defaultModelSelection;
        if (modelSelection === null) {
          yield* Effect.logWarning("ONES auto-dev skipped: no default model for project", {
            project: project.title,
            issue: issue.key,
          });
          return;
        }
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
      if (Date.now() - lastPollAt < intervalMinutes * 60_000) return;
      lastPollAt = Date.now();
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

    return IssueService.of({ list, get, testConnection, syncBindings });
  }),
);
