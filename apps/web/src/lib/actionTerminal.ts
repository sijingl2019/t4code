import type { ScopedThreadRef } from "@t3tools/contracts";

const actionTerminalIds = new Map<string, string>();

const actionKey = (target: ScopedThreadRef, actionId: string) =>
  JSON.stringify([target.environmentId, target.threadId, actionId]);

/** Remember the drawer terminal owned by an Action, so rerunning it can replace the process. */
export function rememberActionTerminal(
  target: ScopedThreadRef,
  actionId: string,
  terminalId: string,
) {
  actionTerminalIds.set(actionKey(target, actionId), terminalId);
}

export function forgetActionTerminal(target: ScopedThreadRef, actionId: string) {
  actionTerminalIds.delete(actionKey(target, actionId));
}

// t4code: the Actions menu marks an action running while its terminal runs a process.
export const actionTerminalId = (target: ScopedThreadRef, actionId: string) =>
  actionTerminalIds.get(actionKey(target, actionId)) ?? null;

export function findActionTerminal(input: {
  readonly target: ScopedThreadRef;
  readonly actionId: string;
  readonly drawerTerminalIds: ReadonlyArray<string>;
  readonly panelTerminalIds: ReadonlySet<string>;
  readonly closingTerminalIds: ReadonlyArray<string>;
}): string | null {
  const key = actionKey(input.target, input.actionId);
  const terminalId = actionTerminalIds.get(key);
  if (terminalId === undefined) return null;
  if (
    !input.drawerTerminalIds.includes(terminalId) ||
    input.panelTerminalIds.has(terminalId) ||
    input.closingTerminalIds.includes(terminalId)
  ) {
    actionTerminalIds.delete(key);
    return null;
  }
  return terminalId;
}
