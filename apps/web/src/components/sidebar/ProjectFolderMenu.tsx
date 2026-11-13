import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { planProjectRemoval } from "@t3tools/client-runtime/state/projects";
import { mapAtomCommandResult, settlePromise } from "@t3tools/client-runtime/state/runtime";
import type { ProjectIconOverride } from "@t3tools/contracts";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  EllipsisIcon,
  FolderOpenIcon,
  LinkIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  XIcon,
} from "lucide-react";
import { lazy, Suspense, useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import {
  checkProjectAccess,
  reportProjectFailure,
  useProjectGroupUpdate,
  useProjectPin,
} from "../../hooks/useProjectGroupUpdate";
import {
  IssueProjectLinkDialog,
  IssueProjectLinksFields,
  useIssueProjectLinks,
  type IssueLinkSelection,
} from "../../issues/OnesProjectLinks";
import { linkableIssueTrackers } from "../../issues/useIssueTrackerCatalog";
import { releaseProjectDraftUploads } from "../../lib/composerDraftUploads";
import { getLocalFileManagerName } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useServerConfigs, useThreadShells, waitForProjectRemoval } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { shellEnvironment } from "../../state/shell";
import { readUnloadedThreadCount } from "../../state/olderSettledShelf";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { VisualStudioCode } from "../Icons";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";

const ProjectIconPickerDialog = lazy(() =>
  import("../settings/ProjectIconPickerDialog").then((module) => ({
    default: module.ProjectIconPickerDialog,
  })),
);

/** The project folder's "…" menu: pin, edit, link issue projects, reveal, archive, remove. */
export function ProjectFolderMenu(props: {
  group: SidebarProjectSnapshot;
  onOpenSettings: (group: SidebarProjectSnapshot) => void;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [onesOpen, setOnesOpen] = useState(false);
  return (
    <>
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={`More actions for ${props.group.displayName}`}
            />
          }
        >
          <EllipsisIcon aria-hidden />
        </MenuTrigger>
        <MenuPopup align="end">
          {/* Mounted only while open, so idle folder rows carry no extra subscriptions. */}
          <ProjectFolderMenuItems
            group={props.group}
            onEdit={() => setEditOpen(true)}
            onLinkOnes={() => setOnesOpen(true)}
          />
        </MenuPopup>
      </Menu>
      {editOpen ? (
        <EditProjectDialog
          group={props.group}
          onClose={() => setEditOpen(false)}
          onOpenSettings={() => {
            setEditOpen(false);
            props.onOpenSettings(props.group);
          }}
        />
      ) : null}
      {onesOpen ? (
        <IssueProjectLinkDialog
          environmentId={props.group.environmentId}
          workspaceRoot={props.group.workspaceRoot}
          projectName={props.group.displayName}
          onClose={() => setOnesOpen(false)}
        />
      ) : null}
    </>
  );
}

function ProjectFolderMenuItems({
  group,
  onEdit,
  onLinkOnes,
}: {
  group: SidebarProjectSnapshot;
  onEdit: () => void;
  onLinkOnes: () => void;
}) {
  const { canPinProjectGroup, setProjectGroupPinned } = useProjectPin();
  const { updateProjectGroup, canOrganizeProjectGroup } = useProjectGroupUpdate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const config = useServerConfigs().get(group.environmentId);
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, "open in editor");
  const removeProject = useRemoveProjectGroup(group);
  const isLocal = group.environmentId === primaryEnvironmentId;
  const canReveal = isLocal && config?.availableEditors.includes("file-manager") === true;
  const canOpenVsCode = isLocal && config?.availableEditors.includes("vscode") === true;

  return (
    <>
      {canPinProjectGroup(group) ? (
        <MenuItem onClick={() => setProjectGroupPinned(group, !group.pinned)}>
          {group.pinned ? <PinOffIcon /> : <PinIcon />}
          {group.pinned ? "Unpin" : "Pin"}
        </MenuItem>
      ) : null}
      <MenuItem onClick={onEdit}>
        <PencilIcon />
        Edit
      </MenuItem>
      {linkableIssueTrackers(config?.settings).length > 0 ? (
        <MenuItem onClick={onLinkOnes}>
          <LinkIcon />
          Link Issues
        </MenuItem>
      ) : null}
      {canReveal || canOpenVsCode ? <MenuSeparator /> : null}
      {canReveal ? (
        <MenuItem
          onClick={() =>
            void openInEditor({
              environmentId: group.environmentId,
              input: { cwd: group.workspaceRoot, editor: "file-manager" },
            })
          }
        >
          <FolderOpenIcon />
          Open in {getLocalFileManagerName(navigator.platform)}
        </MenuItem>
      ) : null}
      {canOpenVsCode ? (
        <MenuItem
          onClick={() =>
            void openInEditor({
              environmentId: group.environmentId,
              input: { cwd: group.workspaceRoot, editor: "vscode" },
            })
          }
        >
          <VisualStudioCode />
          Open in VS Code
        </MenuItem>
      ) : null}
      <MenuSeparator />
      {canOrganizeProjectGroup(group.memberProjects) ? (
        <MenuItem
          onClick={() =>
            void updateProjectGroup(
              group.memberProjects,
              { archived: !group.archived },
              group.archived ? "Failed to unarchive project" : "Failed to archive project",
            )
          }
        >
          {group.archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
          {group.archived ? "Unarchive project" : "Archive project"}
        </MenuItem>
      ) : null}
      <MenuItem variant="destructive" onClick={() => void removeProject()}>
        <XIcon />
        Remove project
      </MenuItem>
    </>
  );
}

