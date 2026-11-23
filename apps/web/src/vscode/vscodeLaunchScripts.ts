import type {
  EnvironmentId,
  ExecutionEnvironmentPlatformOs,
  ProjectScript,
} from "@t3tools/contracts";
import { parse } from "jsonc-parser";
import { useEffect, useEffectEvent } from "react";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const VSCODE_LAUNCH_FILE = ".vscode/launch.json";
export const VSCODE_SETTINGS_FILE = ".vscode/settings.json";
export const PYTHON_INTERPRETER_SETTING = "python.defaultInterpreterPath";

export interface VscodeLaunchScript {
  readonly name: string;
  readonly command: string;
  readonly cwd: string;
  readonly env: Record<string, string>;
  /** debugpy configs: `interpreter` null means none is configured yet. */
  readonly python?: {
    readonly tail: string;
    readonly interpreter: string | null;
    readonly os: ExecutionEnvironmentPlatformOs;
  };
}

type LaunchConfig = Record<string, unknown>;

const PLATFORM_KEY: Partial<Record<ExecutionEnvironmentPlatformOs, string>> = {
  windows: "windows",
  darwin: "osx",
  linux: "linux",
};

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

// Bash and PowerShell both accept a double-quoted word; only quote when needed.
const shellWord = (word: string) => (/^[\w./:=@%+,-]+$/.test(word) ? word : `"${word}"`);

const workspacePath = (value: string, workspaceFolder: string) =>
  value.replaceAll("${workspaceFolder}", workspaceFolder);

/** The interpreter as the first word of a terminal command. */
export function pythonCommand(
  interpreter: string,
  tail: string,
  os: ExecutionEnvironmentPlatformOs,
  workspaceFolder: string,
): string {
  let exe = workspacePath(interpreter, workspaceFolder);
  // A relative path needs `./` to run as a command, `.venv/...` included.
  if (!/^(\.{1,2}[\\/]|[\\/]|[A-Za-z]:)/.test(exe) && /[\\/]/.test(exe)) exe = `./${exe}`;
  // PowerShell takes `\` literally; bash would read it as an escape.
  const safe = os === "windows" ? /^[\w./\\:=@%+,-]+$/ : /^[\w./:=@%+,-]+$/;
  const quoted = !safe.test(exe);
  const word = quoted ? `"${exe}"` : exe;
  // ponytail: Windows terminals are assumed to be PowerShell, which runs a quoted path only after `&`.
  const head = quoted && os === "windows" ? `& ${word}` : word;
  return tail ? `${head} ${tail}` : head;
}

