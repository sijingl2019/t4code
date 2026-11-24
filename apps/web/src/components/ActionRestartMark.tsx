import { useGT } from "gt-react";
import { RotateCcwIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * t4code: marks an Action whose terminal still runs. Clicking the row reruns the Action in that
 * terminal, which kills the old process first (`restart: true`), so the mark needs no handler.
 */
export function ActionRestartMark(props: { name: string; className?: string }) {
  const gt = useGT();
  const label = gt("Restart {name}", { name: props.name });
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={label}
            className={cn(
              "flex size-6 shrink-0 items-center justify-center rounded-md text-success hover:bg-accent",
              props.className,
            )}
          />
        }
      >
        <RotateCcwIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="right">{label}</TooltipPopup>
    </Tooltip>
  );
}
