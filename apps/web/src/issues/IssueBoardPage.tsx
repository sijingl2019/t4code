import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  threadRuntimeIsActive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, IssueBoard, IssueBoardRow } from "@t3tools/contracts";
import { ArrowDownIcon, ArrowUpIcon, ExternalLinkIcon, PlayIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { ensureLocalApi } from "../localApi";
import { cn } from "../lib/utils";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageContainer } from "../components/WorkspacePageContainer";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useQuietThreadShells } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";

type SortKey = "key" | "title" | "project" | "status";
type ThreadFilter = "all" | "started" | "not-started";
type DevState = "error" | "running" | "done";

const ALL_PROJECTS = "__all__";
const THREAD_FILTER_LABELS: Record<ThreadFilter, string> = {
  all: "All issues",
  started: "Thread started",
  "not-started": "No thread",
};

/** Red: the last run failed; yellow: working (or launching); green: the last run completed. */
function issueDevState(thread: EnvironmentThreadShell | undefined): DevState {
  if (thread === undefined || threadRuntimeIsActive(thread.runtime)) return "running";
  const status = thread.latestRun?.status;
  if (status === "completed") return "done";
  if (status === "failed" || status === "interrupted" || status === "cancelled") return "error";
  return "running";
}

const DEV_STATE_CLASS: Record<DevState, string> = {
  error: "bg-error",
  // The only animation here: a small opacity pulse, compositor-only.
  running: "bg-warning animate-pulse",
  done: "bg-success",
};
const DEV_STATE_LABEL: Record<DevState, string> = {
  error: "Development failed",
  running: "In development",
  done: "Development finished",
};

const projectLabel = (row: IssueBoardRow) =>
  `${row.trackerProjectName || "?"} → ${row.projects.map((p) => p.name).join(", ")}`;

/** The /issues page: the board for the primary environment. */
export function IssueBoardPage() {
  const environmentId = usePrimaryEnvironmentId();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-y-auto overscroll-y-none">
      <WorkspacePageContainer width="expanded">
        <h1 className="text-lg font-semibold">Issues</h1>
        {environmentId ? (
          <IssueBoardTable environmentId={environmentId} />
        ) : (
          <p className="text-sm text-muted-foreground">Connecting…</p>
        )}
      </WorkspacePageContainer>
    </SidebarInset>
  );
}