/** Same removal as Settings → Project → Danger, for the whole group. */
function useRemoveProjectGroup(group: SidebarProjectSnapshot) {
  const threads = useThreadShells();
  const deleteProject = useOrchestrationCommand(projectEnvironment.delete, {
    reportFailure: false,
  });
  return async () => {
    const members = group.memberProjects;
    if (checkProjectAccess(members, "Failed to remove project")) return;
    const api = readLocalApi();
    if (!api) return;
    const { projectThreads, confirmationMessage } = planProjectRemoval({
      members,
      groupMemberCount: members.length,
      hasOtherMembers: false,
      displayName: group.displayName,
      threads,
      unloadedThreadCount: readUnloadedThreadCount(members, threads),
    });
    const confirmed = await settlePromise(() =>
      api.dialogs.confirm(confirmationMessage, { variant: "destructive" }),
    );
    if (confirmed._tag === "Failure" || !confirmed.value) return;
    const draftStore = useComposerDraftStore.getState();
    for (const member of members) {
      if (checkProjectAccess([member], "Failed to remove project")) return;
      const result = mapAtomCommandResult(
        await deleteProject({
          environmentId: member.environmentId,
          input: { projectId: member.id, force: true },
        }),
        () => undefined,
      );
      if (result._tag === "Failure") {
        reportProjectFailure(`Failed to remove "${member.title}"`, result);
        return;
      }
      const projectRef = scopeProjectRef(member.environmentId, member.id);
      await waitForProjectRemoval(projectRef);
      releaseProjectDraftUploads(
        projectRef,
        projectThreads
          .filter(
            (thread) =>
              thread.environmentId === member.environmentId && thread.projectId === member.id,
          )
          .map((thread) => scopeThreadRef(thread.environmentId, thread.id)),
      );
      const draft = draftStore.getDraftThreadByProjectRef(projectRef);
      if (draft) draftStore.clearDraftThread(draft.draftId);
      draftStore.clearProjectDraftThreadId(projectRef);
    }
  };
}

function EditProjectDialog({
  group,
  onClose,
  onOpenSettings,
}: {
  group: SidebarProjectSnapshot;
  onClose: () => void;
  onOpenSettings: () => void;
}) {
  const { updateProjectGroup } = useProjectGroupUpdate();
  const links = useIssueProjectLinks(group.environmentId, group.workspaceRoot);
  const [name, setName] = useState(group.displayName);
  const [icon, setIcon] = useState<ProjectIconOverride | null>(group.projectIcon ?? null);
  const [selection, setSelection] = useState<IssueLinkSelection>({});
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const title = name.trim();
  const iconChanged = icon !== (group.projectIcon ?? null);
  const save = async () => {
    if (!title) return;
    setBusy(true);
    const update = {
      ...(title !== group.displayName ? { title } : {}),
      ...(iconChanged ? { projectIcon: icon, faviconPath: null } : {}),
    };
    const saved =
      Object.keys(update).length === 0 ||
      (await updateProjectGroup(group.memberProjects, update, "Failed to update project"))._tag ===
        "Success";
    const linked = saved && (await links.save(selection));
    setBusy(false);
    if (linked) onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="w-full sm:w-[28rem]">
        <DialogHeader>
          <DialogTitle>Edit project</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-4">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="icon"
                variant="outline"
                aria-label="Choose a project icon"
                onClick={() => setIconPickerOpen(true)}
              >
                <ProjectFavicon
                  project={iconChanged ? { ...group, projectIcon: icon, faviconPath: null } : group}
                  className="size-4"
                />
              </Button>
              <Input
                autoFocus
                aria-label="Project name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === "Enter") void save();
                }}
              />
            </div>
            <IssueProjectLinksFields
              environmentId={group.environmentId}
              trackers={links.trackers}
              value={(trackerId) => selection[trackerId] ?? links.linkedIds(trackerId)}
              onChange={(trackerId, ids) =>
                setSelection((previous) => ({ ...previous, [trackerId]: ids }))
              }
              disabled={busy}
            />
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="link" className="me-auto" onClick={onOpenSettings}>
            All settings
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={busy || !title}>
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
      {iconPickerOpen ? (
        <Suspense fallback={null}>
          <ProjectIconPickerDialog
            current={icon}
            projectName={group.title}
            open
            onOpenChange={setIconPickerOpen}
            onSelect={setIcon}
          />
        </Suspense>
      ) : null}
    </Dialog>
  );
}