export function readPythonInterpreterSetting(contents: string | null): string | null {
  if (contents === null) return null;
  const settings: unknown = parse(contents, [], { allowTrailingComma: true });
  if (typeof settings !== "object" || settings === null) return null;
  const record = settings as Record<string, unknown>;
  for (const key of [PYTHON_INTERPRETER_SETTING, "python.pythonPath"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** Node `launch` configurations as terminal commands; everything else (attach, chrome, …) is skipped. */
export function parseVscodeLaunchScripts(
  contents: string,
  workspaceFolder: string,
  os: ExecutionEnvironmentPlatformOs,
  defaultInterpreter: string | null = null,
): VscodeLaunchScript[] {
  const file: unknown = parse(contents, [], { allowTrailingComma: true });
  if (typeof file !== "object" || file === null) return [];
  const configurations = (file as { configurations?: unknown }).configurations;
  if (!Array.isArray(configurations)) return [];
  const platformKey = PLATFORM_KEY[os];
  const folder = (value: string, replacement: string) =>
    value.replaceAll("${workspaceFolder}", replacement);

  return configurations.flatMap((raw): VscodeLaunchScript[] => {
    if (typeof raw !== "object" || raw === null) return [];
    const base = raw as LaunchConfig;
    const override = platformKey ? base[platformKey] : undefined;
    const config: LaunchConfig =
      typeof override === "object" && override !== null ? { ...base, ...override } : base;
    const { name, type, request } = config;
    if (typeof name !== "string" || request !== "launch") return [];

    let words: string[];
    let rawArgs: string | null = null;
    const isPython = type === "debugpy" || type === "python";
    if (isPython) {
      // No debug adapter here, so debugpy configs run under the plain interpreter.
      const target =
        typeof config.module === "string"
          ? ["-m", config.module]
          : typeof config.program === "string"
            ? [config.program]
            : null;
      if (target === null) return [];
      words = [...strings(config.pythonArgs), ...target, ...strings(config.args)];
      // A string `args` is passed to the shell as typed.
      if (typeof config.args === "string" && config.args.trim()) rawArgs = config.args.trim();
    } else if (type === "node-terminal" && typeof config.command === "string") {
      words = [];
    } else if (type === "node" || type === "pwa-node") {
      const exe = typeof config.runtimeExecutable === "string" ? config.runtimeExecutable : "node";
      const program = typeof config.program === "string" ? [config.program] : [];
      if (program.length === 0 && config.runtimeExecutable === undefined) return [];
      words = [exe, ...strings(config.runtimeArgs), ...program, ...strings(config.args)];
    } else {
      return [];
    }
    // `cwd` may be a subdirectory, so workspace paths must stay absolute in the command.
    words = words.map((word) => folder(word, workspaceFolder));
    const joined = [
      ...words.map((word) => shellWord(word || ".")),
      ...(rawArgs ? [folder(rawArgs, workspaceFolder)] : []),
    ].join(" ");
    const interpreter = isPython
      ? typeof config.python === "string"
        ? config.python
        : defaultInterpreter
      : null;
    const command =
      type === "node-terminal"
        ? folder(config.command as string, workspaceFolder)
        : isPython
          ? interpreter === null
            ? joined
            : pythonCommand(interpreter, joined, os, workspaceFolder)
          : joined;
    // Other VS Code variables (`${file}`, inputs) have no meaning outside the editor.
    if (/\$\{(?!env:)/.test(command)) return [];

    const env: Record<string, string> = {};
    if (typeof config.env === "object" && config.env !== null) {
      for (const [key, value] of Object.entries(config.env)) {
        if (typeof value === "string") env[key] = folder(value, workspaceFolder);
      }
    }
    const cwd =
      typeof config.cwd === "string" ? folder(config.cwd, workspaceFolder) : workspaceFolder;
    return [
      {
        name,
        command,
        cwd,
        env,
        ...(isPython ? { python: { tail: joined, interpreter, os } } : {}),
      },
    ];
  });
}

const NO_SCRIPTS: ReadonlyArray<VscodeLaunchScript> = [];

export function useVscodeLaunchScripts(
  environmentId: EnvironmentId,
  cwd: string | null,
  os: ExecutionEnvironmentPlatformOs,
  workspaceMutationId?: string | null,
): ReadonlyArray<VscodeLaunchScript> {
  const query = useProjectFileQuery(
    environmentId,
    cwd ?? "",
    VSCODE_LAUNCH_FILE,
    cwd !== null,
    undefined,
    workspaceMutationId,
  );
  const settings = useProjectFileQuery(
    environmentId,
    cwd ?? "",
    VSCODE_SETTINGS_FILE,
    cwd !== null,
    undefined,
    workspaceMutationId,
  );
  const refreshOnReturn = useEffectEvent(() => {
    query.refresh();
    settings.refresh();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes edits made in another app
  useEffect(() => {
    if (cwd === null) return;
    const refresh = () => refreshOnReturn();
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [cwd]);
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  return contents === null || cwd === null
    ? NO_SCRIPTS
    : parseVscodeLaunchScripts(
        contents,
        cwd,
        os,
        readPythonInterpreterSetting(settings.data?.contents ?? null),
      );
}

/** Runs in a fresh terminal: a reused one would keep its old env. */
export function runVscodeLaunchScript(
  run: (
    script: ProjectScript,
    options: {
      cwd: string;
      env: Record<string, string>;
      preferNewTerminal: boolean;
      pairTerminal: boolean;
      rememberAsLastInvoked: boolean;
    },
  ) => unknown,
  launch: VscodeLaunchScript,
): void {
  void run(
    {
      id: `vscode-launch-${launch.name}`,
      name: launch.name,
      command: launch.command,
      icon: "debug",
      runOnWorktreeCreate: false,
    },
    {
      cwd: launch.cwd,
      env: launch.env,
      preferNewTerminal: true,
      pairTerminal: true,
      rememberAsLastInvoked: false,
    },
  );
}
