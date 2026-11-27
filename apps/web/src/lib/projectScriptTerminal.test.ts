import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { findActionTerminal, rememberActionTerminal } from "./actionTerminal";
import { findReusableProjectScriptTerminal } from "./projectScriptTerminal";

const target = scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("thread-1"));

describe("findActionTerminal", () => {
  it.each([
    {
      name: "reuses a running terminal owned by the action",
      terminalId: "term-1",
      drawerTerminalIds: ["term-1"],
      panelTerminalIds: [] as string[],
      closingTerminalIds: [] as string[],
      expected: "term-1",
    },
    {
      name: "does not reuse a panel-owned terminal",
      terminalId: "term-1",
      drawerTerminalIds: ["term-1"],
      panelTerminalIds: ["term-1"],
      closingTerminalIds: [] as string[],
      expected: null,
    },
    {
      name: "does not reuse a terminal whose close is still pending",
      terminalId: "term-1",
      drawerTerminalIds: ["term-1"],
      panelTerminalIds: [] as string[],
      closingTerminalIds: ["term-1"],
      expected: null,
    },
    {
      name: "does not reuse a terminal that is no longer in the drawer",
      terminalId: "term-1",
      drawerTerminalIds: [],
      panelTerminalIds: [] as string[],
      closingTerminalIds: [] as string[],
      expected: null,
    },
  ])(
    "$name",
    ({ terminalId, drawerTerminalIds, panelTerminalIds, closingTerminalIds, expected }) => {
      const actionId = `action-${terminalId}-${panelTerminalIds.length}-${closingTerminalIds.length}`;
      rememberActionTerminal(target, actionId, terminalId);
      expect(
        findActionTerminal({
          target,
          actionId,
          drawerTerminalIds,
          panelTerminalIds: new Set(panelTerminalIds),
          closingTerminalIds,
        }),
      ).toBe(expected);
    },
  );
});

describe("findReusableProjectScriptTerminal", () => {
  it.each([
    {
      name: "never reuses a right-panel terminal, even when stale in drawer state",
      drawerTerminalIds: ["term-1"],
      activeTerminalId: "term-1",
      panelTerminalIds: ["term-1"],
      runningTerminalIds: [],
      expected: null,
    },
    {
      name: "reuses the active idle drawer terminal",
      drawerTerminalIds: ["term-1", "term-2"],
      activeTerminalId: "term-2",
      panelTerminalIds: [],
      runningTerminalIds: [],
      expected: "term-2",
    },
    {
      name: "falls back to another idle drawer terminal when the active one is busy",
      drawerTerminalIds: ["term-1", "term-2"],
      activeTerminalId: "term-1",
      panelTerminalIds: [],
      runningTerminalIds: ["term-1"],
      expected: "term-2",
    },
    {
      name: "finds nothing when every drawer terminal is busy",
      drawerTerminalIds: ["term-1"],
      activeTerminalId: "term-1",
      panelTerminalIds: [],
      runningTerminalIds: ["term-1"],
      expected: null,
    },
    {
      name: "skips an idle terminal whose close is still pending",
      drawerTerminalIds: ["term-1"],
      activeTerminalId: "term-1",
      panelTerminalIds: [],
      runningTerminalIds: [],
      closingTerminalIds: ["term-1"],
      expected: null,
    },
  ])("$name", ({ panelTerminalIds, closingTerminalIds = [], expected, ...input }) => {
    expect(
      findReusableProjectScriptTerminal({
        ...input,
        panelTerminalIds: new Set(panelTerminalIds),
        closingTerminalIds,
      }),
    ).toBe(expected);
  });
});
