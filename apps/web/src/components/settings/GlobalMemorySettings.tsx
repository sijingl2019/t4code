import { useAtomValue } from "@effect/atom-react";
import {
  MAX_GLOBAL_MEMORY_EVERY_MINUTES,
  MAX_GLOBAL_MEMORY_EVERY_TURNS,
  MIN_GLOBAL_MEMORY_EVERY_MINUTES,
  MIN_GLOBAL_MEMORY_EVERY_TURNS,
  type GlobalMemorySettings as GlobalMemorySettingsValue,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useEffect, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";

import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useTextGenerationTargets } from "../../textGenerators";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { useSettingsScope } from "./SettingsScopeContext";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

/** Mounted per environment: memories and their summaries live on that environment's server. */
export function GlobalMemorySettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const memory = settings.globalMemory;
  const update = (patch: Partial<GlobalMemorySettingsValue>) =>
    updateSettings({ globalMemory: patch });

  return (
    <SettingsSection title="Global memory">
      <SettingsRow
        serverScoped
        settingKeys={["globalMemory"]}
        {...searchableSetting("global-memory")}
        description="Periodically distill threads into short memories that agents in any project can search. Each summary is one call to the memory model."
        control={
          <Switch
            checked={memory.enabled}
            onCheckedChange={(enabled) => update({ enabled })}
            aria-label="Enable global memory"
          />
        }
      />
      {memory.enabled ? (
        <>
          <SettingsRow
            title="Summarize every"
            description="Summarize a thread after this many new turns, or this many minutes after its oldest unsummarized turn, whichever comes first."
            control={
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <BoundedNumberInput
                  ariaLabel="Turns between summaries"
                  value={memory.everyTurns}
                  min={MIN_GLOBAL_MEMORY_EVERY_TURNS}
                  max={MAX_GLOBAL_MEMORY_EVERY_TURNS}
                  onCommit={(everyTurns) => update({ everyTurns })}
                />
                turns or
                <BoundedNumberInput
                  ariaLabel="Minutes between summaries"
                  value={memory.everyMinutes}
                  min={MIN_GLOBAL_MEMORY_EVERY_MINUTES}
                  max={MAX_GLOBAL_MEMORY_EVERY_MINUTES}
                  onCommit={(everyMinutes) => update({ everyMinutes })}
                />
                minutes
              </div>
            }
          />
          <MemoryModelRow />
        </>
      ) : null}
      <MemoryCountRow />
    </SettingsSection>
  );
}

