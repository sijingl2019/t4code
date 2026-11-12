import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, Issue, ProjectId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useState } from "react";

import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { comparablePath } from "../../issues/OnesProjectLinks";
import { base64ToFile, usePendingIssueFiles } from "../../issues/pendingIssueFiles";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";

/** Lists the ONES issues bound to a project; picking one starts a draft thread seeded from it. */
export function OnesIssuePickerDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  projectName: string;
}) {
  const { open, onOpenChange, environmentId, projectId } = props;
  const listIssues = useAtomCommand(serverEnvironment.listIssues);
  const getIssue = useAtomCommand(serverEnvironment.getIssue, { reportFailure: true });
  const handleNewThread = useNewThreadHandler();
  const [issues, setIssues] = useState<readonly Issue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [loadingUuid, setLoadingUuid] = useState<string | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches the issue list from the server each time the dialog opens
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void listIssues({ environmentId, input: { projectId } }).then((result) => {
      if (cancelled) return;
      if (result._tag === "Success") setIssues(result.value);
      else {
        const cause = squashAtomCommandFailure(result);
        setError(
          `Could not load ONES issues: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [open, environmentId, projectId, listIssues]);

  // Closing clears the list so the next open shows "Loading…" instead of stale issues.
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setIssues(null);
      setError(null);
    }
    onOpenChange(next);
  };

  const pick = async (issue: Issue) => {
    setLoadingUuid(issue.uuid);
    const result = await getIssue({ environmentId, input: { issueUuid: issue.uuid } });
    setLoadingUuid(null);
    if (result._tag !== "Success") return;
    const created = await handleNewThread(scopeProjectRef(environmentId, projectId), {
      prompt: result.value.prompt,
    });
    if (created && result.value.files.length > 0) {
      usePendingIssueFiles.getState().put(
        created.threadId,
        result.value.files.map((file) => base64ToFile(file.name, file.mimeType, file.dataBase64)),
      );
    }
    handleOpenChange(false);
  };

  const needle = filter.trim().toLowerCase();
  const visible = (issues ?? []).filter(
    (issue) =>
      needle === "" ||
      issue.key.toLowerCase().includes(needle) ||
      issue.title.toLowerCase().includes(needle),
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>ONES issues · {props.projectName}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-3">
            <Input
              size="sm"
              autoFocus
              placeholder="Filter by number or title"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            {issues === null && !error ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : null}
            {issues !== null && visible.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No open issues assigned to you for this project.
              </p>
            ) : null}
            <ul className="grid max-h-96 gap-1 overflow-y-auto">
              {visible.map((issue) => (
                <li key={issue.uuid} className="grid">
                  <Button
                    variant="ghost"
                    size="multiline"
                    disabled={loadingUuid !== null}
                    onClick={() => void pick(issue)}
                  >
                    <span className="flex w-full items-baseline gap-2 text-left">
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">
                        {issue.key}
                      </span>
                      <span className="min-w-0 flex-1">{issue.title}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {loadingUuid === issue.uuid ? "Loading…" : issue.status}
                      </span>
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

/** Whether the environment's ONES settings bind a project to this workspace root. */
export function useHasIssueBinding(environmentId: EnvironmentId, workspaceRoot: string): boolean {
  const bindings = useAtomValue(environmentServerConfigsAtom).get(environmentId)?.settings
    .issueProjectBindings;
  const root = comparablePath(workspaceRoot);
  return bindings?.some((binding) => comparablePath(binding.localPath) === root) ?? false;
}
