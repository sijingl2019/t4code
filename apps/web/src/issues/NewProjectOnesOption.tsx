import type { EnvironmentId } from "@t3tools/contracts";
import { ListTodoIcon } from "lucide-react";
import { useState } from "react";

import { ITEM_ICON_CLASS } from "~/components/CommandPalette.logic";
import type { CommandPaletteGroup } from "~/components/CommandPalette.logic";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useServerConfigs } from "~/state/entities";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { onesConfigured, useIssueTrackerCatalog } from "./useIssueTrackerCatalog";

const NONE = "none";

/**
 * "Link ONES project" row for the palette's New project flow. `bind` adds the chosen ONES
 * project's binding for the created project's workspace root.
 */
export function useNewProjectOnesOption(environmentId: EnvironmentId | null, disabled: boolean) {
  const settings = useServerConfigs().get(environmentId ?? ("" as EnvironmentId))?.settings;
  const enabled = environmentId !== null && onesConfigured(settings);
  const projects = useIssueTrackerCatalog(environmentId, enabled).catalog?.projects ?? null;
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: true });
  const [selected, setSelected] = useState(NONE);
  const [open, setOpen] = useState(false);

  const chosen = projects?.find((project) => project.id === selected) ?? null;

  const bind = async (workspaceRoot: string) => {
    if (!environmentId || !settings || !chosen) return;
    setSelected(NONE);
    const result = await updateSettings({
      environmentId,
      input: {
        patch: {
          issueProjectBindings: [
            ...settings.issueProjectBindings,
            { onesProjectUuid: chosen.id, localPath: workspaceRoot },
          ],
        },
      },
    });
    if (result._tag === "Success") {
      toastManager.add(
        stackedThreadToast({ type: "success", title: `Linked ONES project ${chosen.name}` }),
      );
    }
  };

  const group: CommandPaletteGroup | null =
    !projects || projects.length === 0
      ? null
      : {
          value: "new-project-ones",
          label: "ONES",
          items: [
            {
              kind: "action",
              value: "new-project-ones-link",
              searchTerms: [],
              title: "Link ONES project",
              description: chosen ? chosen.name : "Pick issues from ONES in this project",
              icon: <ListTodoIcon className={ITEM_ICON_CLASS} />,
              titleTrailingContent: (
                // The row cancels pointerdown to keep focus in the input, so open on click.
                <span
                  className="ms-auto flex"
                  onClick={(event) => {
                    event.stopPropagation();
                    if (!event.currentTarget.contains(event.target as Node)) return;
                    if (!disabled) setOpen(true);
                  }}
                >
                  <Select
                    disabled={disabled}
                    open={open}
                    onOpenChange={setOpen}
                    value={selected}
                    onValueChange={(value) => setSelected(value ?? NONE)}
                  >
                    <SelectTrigger size="xs" variant="ghost" aria-label="ONES project">
                      <SelectValue>
                        {(value: string) =>
                          projects.find((project) => project.id === value)?.name ?? "None"
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      <SelectItem value={NONE}>None</SelectItem>
                      {projects.map((project) => (
                        <SelectItem key={project.id} value={project.id}>
                          {project.name}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </span>
              ),
              ...(disabled ? { disabled: true } : {}),
              keepOpen: true,
              run: async () => setOpen(true),
            },
          ],
        };

  return { group, bind };
}