/** Commits on blur or Enter, clamped, so typing a two-digit number never saves its first digit. */
function BoundedNumberInput(props: {
  readonly ariaLabel: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const parsed = Number.parseInt(draft, 10);
    setDraft(null);
    if (!Number.isFinite(parsed)) return;
    const next = Math.min(props.max, Math.max(props.min, parsed));
    if (next !== props.value) props.onCommit(next);
  };
  return (
    <div className="w-20">
      <Input
        size="sm"
        type="number"
        aria-label={props.ariaLabel}
        min={props.min}
        max={props.max}
        value={draft ?? String(props.value)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
      />
    </div>
  );
}

function MemoryModelRow() {
  const { environment } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const providersByEnvironment = useEnvironmentProviders();
  const providers =
    (environment?.serverConfig
      ? providersByEnvironment.get(environment.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS;
  const dedicated = settings.globalMemory.modelSelection;
  const targets = useTextGenerationTargets({
    environmentId: environment?.environmentId ?? null,
    settings,
    providers: providers.filter((provider) => provider.supportsTextGeneration !== false),
    projectId: null,
    selections: [dedicated, settings.textGenerationModelSelection],
  });
  const instanceEntries = targets.entries;
  const hasProvider = instanceEntries.some((entry) => entry.enabled && entry.isAvailable);
  const selection = resolveAppModelSelectionState(
    {
      ...settings,
      textGenerationModelSelection: dedicated ?? settings.textGenerationModelSelection,
    },
    targets.providers,
  );
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    targets.providers,
    selection.instanceId,
    selection.model,
  );
  const instanceEntry = instanceEntries.find((entry) => entry.instanceId === selection.instanceId);
  const modelDisabledReason = useScopedModelDisabledReason(settings, instanceEntries);
  const setModel = (next: ReturnType<typeof createModelSelection> | null) => {
    const reason = next === null ? null : modelDisabledReason(next.instanceId, next.model);
    if (reason) {
      toastManager.add({ type: "error", title: "Memory model not saved", description: reason });
      return;
    }
    updateSettings({ globalMemory: { modelSelection: next } });
  };

  return (
    <SettingsRow
      title="Memory model"
      description="Use a cheaper or faster model for summaries. When off, the text generation model configured for this environment is used."
      control={
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          {dedicated !== null && hasProvider && instanceEntry ? (
            <>
              <ProviderModelPicker
                environmentId={environment?.environmentId ?? null}
                activeInstanceId={selection.instanceId}
                model={selection.model}
                lockedProvider={null}
                instanceEntries={instanceEntries}
                modelOptionsByInstance={modelOptionsByInstance}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                getModelDisabledReason={modelDisabledReason}
                onInstanceModelChange={(instanceId, model) =>
                  setModel(createModelSelection(instanceId, model))
                }
              />
              <TraitsPicker
                provider={instanceEntry.driverKind}
                models={instanceEntry.models}
                model={selection.model}
                modelOptions={selection.options ?? []}
                allowPromptInjectedEffort={false}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                onModelOptionsChange={(options) =>
                  setModel(createModelSelection(selection.instanceId, selection.model, options))
                }
              />
            </>
          ) : null}
          <Switch
            checked={dedicated !== null}
            disabled={dedicated === null && !hasProvider}
            onCheckedChange={(checked) =>
              setModel(
                checked
                  ? createModelSelection(
                      settings.textGenerationModelSelection.instanceId,
                      settings.textGenerationModelSelection.model,
                      settings.textGenerationModelSelection.options,
                    )
                  : null,
              )
            }
            aria-label="Use a separate memory model"
          />
        </div>
      }
    />
  );
}

function MemoryCountRow() {
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  // Quiet: a server without global memory (upstream or older) answers with an error every time.
  const getStats = useStableCallback(
    useAtomCommand(serverEnvironment.getMemoryStats, { reportFailure: false }),
  );
  const clearMemory = useAtomCommand(serverEnvironment.clearMemory, { reportFailure: true });
  const canClear = useAtomValue(serverEnvironment.clearMemory.permissionAtom(environmentId));
  const [count, setCount] = useState<number | "unavailable" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the count from the environment's server when the row mounts or the environment changes.
  useEffect(() => {
    if (environmentId === null) return;
    let cancelled = false;
    void getStats({ environmentId, input: {} }).then((result) => {
      if (!cancelled) setCount(result._tag === "Success" ? result.value.count : "unavailable");
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, getStats]);

  const clear = async () => {
    if (environmentId === null) return;
    setClearing(true);
    const result = await clearMemory({ environmentId, input: {} });
    setClearing(false);
    if (result._tag === "Success") {
      setCount(result.value.count);
      setConfirming(false);
    }
  };

  return (
    <SettingsRow
      title="Memories"
      description="Turning global memory off keeps stored memories; agents can search them again once it is back on."
      control={
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground tabular-nums">
            {count === null ? "…" : count === "unavailable" ? "Unavailable" : `${count} stored`}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={!canClear || typeof count !== "number" || count === 0}
            onClick={() => setConfirming(true)}
          >
            Clear all
          </Button>
          <AlertDialog open={confirming} onOpenChange={(open) => !clearing && setConfirming(open)}>
            <AlertDialogPopup>
              <AlertDialogHeader>
                <AlertDialogTitle>Clear all memories?</AlertDialogTitle>
                <AlertDialogDescription>
                  Every stored memory on this environment is deleted. Threads themselves are kept.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose
                  disabled={clearing}
                  render={<Button variant="outline" disabled={clearing} />}
                >
                  Cancel
                </AlertDialogClose>
                <Button variant="destructive" disabled={clearing} onClick={() => void clear()}>
                  Clear all
                </Button>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
        </div>
      }
    />
  );
}