/** Every issue assigned to the user in bound tracker projects, with status edits and one-click runs. */
function IssueBoardTable({ environmentId }: { environmentId: EnvironmentId }) {
  const loadBoard = useAtomCommand(serverEnvironment.getIssueBoard);
  const setIssueStatus = useAtomCommand(serverEnvironment.setIssueStatus);
  const executeIssue = useAtomCommand(serverEnvironment.executeIssue);
  const threads = useQuietThreadShells();
  const [board, setBoard] = useState<IssueBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [trackerProject, setTrackerProject] = useState(ALL_PROJECTS);
  const [threadFilter, setThreadFilter] = useState<ThreadFilter>("all");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "key", desc: true });
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches the board from the tracker when the page opens
  useEffect(() => {
    let cancelled = false;
    void loadBoard({ environmentId, input: {} }).then((result) => {
      if (cancelled) return;
      if (result._tag === "Success") setBoard(result.value);
      else {
        const cause = squashAtomCommandFailure(result);
        setError(
          `Could not load issues: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, loadBoard]);

  const rowId = (row: IssueBoardRow) => `${row.issue.trackerId}/${row.issue.uuid}`;
  const patchRow = (id: string, patch: (row: IssueBoardRow) => IssueBoardRow) =>
    setBoard(
      (current) =>
        current && { ...current, rows: current.rows.map((r) => (rowId(r) === id ? patch(r) : r)) },
    );
  const withBusy = async (id: string, run: () => Promise<void>) => {
    setBusy((current) => new Set(current).add(id));
    try {
      await run();
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  };

  const changeStatus = (row: IssueBoardRow, statusId: string) =>
    withBusy(rowId(row), async () => {
      const result = await setIssueStatus({
        environmentId,
        input: { trackerId: row.issue.trackerId, issueUuid: row.issue.uuid, statusId },
      });
      if (result._tag !== "Success") return;
      if (!result.value) {
        toastManager.add({
          type: "error",
          title: "Status not changed",
          description: `${row.issue.key} has no workflow transition to that status.`,
        });
        return;
      }
      const name = board?.statuses[row.issue.trackerId]?.find((s) => s.id === statusId)?.name;
      patchRow(rowId(row), (r) => ({
        ...r,
        issue: { ...r.issue, statusId, status: name ?? r.issue.status },
      }));
    });

  const execute = (row: IssueBoardRow) =>
    withBusy(rowId(row), async () => {
      const project = row.projects[0];
      if (!project) return;
      const result = await executeIssue({
        environmentId,
        input: { trackerId: row.issue.trackerId, issueUuid: row.issue.uuid, projectId: project.id },
      });
      if (result._tag === "Success")
        patchRow(rowId(row), (r) => ({ ...r, threadId: result.value }));
    });

  const threadById = new Map(
    threads.filter((t) => t.environmentId === environmentId).map((t) => [t.id, t] as const),
  );
  const rows = board?.rows ?? [];
  const trackerProjects = [...new Set(rows.map((r) => r.trackerProjectName))].toSorted();
  const needle = query.trim().toLowerCase();
  const visible = rows
    .filter(
      (row) =>
        (trackerProject === ALL_PROJECTS || row.trackerProjectName === trackerProject) &&
        (threadFilter === "all" || (row.threadId !== null) === (threadFilter === "started")) &&
        (needle === "" ||
          row.issue.key.toLowerCase().includes(needle) ||
          row.issue.title.toLowerCase().includes(needle) ||
          row.issue.descriptionText.toLowerCase().includes(needle)),
    )
    .toSorted((a, b) => {
      const order =
        sort.key === "key"
          ? a.issue.number - b.issue.number
          : sort.key === "title"
            ? a.issue.title.localeCompare(b.issue.title)
            : sort.key === "project"
              ? projectLabel(a).localeCompare(projectLabel(b))
              : a.issue.status.localeCompare(b.issue.status);
      return sort.desc ? -order : order;
    });

  const header = (key: SortKey, label: string) => (
    <th className="px-2 py-1.5 text-left font-medium">
      <button
        type="button"
        className="inline-flex items-center gap-1 hover:text-foreground"
        onClick={() =>
          setSort((current) => ({ key, desc: current.key === key ? !current.desc : false }))
        }
      >
        {label}
        {sort.key === key ? (
          sort.desc ? (
            <ArrowDownIcon className="size-3" />
          ) : (
            <ArrowUpIcon className="size-3" />
          )
        ) : null}
      </button>
    </th>
  );

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
        <div className="min-w-48 flex-1">
          <Input
            size="sm"
            autoFocus
            placeholder="Search number, title or description"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="w-48 shrink-0">
          <Select
            value={trackerProject}
            onValueChange={(value) => setTrackerProject(value ?? ALL_PROJECTS)}
          >
            <SelectTrigger size="sm" aria-label="Tracker project">
              <SelectValue>
                {(value: string) => (value === ALL_PROJECTS ? "All projects" : value)}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
              {trackerProjects.map((name) => (
                <SelectItem key={name} value={name}>
                  {name || "?"}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <div className="w-40 shrink-0">
          <Select value={threadFilter} onValueChange={(value) => setThreadFilter(value ?? "all")}>
            <SelectTrigger size="sm" aria-label="Thread filter">
              <SelectValue>{(value: ThreadFilter) => THREAD_FILTER_LABELS[value]}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {(Object.keys(THREAD_FILTER_LABELS) as ThreadFilter[]).map((value) => (
                <SelectItem key={value} value={value}>
                  {THREAD_FILTER_LABELS[value]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {board?.errors.map((message) => (
        <p key={message} className="text-sm text-destructive">
          {message}
        </p>
      ))}
      {board === null && !error ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {board !== null && visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">No matching issues.</p>
      ) : null}
      {visible.length > 0 ? (
        <div>
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-background text-xs text-muted-foreground">
              <tr>
                {header("key", "Number")}
                {header("title", "Title")}
                {header("project", "Project")}
                {header("status", "Status")}
                <th className="px-2 py-1.5 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => {
                const id = rowId(row);
                const isBusy = busy.has(id);
                const statuses = board?.statuses[row.issue.trackerId] ?? [];
                const devState =
                  row.threadId === null ? null : issueDevState(threadById.get(row.threadId));
                return (
                  <tr key={id} className="border-t border-border/60">
                    <td className="whitespace-nowrap px-2 py-1.5 font-mono text-xs">
                      <span className="inline-flex items-center gap-1.5">
                        {devState ? (
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <span
                                  role="img"
                                  aria-label={DEV_STATE_LABEL[devState]}
                                  className={cn(
                                    "size-2 shrink-0 rounded-full",
                                    DEV_STATE_CLASS[devState],
                                  )}
                                />
                              }
                            />
                            <TooltipPopup side="top">{DEV_STATE_LABEL[devState]}</TooltipPopup>
                          </Tooltip>
                        ) : (
                          <span className="size-2 shrink-0" />
                        )}
                        {row.issue.key}
                      </span>
                    </td>
                    <td className="px-2 py-1.5">{row.issue.title}</td>
                    <td className="px-2 py-1.5 text-xs text-muted-foreground">
                      {projectLabel(row)}
                    </td>
                    <td className="px-2 py-1.5">
                      <Select
                        disabled={isBusy || statuses.length === 0}
                        value={row.issue.statusId ?? ""}
                        onValueChange={(value) => {
                          if (value && value !== row.issue.statusId) {
                            void changeStatus(row, value);
                          }
                        }}
                      >
                        <SelectTrigger size="xs" aria-label={`Status of ${row.issue.key}`}>
                          <SelectValue>{() => row.issue.status || "?"}</SelectValue>
                        </SelectTrigger>
                        <SelectPopup>
                          {statuses.map((status) => (
                            <SelectItem key={status.id} value={status.id}>
                              {status.name}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Open ${row.issue.key} in browser`}
                        title="Details"
                        onClick={() => void ensureLocalApi().shell.openExternal(row.issue.url)}
                      >
                        <ExternalLinkIcon />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Run ${row.issue.key}`}
                        title={
                          row.threadId !== null
                            ? "A thread is already started"
                            : `Run in ${row.projects[0]?.name ?? "?"}`
                        }
                        disabled={isBusy || row.threadId !== null}
                        onClick={() => void execute(row)}
                      >
                        <PlayIcon />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
