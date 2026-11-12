import type { EnvironmentId, IssueTrackerProject } from "@t3tools/contracts";
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
import { onesConfigured, useIssueTrackerCatalog } from "./useIssueTrackerCatalog";

export const comparablePath = (path: string) =>
  path.replaceAll("\\", "/").replace(/\/+/g, "/").replace(/\/$/, "").toLowerCase();

/** The ONES projects bound to one T4 project's workspace root, and a writer for that set. */
export function useOnesProjectLinks(environmentId: EnvironmentId, workspaceRoot: string) {
  const settings = useServerConfigs().get(environmentId)?.settings;
  const enabled = onesConfigured(settings);
  const tracker = useIssueTrackerCatalog(environmentId, enabled);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: true });
  const root = comparablePath(workspaceRoot);
  const bindings = settings?.issueProjectBindings ?? [];
  const linkedIds = bindings
    .filter((binding) => comparablePath(binding.localPath) === root)
    .map((binding) => binding.onesProjectUuid);

  const save = async (ids: ReadonlyArray<string>): Promise<boolean> => {
    if (!settings) return true;
    if (ids.length === linkedIds.length && ids.every((id) => linkedIds.includes(id))) return true;
    const others = bindings.filter((binding) => comparablePath(binding.localPath) !== root);
    const result = await updateSettings({
      environmentId,
      input: {
        patch: {
          issueProjectBindings: [
            ...others,
            ...ids.map((onesProjectUuid) => ({ onesProjectUuid, localPath: workspaceRoot })),
          ],
        },
      },
    });
    return result._tag === "Success";
  };

  return {
    enabled,
    projects: tracker.catalog?.projects ?? null,
    error: tracker.error,
    linkedIds,
    save,
  };
}

export function OnesProjectsField(props: {
  projects: ReadonlyArray<IssueTrackerProject> | null;
  error: string | null;
  value: ReadonlyArray<string>;
  onChange: (ids: ReadonlyArray<string>) => void;
  disabled?: boolean;
}) {
  const { projects, value } = props;
  if (props.error) return <p className="text-xs text-destructive">{props.error}</p>;
  if (projects === null) return <p className="text-xs text-muted-foreground">Loading…</p>;
  const names = projects.filter((project) => value.includes(project.id)).map((p) => p.name);
  return (
    <Menu>
      <MenuTrigger
        disabled={props.disabled || projects.length === 0}
        render={<Button type="button" size="sm" variant="outline" className="w-full" />}
      >
        <span className="min-w-0 flex-1 truncate text-left">
          {projects.length === 0
            ? "No ONES projects"
            : names.length > 0
              ? names.join(", ")
              : "Select ONES projects"}
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

/** Picks the ONES projects linked to one T4 project; opened from the project folder's "…" menu. */
export function OnesProjectLinkDialog(props: {
  environmentId: EnvironmentId;
  workspaceRoot: string;
  projectName: string;
  onClose: () => void;
}) {
  const links = useOnesProjectLinks(props.environmentId, props.workspaceRoot);
  const [selected, setSelected] = useState<ReadonlyArray<string> | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const saved = selected === null || (await links.save(selected));
    setBusy(false);
    if (saved) props.onClose();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup className="w-full sm:w-[28rem]">
        <DialogHeader>
          <DialogTitle>ONES projects</DialogTitle>
          <DialogDescription>
            Pick issues from these ONES projects in {props.projectName}.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <OnesProjectsField
            projects={links.projects}
            error={links.error}
            value={selected ?? links.linkedIds}
            onChange={setSelected}
            disabled={busy}
          />
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={busy || links.error !== null}>
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
