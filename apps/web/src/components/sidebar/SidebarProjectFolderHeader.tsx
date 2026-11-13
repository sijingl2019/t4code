import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { LinkIcon, SquarePenIcon, TicketIcon } from "lucide-react";
import { memo, useState } from "react";

import { cn } from "~/lib/utils";
import { IssueProjectLinkDialog } from "../../issues/OnesProjectLinks";
import { linkableIssueTrackers } from "../../issues/useIssueTrackerCatalog";
import { useServerConfigs } from "../../state/entities";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useUiStateStore } from "../../uiStateStore";
import { resolveSidebarFolderDot, resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { OnesIssuePickerDialog, useHasIssueBinding } from "./OnesIssuePickerDialog";
import { ProjectFolderMenu } from "./ProjectFolderMenu";

const FOLDER_DOT_CLASS_NAME = {
  attention: "bg-warning",
  failed: "bg-error",
  unread: "bg-success",
  working: "bg-info",
} as const;

const FOLDER_DOT_LABEL = {
  attention: ", needs you",
  failed: ", failed",
  unread: ", done",
  working: ", working",
} as const;

/** The folder's sidebar tree row; its thread rows name it as their parent. */
export function sidebarFolderRowId(projectKey: string) {
  return `folder:${projectKey}`;
}

/**
 * A project folder in the boring sidebar. It reads like a shelf header: a trailing
 * count and a "…" menu, with the count and a status dot only while it is closed, so a
 * closed folder still says when a hidden thread needs you.
 */
export const SidebarProjectFolderHeader = memo(function SidebarProjectFolderHeader(props: {
  group: SidebarProjectSnapshot;
  collapsed: boolean;
  hiddenThreads: readonly EnvironmentThreadShell[];
  onToggle: (group: SidebarProjectSnapshot) => void;
  onNewThread: (group: SidebarProjectSnapshot) => void;
  onContextMenu: (group: SidebarProjectSnapshot, position: { x: number; y: number }) => void;
  onOpenSettings: (group: SidebarProjectSnapshot) => void;
}) {
  const { group, collapsed, hiddenThreads } = props;
  const rowId = sidebarFolderRowId(group.projectKey);
  const localLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const hasIssueBinding = useHasIssueBinding(group.environmentId, group.workspaceRoot);
  const [issuePickerOpen, setIssuePickerOpen] = useState(false);
  // t4code: unbound projects get a "Link trackers" button in the issue button's place.
  const settings = useServerConfigs().get(group.environmentId)?.settings;
  const canLinkTracker = !hasIssueBinding && linkableIssueTrackers(settings).length > 0;
  const [linkOpen, setLinkOpen] = useState(false);
  const dot = collapsed
    ? resolveSidebarFolderDot(
        hiddenThreads.map((thread) => ({
          ...thread,
          lastVisitedAt: resolveThreadLastVisitedAt(
            thread.lastVisitedAt,
            localLastVisitedAtById[
              scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
            ],
          ),
        })),
      )
    : null;
  return (
    <li
      data-testid="sidebar-project-folder"
      className="group/project-folder relative mt-2 list-none first:mt-0"
    >
      <button
        type="button"
        data-sidebar-row={rowId}
        aria-expanded={!collapsed}
        onClick={() => props.onToggle(group)}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onContextMenu(group, { x: event.clientX, y: event.clientY });
        }}
        className="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-(--control-radius) px-(--sidebar-row-content-inset) text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ProjectFavicon project={group} className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground/90">
          {group.displayName}
        </span>
        {dot ? (
          <span className={cn("size-1.5 shrink-0 rounded-full", FOLDER_DOT_CLASS_NAME[dot])}>
            <span className="sr-only">{FOLDER_DOT_LABEL[dot]}</span>
          </span>
        ) : null}
        {collapsed && hiddenThreads.length > 0 ? (
          <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground">
            {hiddenThreads.length}
          </span>
        ) : null}
        {/* Room for the always-visible buttons that sit over this slot. */}
        <span
          aria-hidden
          className={cn("shrink-0", hasIssueBinding || canLinkTracker ? "w-18" : "w-12")}
        />
      </button>
      {/* Always visible, on the same line as the project name. */}
      <span className="absolute inset-y-0 right-1 flex items-center">
        {hasIssueBinding ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={`New thread from an issue in ${group.displayName}`}
                  onClick={() => setIssuePickerOpen(true)}
                />
              }
            >
              <TicketIcon aria-hidden />
            </TooltipTrigger>
            <TooltipPopup>New thread from an issue</TooltipPopup>
          </Tooltip>
        ) : null}
        {canLinkTracker ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={`Link trackers to ${group.displayName}`}
                  onClick={() => setLinkOpen(true)}
                />
              }
            >
              <LinkIcon aria-hidden />
            </TooltipTrigger>
            <TooltipPopup>Link trackers</TooltipPopup>
          </Tooltip>
        ) : null}
        <ProjectFolderMenu group={group} onOpenSettings={props.onOpenSettings} />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                data-sidebar-action-for={rowId}
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`New thread in ${group.displayName}`}
                onClick={() => props.onNewThread(group)}
              />
            }
          >
            <SquarePenIcon aria-hidden />
          </TooltipTrigger>
          <TooltipPopup>New thread in {group.displayName}</TooltipPopup>
        </Tooltip>
      </span>
      {hasIssueBinding ? (
        <OnesIssuePickerDialog
          open={issuePickerOpen}
          onOpenChange={setIssuePickerOpen}
          environmentId={group.environmentId}
          projectId={group.id}
          projectName={group.displayName}
        />
      ) : null}
      {linkOpen ? (
        <IssueProjectLinkDialog
          environmentId={group.environmentId}
          workspaceRoot={group.workspaceRoot}
          projectName={group.displayName}
          onClose={() => setLinkOpen(false)}
        />
      ) : null}
    </li>
  );
});
