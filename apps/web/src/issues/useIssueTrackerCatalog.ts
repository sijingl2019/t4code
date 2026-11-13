import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  issueTrackersOf,
  type EnvironmentId,
  type IssueTrackerCatalog,
  type IssueTrackerConnection,
  type IssueTrackerKind,
  type ServerSettings,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";

export const ISSUE_TRACKER_KIND_LABELS: Record<IssueTrackerKind, string> = {
  ones: "ONES",
  jira: "Jira",
};

/** Kinds the server can fetch issues from; Jira is selectable but not wired up yet. */
export const supportedIssueTrackerKind = (kind: IssueTrackerKind) => kind === "ones";

export const issueTrackerLabel = (tracker: IssueTrackerConnection) =>
  tracker.name || ISSUE_TRACKER_KIND_LABELS[tracker.kind];

/** Trackers whose projects can be linked: supported and with a saved connection. */
export const linkableIssueTrackers = (
  settings: ServerSettings | undefined,
): ReadonlyArray<IssueTrackerConnection> =>
  settings
    ? issueTrackersOf(settings).filter(
        (t) => supportedIssueTrackerKind(t.kind) && t.baseUrl !== "" && t.email !== "",
      )
    : [];

type Loaded = { catalog: IssueTrackerCatalog | null; error: string | null };
const toLoaded = (result: AtomCommandResult<IssueTrackerCatalog, unknown>): Loaded => {
  if (result._tag === "Success") return { catalog: result.value, error: null };
  const error = squashAtomCommandFailure(result);
  return {
    catalog: null,
    error: `Could not load from the tracker: ${error instanceof Error ? error.message : String(error)}`,
  };
};

/** One tracker's projects and statuses; `catalog` is `null` until loaded or with no tracker. */
export function useIssueTrackerCatalog(
  environmentId: EnvironmentId | null,
  trackerId: string | null,
) {
  const loadCatalog = useAtomCommand(serverEnvironment.getIssueTrackerCatalog);
  const [loaded, setLoaded] = useState<Loaded>({ catalog: null, error: null });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches the project list from the tracker
  useEffect(() => {
    if (!trackerId || !environmentId) return;
    let cancelled = false;
    void loadCatalog({ environmentId, input: { trackerId } }).then((result) => {
      if (!cancelled) setLoaded(toLoaded(result));
    });
    return () => {
      cancelled = true;
    };
  }, [trackerId, environmentId, loadCatalog]);

  const reload = async () => {
    if (!trackerId || !environmentId) return;
    setLoaded(toLoaded(await loadCatalog({ environmentId, input: { trackerId } })));
  };

  return {
    catalog: trackerId ? loaded.catalog : null,
    error: trackerId ? loaded.error : null,
    reload,
  };
}
