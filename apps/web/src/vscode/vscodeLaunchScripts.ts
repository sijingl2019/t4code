import type {
  EnvironmentId,
  ExecutionEnvironmentPlatformOs,
  ProjectScript,
} from "@t3tools/contracts";
import { parse } from "jsonc-parser";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

export const VSCODE_LAUNCH_FILE = ".vscode/launch.json";

export interface VscodeLaunchScript {
  readonly name: string;
  readonly command: string;
  readonly cwd: string;
  readonly env: Record<string, string>;
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

/** Node `launch` configurations as terminal commands; everything else (attach, chrome, …) is skipped. */
export function parseVscodeLaunchScripts(
  contents: string,
  workspaceFolder: string,
  os: ExecutionEnvironmentPlatformOs,
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
    if (type === "node-terminal" && typeof config.command === "string") {
      words = [];
    } else if (type === "node" || type === "pwa-node") {
      const exe = typeof config.runtimeExecutable === "string" ? config.runtimeExecutable : "node";
      const program = typeof config.program === "string" ? [config.program] : [];
      if (program.length === 0 && config.runtimeExecutable === undefined) return [];
      words = [exe, ...strings(config.runtimeArgs), ...program, ...strings(config.args)];
    } else {
      return [];
    }
    // The terminal opens at the workspace folder, so relative paths keep commands short.
    words = words.map((word) => folder(word, ".").replace(/^\.\//, "").replace(/^\.\\/, ""));
    const command =
      type === "node-terminal"
        ? folder(config.command as string, ".")
        : words.map((word) => shellWord(word || ".")).join(" ");
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
    return [{ name, command, cwd, env }];
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
    workspaceMutationId,
  );
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  return contents === null || cwd === null
    ? NO_SCRIPTS
    : parseVscodeLaunchScripts(contents, cwd, os);
}

/** Runs in a fresh terminal: a reused one would keep its old env. */
export function runVscodeLaunchScript(
  run: (
    script: ProjectScript,
    options: {
      cwd: string;
      env: Record<string, string>;
      preferNewTerminal: boolean;
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
    { cwd: launch.cwd, env: launch.env, preferNewTerminal: true, rememberAsLastInvoked: false },
  );
}
