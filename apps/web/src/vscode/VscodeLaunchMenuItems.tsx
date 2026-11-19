import { ScriptIcon } from "~/components/projectScriptEditor";
import {
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuItemLabel,
  MenuSeparator,
} from "~/components/ui/menu";
import type { VscodeLaunchScript } from "./vscodeLaunchScripts";

export type { VscodeLaunchScript };

export function VscodeLaunchMenuItems(props: {
  scripts: ReadonlyArray<VscodeLaunchScript>;
  separated: boolean;
  density: "touch" | "default";
  onRun: ((script: VscodeLaunchScript) => void) | undefined;
}) {
  if (props.scripts.length === 0) return null;
  return (
    <>
      {props.separated && <MenuSeparator />}
      <MenuGroup>
        <MenuGroupLabel>From launch.json</MenuGroupLabel>
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
          </MenuItem>
        ))}
      </MenuGroup>
    </>
  );
}
