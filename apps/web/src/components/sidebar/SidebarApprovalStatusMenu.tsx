import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  ChildThreadApproval,
  ThreadPendingApproval,
} from "@t3tools/client-runtime/state/thread-requests";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { ChevronDownIcon, TriangleAlertIcon } from "lucide-react";
import { T, useGT, useMessages } from "gt-react";
import { useState, type ReactNode } from "react";
import { cn } from "~/lib/utils";
import { useEnvironmentScope } from "../../state/session";
import {
  childThreadApprovalsAtom,
  environmentThreadDetails,
  threadEnvironment,
} from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { DEFAULT_APPROVAL_OPTIONS } from "../chat/approvalOptions";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";

export interface SidebarApprovalTarget {
  readonly thread: ScopedThreadRef;
  readonly approval: ThreadPendingApproval;
  readonly title?: string;
}

interface SidebarApprovalMenuButtonProps {
  readonly targets: ReadonlyArray<SidebarApprovalTarget>;
  readonly label: string;
  readonly className: string;
  readonly icon: ReactNode;
  readonly canRespond: boolean;
  readonly onRespond: (
    target: SidebarApprovalTarget,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

function approvalOptions(approval: ThreadPendingApproval): {
  readonly primary: ReadonlyArray<ProviderApprovalOption>;
  readonly more: ReadonlyArray<ProviderApprovalOption>;
  readonly usesDefaultLabels: boolean;
} {
  const options = approval.options ?? DEFAULT_APPROVAL_OPTIONS;
  return {
    primary: options.filter(
      (option) => option.decision === "decline" || option.decision === "accept",
    ),
    more: options.filter((option) => option.decision !== "decline" && option.decision !== "accept"),
    usesDefaultLabels: approval.options === undefined,
  };
}

export function SidebarApprovalMenuButton({
  targets,
  label,
  className,
  icon,
  canRespond,
  onRespond,
}: SidebarApprovalMenuButtonProps) {
  const gt = useGT();
  const messages = useMessages();
  const [respondingKey, setRespondingKey] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const canUseAnyTarget = targets.some((target) => target.approval.responseCapability === "live");
  const blocked = !canRespond || !canUseAnyTarget;

  const respond = async (target: SidebarApprovalTarget, decision: ProviderApprovalDecision) => {
    const key = `${target.thread.environmentId}\n${target.thread.threadId}\n${target.approval.requestId}`;
    if (blocked || respondingKey !== null || target.approval.responseCapability !== "live") return;
    setRespondingKey(key);
    try {
      await onRespond(target, decision);
    } finally {
      setRespondingKey(null);
    }
  };

  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            className={cn(
              "inline-flex cursor-pointer items-center gap-1 rounded-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              className,
            )}
          />
        }
      >
        {icon}
        {label}
        <ChevronDownIcon aria-hidden className="size-3 shrink-0 opacity-70" />
      </MenuTrigger>
      <MenuPopup
        side="bottom"
        align="start"
        width="content"
        className="w-[min(20rem,calc(100vw-2rem))]"
      >
        {targets.map((target, index) => {
          const options = approvalOptions(target.approval);
          const optionLabel = (option: ProviderApprovalOption) =>
            options.usesDefaultLabels ? messages(option.label) : option.label;
          const optionKey = (option: ProviderApprovalOption) =>
            `${target.thread.environmentId}\n${target.thread.threadId}\n${target.approval.requestId}\n${option.decision}`;
          const isResponding =
            respondingKey ===
            `${target.thread.environmentId}\n${target.thread.threadId}\n${target.approval.requestId}`;
          const renderOption = (option: ProviderApprovalOption) => (
            <MenuItem
              key={optionKey(option)}
              disabled={blocked || isResponding || target.approval.responseCapability !== "live"}
              aria-description={option.warning}
              onClick={(event) => {
                event.stopPropagation();
                void respond(target, option.decision);
              }}
            >
              {option.warning ? <TriangleAlertIcon className="size-3 text-warning" /> : null}
              <span className="min-w-0 whitespace-normal break-words">{optionLabel(option)}</span>
            </MenuItem>
          );

          return (
            <MenuGroup
              key={`${target.thread.environmentId}\n${target.thread.threadId}\n${target.approval.requestId}`}
            >
              {index > 0 ? <MenuSeparator /> : null}
              {targets.length > 1 ? (
                <MenuGroupLabel className="max-w-full whitespace-normal break-words">
                  {target.title
                    ? gt("Approval from {title}", { title: target.title })
                    : gt("Approval needed")}
                </MenuGroupLabel>
              ) : null}
              {target.approval.detail ? (
                <p className="line-clamp-2 px-2 pb-1 text-muted-foreground text-xs break-words">
                  {target.approval.detail}
                </p>
              ) : null}
              {target.approval.responseCapability !== "live" ? (
                <p className="px-2 pb-1 text-warning text-xs">
                  <T>Provider process is gone. Interrupt or restart the run to respond.</T>
                </p>
              ) : null}
              {options.primary.map(renderOption)}
              {options.primary.length > 0 && options.more.length > 0 ? <MenuSeparator /> : null}
              {options.more.map(renderOption)}
            </MenuGroup>
          );
        })}
      </MenuPopup>
    </Menu>
  );
}

export function SidebarApprovalStatusMenu(props: {
  readonly thread: { readonly environmentId: EnvironmentId; readonly id: ThreadId };
  readonly label: string;
  readonly className: string;
  readonly icon: ReactNode;
}) {
  const threadRef = scopeThreadRef(props.thread.environmentId, props.thread.id);
  const pending = useAtomValue(environmentThreadDetails.pendingRequestsAtom(threadRef));
  const childApprovals = useAtomValue(childThreadApprovalsAtom(threadRef));
  const canRespond = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const respond = useAtomCommand(threadEnvironment.respondToApproval);

  const targets: SidebarApprovalTarget[] = [
    ...(pending?.approvals ?? []).map((approval) => ({ thread: threadRef, approval })),
    ...childApprovals.map((entry: ChildThreadApproval) => ({
      thread: entry.thread,
      approval: entry.approval,
      title: entry.title,
    })),
  ];

  if (targets.length === 0) {
    return (
      <span className={cn("inline-flex items-center gap-1 font-medium", props.className)}>
        {props.icon}
        {props.label}
      </span>
    );
  }

  return (
    <SidebarApprovalMenuButton
      targets={targets}
      label={props.label}
      className={props.className}
      icon={props.icon}
      canRespond={canRespond}
      onRespond={(target, decision) =>
        respond({
          environmentId: target.thread.environmentId,
          input: {
            threadId: target.thread.threadId,
            requestId: target.approval.requestId,
            decision,
          },
        })
      }
    />
  );
}
