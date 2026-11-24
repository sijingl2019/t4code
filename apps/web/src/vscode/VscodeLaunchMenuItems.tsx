import { ScriptIcon } from "~/components/projectScriptEditor";
import {
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuItemLabel,
  MenuSeparator,
} from "~/components/ui/menu";
import { ActionRestartMark } from "~/components/ActionRestartMark";
import { T } from "gt-react";
import { vscodeLaunchActionId, type VscodeLaunchScript } from "./vscodeLaunchScripts";

export type { VscodeLaunchScript };

export function VscodeLaunchMenuItems(props: {
  scripts: ReadonlyArray<VscodeLaunchScript>;
  separated: boolean;
  density: "touch" | "default";
  onRun: ((script: VscodeLaunchScript) => void) | undefined;
  isActionRunning?: ((actionId: string) => boolean) | undefined;
}) {
  if (props.scripts.length === 0) return null;
  return (
    <>
      {props.separated && <MenuSeparator />}
      <MenuGroup>
        <MenuGroupLabel>
          <T>From launch.json</T>
        </MenuGroupLabel>
        {props.scripts.map((script) => (
          <MenuItem
            density={props.density}
            key={script.name}
            disabled={!props.onRun}
            title={script.command}
            onClick={() => props.onRun?.(script)}
          >
            <ScriptIcon icon="debug" className="size-4" />
            <MenuItemLabel>{script.name}</MenuItemLabel>
            {props.isActionRunning?.(vscodeLaunchActionId(script)) && (
              <ActionRestartMark name={script.name} className="ms-auto" />
            )}
          </MenuItem>
        ))}
      </MenuGroup>
    </>
  );
}
