import { describe, expect, it } from "vite-plus/test";

import { parseVscodeLaunchScripts } from "./vscodeLaunchScripts";

const LAUNCH = `{
  // comments and trailing commas are allowed
  "configurations": [
    {
      "name": "Desktop: dev",
      "type": "node",
      "request": "launch",
      "cwd": "\${workspaceFolder}",
      "program": "\${workspaceFolder}/scripts/dev-runner.ts",
      "args": ["dev:desktop", "two words"],
      "env": { "PATH": "\${workspaceFolder}/bin:\${env:PATH}" },
      "windows": { "env": { "PATH": "\${workspaceFolder}\\\\bin;\${env:PATH}" } },
    },
    { "name": "Renderer", "type": "chrome", "request": "attach", "port": 9222 },
    { "name": "Attach", "type": "node", "request": "attach" },
    { "name": "Current file", "type": "node", "request": "launch", "program": "\${file}" },
    { "name": "Dev", "type": "node-terminal", "request": "launch", "command": "pnpm dev" },
    { "name": "Vite", "type": "node", "request": "launch", "runtimeExecutable": "pnpm", "runtimeArgs": ["vite"] },
  ],
}`;

describe("parseVscodeLaunchScripts", () => {
  it("turns node launch configs into terminal commands", () => {
    expect(parseVscodeLaunchScripts(LAUNCH, "/repo", "linux")).toEqual([
      {
        name: "Desktop: dev",
        command: 'node scripts/dev-runner.ts dev:desktop "two words"',
        cwd: "/repo",
        env: { PATH: "/repo/bin:${env:PATH}" },
      },
      { name: "Dev", command: "pnpm dev", cwd: "/repo", env: {} },
      { name: "Vite", command: "pnpm vite", cwd: "/repo", env: {} },
    ]);
  });

  it("applies the platform override", () => {
    expect(parseVscodeLaunchScripts(LAUNCH, "E:\\repo", "windows")[0]?.env).toEqual({
      PATH: "E:\\repo\\bin;${env:PATH}",
    });
  });

  it("ignores unparseable files", () => {
    expect(parseVscodeLaunchScripts("not json", "/repo", "linux")).toEqual([]);
  });
});
