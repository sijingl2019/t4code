import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  executeAtomQuery,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { msg, useGT } from "gt-react";
import { applyEdits, modify } from "jsonc-parser";
import { TerminalIcon } from "lucide-react";
import { useState } from "react";

import { CommandPaletteContent } from "~/components/CommandPaletteContent";
import type { CommandPaletteActionItem } from "~/components/CommandPalette.logic";
import { CommandPaletteResults } from "~/components/CommandPaletteResults";
import { getProjectFileQueryAtom } from "~/components/files/projectFilesQueryState";
import { CommandDialog, CommandDialogPopup } from "~/components/ui/command";
import { toastManager } from "~/components/ui/toast";
import { m } from "~/i18n/messages";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { projectEnvironment } from "~/state/projects";
import {
  PYTHON_INTERPRETER_SETTING,
  pythonCommand,
  VSCODE_SETTINGS_FILE,
  type VscodeLaunchScript,
} from "./vscodeLaunchScripts";

interface Interpreter {
  readonly path: string;
  readonly title: string;
  readonly description: string;
}

// ponytail: only well-known venv folders and PATH commands; add a server-side scan if users need conda/pyenv lists.
const VENV_DIRS = [".venv", "venv", "env", ".env"];

async function readOptional(environmentId: EnvironmentId, cwd: string, relativePath: string) {
  const result = await executeAtomQuery(
    appAtomRegistry,
    projectEnvironment.readFile({
      environmentId,
      input: { cwd, relativePath, allowMissing: true },
    }),
    { reportFailure: false, reportDefect: false },
  );
  return result._tag === "Success" && result.value.exists !== false ? result.value.contents : null;
}

async function findInterpreters(
  environmentId: EnvironmentId,
  cwd: string,
  windows: boolean,
): Promise<Interpreter[]> {
  const venvs = await Promise.all(
    VENV_DIRS.map(async (dir): Promise<Interpreter | null> => {
      const cfg = await readOptional(environmentId, cwd, `${dir}/pyvenv.cfg`);
      if (cfg === null) return null;
      const version = /^\s*version(?:_info)?\s*=\s*(.+)$/m.exec(cfg)?.[1]?.trim();
      const path = windows
        ? `\${workspaceFolder}\\${dir}\\Scripts\\python.exe`
        : `\${workspaceFolder}/${dir}/bin/python`;
      return {
        path,
        title: `Python ${version ?? ""} ('${dir}': venv)`.replace("  ", " "),
        description: path.replace("${workspaceFolder}", "."),
      };
    }),
  );
  const globals = (windows ? ["python", "py"] : ["python3", "python"]).map((path) => ({
    path,
    title: path,
    description: m(msg("Global, resolved from PATH")),
  }));
  return [...venvs.filter((venv) => venv !== null), ...globals];
}

async function saveInterpreter(environmentId: EnvironmentId, cwd: string, interpreter: string) {
  const current = (await readOptional(environmentId, cwd, VSCODE_SETTINGS_FILE)) ?? "{}\n";
  const contents = applyEdits(
    current,
    modify(current, [PYTHON_INTERPRETER_SETTING], interpreter, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    }),
  );
  const written = await runAtomCommand(
    appAtomRegistry,
    projectEnvironment.writeFile,
    { environmentId, input: { cwd, relativePath: VSCODE_SETTINGS_FILE, contents } },
    { label: m(msg("Save Python interpreter")), reportFailure: false },
  );
  if (written._tag === "Failure") {
    const error = squashAtomCommandFailure(written);
    toastManager.add({
      type: "warning",
      title: m(msg("Could not save the interpreter to .vscode/settings.json")),
      description: error instanceof Error ? error.message : m(msg("It is used for this run only.")),
    });
    return;
  }
  appAtomRegistry.refresh(getProjectFileQueryAtom(environmentId, cwd, VSCODE_SETTINGS_FILE));
}

/** debugpy configs without an interpreter ask for one first, like VS Code's "Select Interpreter". */
export function useVscodeLaunchRunner(input: {
  environmentId: EnvironmentId;
  cwd: string | null;
  run: ((script: VscodeLaunchScript) => void) | undefined;
}) {
  const [pending, setPending] = useState<{
    script: VscodeLaunchScript;
    interpreters: Interpreter[];
  } | null>(null);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const gt = useGT();
  const { environmentId, cwd, run } = input;

  const runScript = (script: VscodeLaunchScript) => {
    if (!run) return;
    if (!script.python || script.python.interpreter !== null || cwd === null) {
      run(script);
      return;
    }
    const python = script.python;
    void findInterpreters(environmentId, cwd, python.os === "windows").then((interpreters) => {
      setQuery("");
      setPending({ script, interpreters });
    });
  };

  const choose = (interpreter: string) => {
    if (!pending?.script.python || cwd === null || !run) return;
    const { script } = pending;
    const python = script.python!;
    setPending(null);
    void saveInterpreter(environmentId, cwd, interpreter);
    run({
      ...script,
      command: pythonCommand(interpreter, python.tail, python.os, cwd),
      python: { ...python, interpreter },
    });
  };

  const typed = query.trim();
  const items: CommandPaletteActionItem[] = [
    ...(typed
      ? [
          {
            path: typed,
            title: gt('Use "{path}"', { path: typed }),
            description: gt("Enter interpreter path"),
          },
        ]
      : []),
    ...(pending?.interpreters ?? []),
  ].map((interpreter) => ({
    kind: "action",
    value: `python-interpreter:${interpreter.path}`,
    searchTerms: [interpreter.title, interpreter.description],
    title: interpreter.title,
    description: interpreter.description,
    icon: <TerminalIcon className="size-4" />,
    run: async () => choose(interpreter.path),
  }));

  const dialog = (
    <CommandDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
      {pending ? (
        <CommandDialogPopup
          aria-label={gt("Select Python interpreter")}
          className="overflow-hidden"
          onBackdropPointerDown={() => setPending(null)}
        >
          <CommandPaletteContent
            aria-label={gt("Select Python interpreter")}
            autoHighlight="always"
            escapeLabel={gt("Close")}
            footerActionLabel={gt("Select interpreter")}
            inputProps={{
              placeholder: gt('Select interpreter for "{name}", or type a path…', {
                name: pending.script.name,
              }),
            }}
            mode="none"
            onItemHighlighted={(value) => setHighlighted(typeof value === "string" ? value : null)}
            onValueChange={(value) => {
              setHighlighted(null);
              setQuery(value);
            }}
            panelSize="tall-list"
            testId="python-interpreter-picker"
            value={query}
          >
            <CommandPaletteResults
              groups={items.length > 0 ? [{ value: "interpreters", label: "Python", items }] : []}
              highlightedItemValue={highlighted}
              isActionsOnly={false}
              keybindings={keybindings}
              onExecuteItem={(item) => {
                if (item.kind === "action") void item.run();
              }}
              emptyStateMessage={gt("No interpreters found. Type a path.")}
            />
          </CommandPaletteContent>
        </CommandDialogPopup>
      ) : null}
    </CommandDialog>
  );

  return { runScript, dialog };
}
