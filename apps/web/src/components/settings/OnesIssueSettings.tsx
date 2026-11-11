import { useAtomValue } from "@effect/atom-react";
import {
  MAX_ISSUE_AUTO_DEV_INTERVAL_MINUTES,
  MIN_ISSUE_AUTO_DEV_INTERVAL_MINUTES,
  type IssueProjectBinding,
  type IssueSyncBindingsResult,
} from "@t3tools/contracts";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { SettingsSection } from "./settingsLayout";
import { useScopedSettings } from "./useScopedSettings";

const SECTION_TITLE = "ONES issues";

export function OnesIssueSettings() {
  const { environment, scope } = useSettingsScope();
  if (scope.kind !== "environment" || !environment) {
    return (
      <SettingsSection title={SECTION_TITLE} id="ones-issues">
        <SettingsScopeNotice target="environment">
          Choose one environment to configure its ONES connection.
        </SettingsScopeNotice>
      </SettingsSection>
    );
  }
  return <OnesIssueForm key={environment.environmentId} />;
}

type Draft = {
  baseUrl: string;
  teamUuid: string;
  email: string;
  password: string;
  repoUsername: string;
  repoToken: string;
  bindings: IssueProjectBinding[];
  autoDevEnabled: boolean;
  autoDevIntervalMinutes: number;
};

