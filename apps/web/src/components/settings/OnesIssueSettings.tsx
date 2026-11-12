import { useAtomValue } from "@effect/atom-react";
import {
  MAX_ISSUE_AUTO_DEV_INTERVAL_MINUTES,
  MIN_ISSUE_AUTO_DEV_INTERVAL_MINUTES,
  type IssueProjectBinding,
  type IssueStatusFilter,
  type IssueTrackerStatus,
} from "@t3tools/contracts";
import { ChevronDownIcon, RefreshCwIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useIssueTrackerCatalog } from "../../issues/useIssueTrackerCatalog";
import { useProjects } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
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
  autoDevEnabled: boolean;
  autoDevIntervalMinutes: number;
};

function OnesIssueForm() {
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const ones = useScopedSettings((settings) => settings.ones);
  const savedBindings = useScopedSettings((settings) => settings.issueProjectBindings);
  const autoDev = useScopedSettings((settings) => settings.issueAutoDev);
  const canEdit = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: true });
  const testConnection = useAtomCommand(serverEnvironment.testIssueConnection);
  const configured = ones.baseUrl !== "" && ones.email !== "";
  const tracker = useIssueTrackerCatalog(environmentId, configured);
  const localProjects = useProjects().filter(
    (project) =>
      project.environmentId === environmentId && !project.isScratch && !project.archivedAt,
  );

  // Secrets come back redacted; an empty draft secret means "keep the saved one".
  const initial = (): Draft => ({
    baseUrl: ones.baseUrl,
    teamUuid: ones.teamUuid,
    email: ones.email,
    password: "",
    autoDevEnabled: autoDev.enabled,
    autoDevIntervalMinutes: autoDev.intervalMinutes,
  });
  const [draft, setDraft] = useState<Draft>(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => {
    setDraft((previous) => ({ ...previous, ...patch }));
    setMessage(null);
  };
  // Bindings save on toggle; the Save button covers the connection fields.
  const toggleBinding = async (onesProjectUuid: string, localPath: string, bound: boolean) => {
    if (!environmentId) return;
    const bindings: IssueProjectBinding[] = bound
      ? [...savedBindings, { onesProjectUuid, localPath }]
      : savedBindings.filter(
          (b) => !(b.onesProjectUuid === onesProjectUuid && b.localPath === localPath),
        );
    await updateSettings({ environmentId, input: { patch: { issueProjectBindings: bindings } } });
  };
  const saveStatusFilter = (statusFilter: IssueStatusFilter) => {
    if (!environmentId) return;
    void updateSettings({ environmentId, input: { patch: { ones: { statusFilter } } } });
  };
  const passwordSaved = typeof ones.password !== "string" || ones.password !== "";
  const disabled = busy || !canEdit;

  const save = async () => {
    if (!environmentId) return;
    setBusy(true);
    setMessage(null);
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
          issueAutoDev: {
            enabled: draft.autoDevEnabled,
            intervalMinutes: draft.autoDevIntervalMinutes,
          },
        },
      },
    });
    if (result._tag === "Success") {
      setDraft((previous) => ({ ...previous, password: "" }));
      setMessage("Saved.");
      void tracker.reload();
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
    if (result._tag === "Success" && result.value.ok) void tracker.reload();
  };

  return (
    <SettingsSection title={SECTION_TITLE} id="ones-issues">
      <div className="grid gap-4 px-4 py-4 sm:px-5">
        <p className="text-xs text-muted-foreground">
          Connect a private ONES deployment, bind ONES projects to T4 projects, and pick issues when
          starting a thread.
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
          Issues assigned to you whose description starts with <code>#!t4code</code> start a thread
          automatically using the project's default model. Agents are told not to commit. While this
          is on, commits from a thread started from an issue use the issue number and title as the
          message, with the description as the body.
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

        {configured ? (
          <div className="grid gap-2 border-t pt-4">
            <div className="flex items-center justify-between gap-3">
              <Label>ONES projects</Label>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label="Reload ONES projects"
                onClick={() => void tracker.reload()}
              >
                <RefreshCwIcon />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Choose the T4 projects each ONES project's issues belong to. One ONES project can feed
              several T4 projects.
            </p>
            {tracker.error ? (
              <p className="text-xs text-destructive">{tracker.error}</p>
            ) : tracker.catalog === null ? (
              <p className="text-xs text-muted-foreground">Loading…</p>
            ) : tracker.catalog.projects.length === 0 ? (
              <p className="text-xs text-muted-foreground">No ONES projects visible.</p>
            ) : (
              <ul className="grid divide-y rounded-md border">
                {tracker.catalog.projects.map((onesProject) => {
                  const bound = new Set(
                    savedBindings
                      .filter((b) => b.onesProjectUuid === onesProject.id)
                      .map((b) => b.localPath),
                  );
                  const boundTitles = localProjects
                    .filter((project) => bound.has(project.workspaceRoot))
                    .map((project) => project.title);
                  return (
                    <li key={onesProject.id} className="flex items-center gap-3 px-3 py-2">
                      <span className="min-w-0 flex-1 truncate text-sm">{onesProject.name}</span>
                      <Menu>
                        <MenuTrigger
                          disabled={disabled}
                          render={<Button type="button" size="xs" variant="outline" />}
                        >
                          <span className="max-w-56 truncate">
                            {boundTitles.length > 0 ? boundTitles.join(", ") : "Select projects"}
                          </span>
                          <ChevronDownIcon />
                        </MenuTrigger>
                        <MenuPopup align="end">
                          {localProjects.length === 0 ? (
                            <p className="px-2 py-1.5 text-xs text-muted-foreground">
                              No projects in this environment.
                            </p>
                          ) : (
                            localProjects.map((project) => (
                              <MenuCheckboxItem
                                key={project.id}
                                checked={bound.has(project.workspaceRoot)}
                                closeOnClick={false}
                                onCheckedChange={(checked) =>
                                  void toggleBinding(onesProject.id, project.workspaceRoot, checked)
                                }
                              >
                                {project.title}
                              </MenuCheckboxItem>
                            ))
                          )}
                        </MenuPopup>
                      </Menu>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : null}

        {configured && tracker.catalog ? (
          <StatusFilterField
            value={ones.statusFilter}
            statuses={tracker.catalog.statuses}
            disabled={disabled}
            onChange={saveStatusFilter}
          />
        ) : null}
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

const STATUS_FILTER_MODES: Record<IssueStatusFilter["mode"], string> = {
  default: "Default (hide done issues)",
  include: "Only these statuses",
  exclude: "All except these statuses",
};

function StatusFilterField(props: {
  value: IssueStatusFilter;
  statuses: ReadonlyArray<IssueTrackerStatus>;
  disabled: boolean;
  onChange: (value: IssueStatusFilter) => void;
}) {
  const { value, statuses } = props;
  const picked = new Set(value.statusIds);
  const pickedNames = statuses.filter((s) => picked.has(s.id)).map((s) => s.name);
  return (
    <div className="grid gap-2 border-t pt-4">
      <Label>Issue statuses</Label>
      <p className="text-xs text-muted-foreground">
        Which of your assigned issues the picker and auto development see. Pick either statuses to
        show or statuses to hide; with none picked the default applies.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          disabled={props.disabled}
          value={value.mode}
          onValueChange={(mode) => {
            // Switching mode clears the list: the same ids would mean the opposite.
            if (mode && mode !== value.mode) props.onChange({ mode, statusIds: [] });
          }}
        >
          <SelectTrigger size="sm" aria-label="Status filter mode">
            <SelectValue>
              {(mode: IssueStatusFilter["mode"]) => STATUS_FILTER_MODES[mode]}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {(Object.keys(STATUS_FILTER_MODES) as IssueStatusFilter["mode"][]).map((mode) => (
              <SelectItem key={mode} value={mode}>
                {STATUS_FILTER_MODES[mode]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {value.mode === "default" ? null : (
          <Menu>
            <MenuTrigger
              disabled={props.disabled}
              render={<Button type="button" size="xs" variant="outline" />}
            >
              <span className="max-w-72 truncate">
                {pickedNames.length > 0 ? pickedNames.join(", ") : "Select statuses"}
              </span>
              <ChevronDownIcon />
            </MenuTrigger>
            <MenuPopup align="start">
              {statuses.map((status) => (
                <MenuCheckboxItem
                  key={status.id}
                  checked={picked.has(status.id)}
                  closeOnClick={false}
                  onCheckedChange={(checked) =>
                    props.onChange({
                      mode: value.mode,
                      statusIds: checked
                        ? [...value.statusIds, status.id]
                        : value.statusIds.filter((id) => id !== status.id),
                    })
                  }
                >
                  {status.name}
                </MenuCheckboxItem>
              ))}
            </MenuPopup>
          </Menu>
        )}
      </div>
    </div>
  );
}
