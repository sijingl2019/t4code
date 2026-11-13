import type { EnvironmentId, IssueTrackerConnection } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { useServerConfigs } from "~/state/entities";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  issueTrackerLabel,
  linkableIssueTrackers,
  useIssueTrackerCatalog,
} from "./useIssueTrackerCatalog";

export const comparablePath = (path: string) =>
  path.replaceAll("\\", "/").replace(/\/+/g, "/").replace(/\/$/, "").toLowerCase();

/** Picked tracker project ids per tracker id; a missing tracker means "unchanged". */
export type IssueLinkSelection = Readonly<Record<string, ReadonlyArray<string>>>;

/** The tracker projects bound to one T4 project's workspace root, and a writer for them. */
export function useIssueProjectLinks(environmentId: EnvironmentId, workspaceRoot: string) {
  const settings = useServerConfigs().get(environmentId)?.settings;
  const trackers = linkableIssueTrackers(settings);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: true });
  const root = comparablePath(workspaceRoot);
  const bindings = settings?.issueProjectBindings ?? [];
  const linkedIds = (trackerId: string) =>
    bindings
      .filter((b) => b.trackerId === trackerId && comparablePath(b.localPath) === root)
      .map((b) => b.onesProjectUuid);

  const save = async (selection: IssueLinkSelection): Promise<boolean> => {
    const changed = Object.entries(selection).filter(([trackerId, ids]) => {
      const linked = linkedIds(trackerId);
      return ids.length !== linked.length || !ids.every((id) => linked.includes(id));
    });
    if (!settings || changed.length === 0) return true;
    const replaced = new Set(changed.map(([trackerId]) => trackerId));
    const others = bindings.filter(
      (b) => !(replaced.has(b.trackerId) && comparablePath(b.localPath) === root),
    );
    const result = await updateSettings({
      environmentId,
      input: {
        patch: {
          issueProjectBindings: [
            ...others,
            ...changed.flatMap(([trackerId, ids]) =>
              ids.map((onesProjectUuid) => ({
                onesProjectUuid,
                trackerId,
                localPath: workspaceRoot,
              })),
            ),
          ],
        },
      },
    });
    return result._tag === "Success";
  };

  return { trackers, linkedIds, save };
}

/** One labelled project picker per linkable tracker. */
export function IssueProjectLinksFields(props: {
  environmentId: EnvironmentId;
  trackers: ReadonlyArray<IssueTrackerConnection>;
  value: (trackerId: string) => ReadonlyArray<string>;
  onChange: (trackerId: string, ids: ReadonlyArray<string>) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid gap-3">
      {props.trackers.map((tracker) => (
        <div key={tracker.id} className="grid gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            {issueTrackerLabel(tracker)} projects
          </span>
          <TrackerProjectsField
            environmentId={props.environmentId}
            trackerId={tracker.id}
            value={props.value(tracker.id)}
            onChange={(ids) => props.onChange(tracker.id, ids)}
            disabled={props.disabled}
          />
        </div>
      ))}
    </div>
  );
}

function TrackerProjectsField(props: {
  environmentId: EnvironmentId;
  trackerId: string;
  value: ReadonlyArray<string>;
  onChange: (ids: ReadonlyArray<string>) => void;
  disabled?: boolean | undefined;
}) {
  const { catalog, error } = useIssueTrackerCatalog(props.environmentId, props.trackerId);
  const { value } = props;
  if (error) return <p className="text-xs text-destructive">{error}</p>;
  if (catalog === null) return <p className="text-xs text-muted-foreground">Loading…</p>;
  const { projects } = catalog;
  const names = projects.filter((project) => value.includes(project.id)).map((p) => p.name);
  return (
    <Menu>
      <MenuTrigger
        disabled={props.disabled || projects.length === 0}
        render={<Button type="button" size="sm" variant="outline" className="w-full" />}
      >
        <span className="min-w-0 flex-1 truncate text-left">
          {projects.length === 0
            ? "No projects"
            : names.length > 0
              ? names.join(", ")
              : "Select projects"}
        </span>
        <ChevronDownIcon />
      </MenuTrigger>
      <MenuPopup align="start">
        {projects.map((project) => (
          <MenuCheckboxItem
            key={project.id}
            checked={value.includes(project.id)}
            closeOnClick={false}
            onCheckedChange={(checked) =>
              props.onChange(
                checked ? [...value, project.id] : value.filter((id) => id !== project.id),
              )
            }
          >
            {project.name}
          </MenuCheckboxItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

/** Picks the tracker projects linked to one T4 project; opened from the project folder's "…" menu. */
export function IssueProjectLinkDialog(props: {
  environmentId: EnvironmentId;
  workspaceRoot: string;
  projectName: string;
  onClose: () => void;
}) {
  const links = useIssueProjectLinks(props.environmentId, props.workspaceRoot);
  const [selection, setSelection] = useState<IssueLinkSelection>({});
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const saved = await links.save(selection);
    setBusy(false);
    if (saved) props.onClose();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup className="w-full sm:w-[28rem]">
        <DialogHeader>
          <DialogTitle>Link issue projects</DialogTitle>
          <DialogDescription>
            Pick issues from these projects in {props.projectName}.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <IssueProjectLinksFields
            environmentId={props.environmentId}
            trackers={links.trackers}
            value={(trackerId) => selection[trackerId] ?? links.linkedIds(trackerId)}
            onChange={(trackerId, ids) =>
              setSelection((previous) => ({ ...previous, [trackerId]: ids }))
            }
            disabled={busy}
          />
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={busy}>
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