function OnesIssueForm() {
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId;
  const ones = useScopedSettings((settings) => settings.ones);
  const repo = useScopedSettings((settings) => settings.issueRepoCredentials);
  const savedBindings = useScopedSettings((settings) => settings.issueProjectBindings);
  const autoDev = useScopedSettings((settings) => settings.issueAutoDev);
  const canEdit = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId ?? null));
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: true });
  const testConnection = useAtomCommand(serverEnvironment.testIssueConnection);
  const syncBindings = useAtomCommand(serverEnvironment.syncIssueBindings, { reportFailure: true });

  // Secrets come back redacted; an empty draft secret means "keep the saved one".
  const initial = (): Draft => ({
    baseUrl: ones.baseUrl,
    teamUuid: ones.teamUuid,
    email: ones.email,
    password: "",
    repoUsername: repo.username,
    repoToken: "",
    bindings: [...savedBindings],
    autoDevEnabled: autoDev.enabled,
    autoDevIntervalMinutes: autoDev.intervalMinutes,
  });
  const [draft, setDraft] = useState<Draft>(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [syncResult, setSyncResult] = useState<IssueSyncBindingsResult | null>(null);
  const set = (patch: Partial<Draft>) => {
    setDraft((previous) => ({ ...previous, ...patch }));
    setMessage(null);
  };
  const setBinding = (index: number, patch: Partial<IssueProjectBinding>) =>
    set({
      bindings: draft.bindings.map((binding, i) => (i === index ? { ...binding, ...patch } : binding)),
    });
  const passwordSaved = typeof ones.password !== "string" || ones.password !== "";
  const tokenSaved = typeof repo.token !== "string" || repo.token !== "";
  const disabled = busy || !canEdit;

  const save = async () => {
    if (!environmentId) return;
    setBusy(true);
    setMessage(null);
    const bindings = draft.bindings
      .map((binding) => ({
        onesProjectUuid: binding.onesProjectUuid.trim(),
        localPath: binding.localPath.trim(),
        repoUrl: binding.repoUrl.trim(),
      }))
      .filter((binding) => binding.onesProjectUuid !== "" && binding.localPath !== "");
    const result = await updateSettings({
      environmentId,
      input: {
        patch: {
          ones: {
            baseUrl: draft.baseUrl.trim(),
            teamUuid: draft.teamUuid.trim(),
            email: draft.email.trim(),
            ...(draft.password === "" ? {} : { password: draft.password }),
          },
          issueRepoCredentials: {
            username: draft.repoUsername.trim(),
            ...(draft.repoToken === "" ? {} : { token: draft.repoToken }),
          },
          issueProjectBindings: bindings,
          issueAutoDev: {
            enabled: draft.autoDevEnabled,
            intervalMinutes: draft.autoDevIntervalMinutes,
          },
        },
      },
    });
    if (result._tag === "Success") {
      setDraft((previous) => ({ ...previous, password: "", repoToken: "", bindings }));
      // Saving is when new bindings take effect: link or clone their checkouts now.
      const synced = await syncBindings({ environmentId, input: {} });
      if (synced._tag === "Success") setSyncResult(synced.value);
      setMessage("Saved.");
    }
    setBusy(false);
  };

  const test = async () => {
    if (!environmentId) return;
    setBusy(true);
    const result = await testConnection({ environmentId, input: {} });
    setBusy(false);
    setMessage(
      result._tag === "Success"
        ? `${result.value.ok ? "Connected" : "Failed"}: ${result.value.message}`
        : "Connection test failed.",
    );
  };

  return (
    <SettingsSection title={SECTION_TITLE} id="ones-issues">
      <div className="grid gap-4 px-4 py-4 sm:px-5">
        <p className="text-xs text-muted-foreground">
          Connect a private ONES deployment, bind ONES projects to local checkouts, and pick issues
          when starting a thread. Save and test the connection before binding projects.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="ONES URL">
            <Input
              size="sm"
              type="url"
              placeholder="https://ones.example.com"
              value={draft.baseUrl}
              disabled={disabled}
              onChange={(event) => set({ baseUrl: event.target.value })}
            />
          </Field>
          <Field label="Team UUID (optional)">
            <Input
              size="sm"
              placeholder="First team of the account"
              value={draft.teamUuid}
              disabled={disabled}
              onChange={(event) => set({ teamUuid: event.target.value })}
            />
          </Field>
          <Field label="Email">
            <Input
              size="sm"
              type="email"
              value={draft.email}
              disabled={disabled}
              onChange={(event) => set({ email: event.target.value })}
            />
          </Field>
          <Field label="Password">
            <Input
              size="sm"
              type="password"
              placeholder={passwordSaved ? "Saved (leave empty to keep)" : ""}
              value={draft.password}
              disabled={disabled}
              onChange={(event) => set({ password: event.target.value })}
            />
          </Field>
          <Field label="Repository username (Bitbucket)">
            <Input
              size="sm"
              value={draft.repoUsername}
              disabled={disabled}
              onChange={(event) => set({ repoUsername: event.target.value })}
            />
          </Field>
          <Field label="Repository access token">
            <Input
              size="sm"
              type="password"
              placeholder={tokenSaved ? "Saved (leave empty to keep)" : ""}
              value={draft.repoToken}
              disabled={disabled}
              onChange={(event) => set({ repoToken: event.target.value })}
            />
          </Field>
        </div>

        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-3">
            <Label>Project bindings</Label>
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={disabled}
              onClick={() =>
                set({
                  bindings: [...draft.bindings, { onesProjectUuid: "", localPath: "", repoUrl: "" }],
                })
              }
            >
              <PlusIcon />
              Add binding
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            The ONES project UUID is in the project URL (…/project/&lt;uuid&gt;). A missing local
            directory is cloned from the repository URL and added to the project list.
          </p>
          {draft.bindings.map((binding, index) => (
            <div key={index} className="grid items-center gap-2 sm:grid-cols-[1fr_1.4fr_1.4fr_auto]">
              <Input
                size="sm"
                aria-label="ONES project UUID"
                placeholder="ONES project UUID"
                value={binding.onesProjectUuid}
                disabled={disabled}
                onChange={(event) => setBinding(index, { onesProjectUuid: event.target.value })}
              />
              <Input
                size="sm"
                aria-label="Local directory"
                placeholder="Local directory, e.g. E:\\code\\app"
                value={binding.localPath}
                disabled={disabled}
                onChange={(event) => setBinding(index, { localPath: event.target.value })}
              />
              <Input
                size="sm"
                aria-label="Repository URL"
                placeholder="Repository URL (when the directory is missing)"
                value={binding.repoUrl}
                disabled={disabled}
                onChange={(event) => setBinding(index, { repoUrl: event.target.value })}
              />
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Remove binding"
                disabled={disabled}
                onClick={() => set({ bindings: draft.bindings.filter((_, i) => i !== index) })}
              >
                <Trash2Icon />
              </Button>
            </div>
          ))}
          {syncResult && syncResult.length > 0 ? (
            <ul className="grid gap-0.5 text-xs text-muted-foreground">
              {syncResult.map((entry) => (
                <li key={entry.localPath}>
                  {entry.localPath}: {entry.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Switch
            checked={draft.autoDevEnabled}
            disabled={disabled}
            aria-label="Auto development"
            onCheckedChange={(checked) => set({ autoDevEnabled: Boolean(checked) })}
          />
          <span className="text-sm">Auto development</span>
          <span className="text-xs text-muted-foreground">every</span>
          <div className="w-20">
          <Input
            size="sm"
            type="number"
            min={MIN_ISSUE_AUTO_DEV_INTERVAL_MINUTES}
            max={MAX_ISSUE_AUTO_DEV_INTERVAL_MINUTES}
            value={draft.autoDevIntervalMinutes}
            disabled={disabled}
            aria-label="Poll interval in minutes"
            onChange={(event) => {
              const value = Number(event.target.value);
              if (
                Number.isInteger(value) &&
                value >= MIN_ISSUE_AUTO_DEV_INTERVAL_MINUTES &&
                value <= MAX_ISSUE_AUTO_DEV_INTERVAL_MINUTES
              ) {
                set({ autoDevIntervalMinutes: value });
              }
            }}
          />
          </div>
          <span className="text-xs text-muted-foreground">minutes</span>
        </div>
        <p className="-mt-2 text-xs text-muted-foreground">
          Issues assigned to you whose description starts with <code>#!auto</code> start a thread
          automatically using the project's default model. Agents are told not to commit.
        </p>

        <div className="flex items-center justify-between gap-3">
          <p role="status" className="text-xs text-muted-foreground">
            {message}
          </p>
          <div className="flex shrink-0 gap-2">
            <Button type="button" size="xs" variant="outline" disabled={disabled} onClick={test}>
              Test connection
            </Button>
            <Button type="button" size="xs" disabled={disabled} onClick={save}>
              Save
            </Button>
          </div>
        </div>
      </div>
    </SettingsSection>
  );
}

function Field(props: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1.5">
      <span className="text-xs font-medium text-foreground">{props.label}</span>
      {props.children}
    </label>
  );
}
