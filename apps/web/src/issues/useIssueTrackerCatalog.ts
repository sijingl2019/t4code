import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, IssueTrackerCatalog, ServerSettings } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";

export const onesConfigured = (settings: ServerSettings | undefined): boolean =>
  !!settings && settings.ones.baseUrl !== "" && settings.ones.email !== "";

type Loaded = { catalog: IssueTrackerCatalog | null; error: string | null };
const toLoaded = (result: AtomCommandResult<IssueTrackerCatalog, unknown>): Loaded => {
  if (result._tag === "Success") return { catalog: result.value, error: null };
  const error = squashAtomCommandFailure(result);
  return {
    catalog: null,
    error: `Could not load from ONES: ${error instanceof Error ? error.message : String(error)}`,
  };
};

/** Tracker projects and statuses for the configured account; `catalog` is `null` until loaded. */
export function useIssueTrackerCatalog(environmentId: EnvironmentId | null, enabled: boolean) {
  const loadCatalog = useAtomCommand(serverEnvironment.getIssueTrackerCatalog);
  const [loaded, setLoaded] = useState<Loaded>({ catalog: null, error: null });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches the project list from the tracker
  useEffect(() => {
    if (!enabled || !environmentId) return;
    let cancelled = false;
    void loadCatalog({ environmentId, input: {} }).then((result) => {
      if (!cancelled) setLoaded(toLoaded(result));
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, environmentId, loadCatalog]);

  const reload = async () => {
    if (!enabled || !environmentId) return;
    setLoaded(toLoaded(await loadCatalog({ environmentId, input: {} })));
  };

  return {
    catalog: enabled ? loaded.catalog : null,
    error: enabled ? loaded.error : null,
    reload,
  };
}
