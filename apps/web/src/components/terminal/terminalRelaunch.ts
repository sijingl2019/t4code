import type { ScopedThreadRef } from "@t3tools/contracts";
import type { TerminalLaunchLocation } from "./useThreadTerminalActions";

/** What a script terminal ran, so Restart can run it again. Client memory only. */
export interface TerminalRelaunch {
  readonly input: string;
  readonly location: TerminalLaunchLocation;
  readonly extraEnv?: Record<string, string>;
  readonly stopOnSettle: boolean;
}

const relaunches = new Map<string, TerminalRelaunch>();
const keyOf = (target: ScopedThreadRef, terminalId: string) =>
  JSON.stringify([target.environmentId, target.threadId, terminalId]);

export const rememberTerminalRelaunch = (
  target: ScopedThreadRef,
  terminalId: string,
  relaunch: TerminalRelaunch,
) => relaunches.set(keyOf(target, terminalId), relaunch);

export const readTerminalRelaunch = (target: ScopedThreadRef, terminalId: string) =>
  relaunches.get(keyOf(target, terminalId));

export const forgetTerminalRelaunch = (target: ScopedThreadRef, terminalId: string) =>
  relaunches.delete(keyOf(target, terminalId));
