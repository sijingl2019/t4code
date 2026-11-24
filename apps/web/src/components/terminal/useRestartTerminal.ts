import type { ScopedThreadRef } from "@t3tools/contracts";
import { useStableCallback } from "../../hooks/useStableCallback";
import { readTerminalRelaunch } from "./terminalRelaunch";
import { type TerminalLaunchLocation, useThreadTerminalActions } from "./useThreadTerminalActions";

/** t4code: respawn a terminal's shell, then rerun the script it was started for (if this client knows it). */
export function useRestartTerminal(threadRef: ScopedThreadRef | null) {
  const terminalActions = useThreadTerminalActions(threadRef);
  return useStableCallback((terminalId: string, fallbackLocation?: TerminalLaunchLocation) => {
    if (!threadRef || !terminalId) return;
    const relaunch = readTerminalRelaunch(threadRef, terminalId);
    const launched = terminalActions.launchTerminal({
      place: () => {},
      terminalId,
      location: relaunch?.location ?? fallbackLocation ?? null,
      ...(relaunch?.extraEnv ? { extraEnv: relaunch.extraEnv } : {}),
      ...(relaunch ? { stopOnSettle: relaunch.stopOnSettle } : {}),
      restart: true,
    });
    if (!launched || !relaunch) return;
    void launched.result.then((result) => {
      if (result._tag === "Success")
        void terminalActions.writeToTerminal(terminalId, relaunch.input);
    });
  });
}
