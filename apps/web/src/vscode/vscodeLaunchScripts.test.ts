import { describe, expect, it } from "vite-plus/test";

import {
  parseVscodeLaunchScripts,
  pythonCommand,
  readPythonInterpreterSetting,
} from "./vscodeLaunchScripts";

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
        command: 'node /repo/scripts/dev-runner.ts dev:desktop "two words"',
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

describe("debugpy configs", () => {
  const PY = `{ "configurations": [
    { "name": "App", "type": "debugpy", "request": "launch", "program": "\${workspaceFolder}/app.py", "args": ["--port", "80"] },
    { "name": "Mod", "type": "debugpy", "request": "launch", "module": "pkg.main", "python": "/opt/py/bin/python" },
    { "name": "Raw", "type": "python", "request": "launch", "program": "x.py", "args": "--a 1" },
    { "name": "Attach", "type": "debugpy", "request": "attach" },
  ] }`;

  it("runs under the configured or settings interpreter, else asks for one", () => {
    const [app, mod, raw, ...rest] = parseVscodeLaunchScripts(PY, "/repo", "linux");
    expect(rest).toEqual([]);
    expect(app?.python).toEqual({
      tail: "/repo/app.py --port 80",
      interpreter: null,
      os: "linux",
    });
    expect(mod?.command).toBe("/opt/py/bin/python -m pkg.main");
    expect(raw?.python?.tail).toBe("x.py --a 1");
    const withSetting = parseVscodeLaunchScripts(
      PY,
      "/repo",
      "linux",
      "${workspaceFolder}/.venv/bin/python",
    );
    expect(withSetting[0]?.command).toBe("/repo/.venv/bin/python /repo/app.py --port 80");
  });

  it("keeps workspace paths absolute when cwd is a subdirectory", () => {
    const [script] = parseVscodeLaunchScripts(
      `{ "configurations": [{
        "name": "Cwd",
        "type": "debugpy",
        "request": "launch",
        "program": "\${workspaceFolder}/backend/main.py",
        "cwd": "\${workspaceFolder}/backend",
        "python": "\${workspaceFolder}/.venv/bin/python"
      }] }`,
      "/repo",
      "linux",
    );
    expect(script).toMatchObject({
      command: "/repo/.venv/bin/python /repo/backend/main.py",
      cwd: "/repo/backend",
      python: { tail: "/repo/backend/main.py" },
    });
  });

  it("reads the interpreter from VS Code settings", () => {
    expect(readPythonInterpreterSetting(`{ // c\n "python.defaultInterpreterPath": "py", }`)).toBe(
      "py",
    );
    expect(readPythonInterpreterSetting("{}")).toBeNull();
  });

  it("quotes interpreter paths per shell", () => {
    expect(pythonCommand("C:\\Program Files\\Py\\python.exe", "a.py", "windows", "E:\\repo")).toBe(
      '& "C:\\Program Files\\Py\\python.exe" a.py',
    );
    expect(
      pythonCommand(
        "${workspaceFolder}\\.venv\\Scripts\\python.exe",
        "a.py",
        "windows",
        "E:\\repo",
      ),
    ).toBe("E:\\repo\\.venv\\Scripts\\python.exe a.py");
    expect(pythonCommand("python", "", "linux", "/repo")).toBe("python");
  });
});
