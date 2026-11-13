import * as Schema from "effect/Schema";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";

export function useArchivedShelfExpanded() {
  return useLocalStorage("t4code:sidebar:archived-expanded", false, Schema.Boolean);
}

/** Header of the shelf that holds archived project folders, just above Settled. */
export function SidebarArchivedShelfHeader(props: {
  className?: string | undefined;
  count: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <li className={cn("relative mx-0.5 mt-2 h-8 list-none", props.className)}>
      <CollapsibleSectionHeader
        onClick={props.onToggle}
        expanded={props.expanded}
        data-testid="sidebar-archived-shelf-toggle"
        accessory={<span className="font-normal tabular-nums">{props.count}</span>}
      >
        Archived
      </CollapsibleSectionHeader>
    </li>
  );
}
