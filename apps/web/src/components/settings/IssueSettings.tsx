import { useAtomValue } from "@effect/atom-react";
import {
  issueTrackersOf,
  IssueTrackerKind,
  MAX_ISSUE_AUTO_DEV_INTERVAL_MINUTES,
  MIN_ISSUE_AUTO_DEV_INTERVAL_MINUTES,
  type EnvironmentId,
  type IssueProjectBinding,
  type IssueStatusFilter,
  type IssueTrackerConnection,
  type IssueTrackerStatus,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { ChevronDownIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import {
  ISSUE_TRACKER_KIND_LABELS,
  issueTrackerLabel,
  supportedIssueTrackerKind,
  useIssueTrackerCatalog,
} from "../../issues/useIssueTrackerCatalog";
import { randomUUID } from "../../lib/utils";
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

const SECTION_TITLE = "Trackers";
const TRACKER_KINDS = IssueTrackerKind.literals;

export function IssueSettings() {
  const { environment, scope } = useSettingsScope();
  if (scope.kind !== "environment" || !environment) {
    return (
      <SettingsSection title={SECTION_TITLE} id="issues">
        <SettingsScopeNotice target="environment">
          Choose one environment to configure its issue trackers.
        </SettingsScopeNotice>
      </SettingsSection>
    );
  }
  return (
    <IssueSettingsForm key={environment.environmentId} environmentId={environment.environmentId} />
  );
}

function useSaveSettings(environmentId: EnvironmentId) {
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: true });
  return async (patch: ServerSettingsPatch) =>
    (await updateSettings({ environmentId, input: { patch } }))._tag === "Success";
}

function IssueSettingsForm({ environmentId }: { environmentId: EnvironmentId }) {
  const savedTrackers = useScopedSettings((settings) => settings.issueTrackers);
  const legacyOnes = useScopedSettings((settings) => settings.ones);
  const trackers = issueTrackersOf({ issueTrackers: savedTrackers, ones: legacyOnes });
  const canEdit = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  // Trackers added in this session but not saved yet.
  const [added, setAdded] = useState<ReadonlyArray<string>>([]);
  const savedIds = new Set(trackers.map((t) => t.id));
  const unsaved = added.filter((id) => !savedIds.has(id));

  return (
    <SettingsSection title={SECTION_TITLE} id="issues">
      <div className="grid gap-4 px-4 py-4 sm:px-5">
        <p className="text-xs text-muted-foreground">
          Connect issue trackers, bind their projects to T4 projects, and pick issues when starting
          a thread.
        </p>
        {trackers.length === 0 && unsaved.length === 0 ? (
          <p className="text-xs text-muted-foreground">No issue trackers yet.</p>
        ) : null}
        {trackers.map((tracker) => (
          <TrackerCard
            key={tracker.id}
            environmentId={environmentId}
            trackers={trackers}
            tracker={tracker}
            canEdit={canEdit}
          />
        ))}
        {unsaved.map((id) => (
          <TrackerCard
            key={id}
            environmentId={environmentId}
            trackers={trackers}
            tracker={null}
            newId={id}
            canEdit={canEdit}
            onDiscard={() => setAdded((previous) => previous.filter((other) => other !== id))}
          />
        ))}
        <div>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={!canEdit}
            onClick={() => setAdded((previous) => [...previous, randomUUID().slice(0, 8)])}
          >
            <PlusIcon />
            Add tracker
          </Button>
        </div>
        <AutoDevField environmentId={environmentId} canEdit={canEdit} />
      </div>
    </SettingsSection>
  );
}

type Draft = {
  kind: IssueTrackerKind;
  name: string;
  baseUrl: string;
  teamUuid: string;
  email: string;
  password: string;
};

function TrackerCard(props: {
  environmentId: EnvironmentId;
  trackers: ReadonlyArray<IssueTrackerConnection>;
  /** `null` for a tracker added in this session and not saved yet. */
  tracker: IssueTrackerConnection | null;
  newId?: string;
  canEdit: boolean;
  onDiscard?: () => void;
}) {
  const { environmentId, trackers, tracker } = props;
  const id = tracker?.id ?? props.newId!;
  const save = useSaveSettings(environmentId);
  const bindings = useScopedSettings((settings) => settings.issueProjectBindings);
  const autoDev = useScopedSettings((settings) => settings.issueAutoDev);
  const testConnection = useAtomCommand(serverEnvironment.testIssueConnection);
  const supported = tracker !== null && supportedIssueTrackerKind(tracker.kind);
  const configured = supported && tracker.baseUrl !== "" && tracker.email !== "";
  const catalog = useIssueTrackerCatalog(environmentId, configured ? id : null);

  // Secrets come back redacted; an empty draft secret means "keep the saved one".
  const [draft, setDraft] = useState<Draft>(() => ({
    kind: tracker?.kind ?? "ones",
    name: tracker?.name ?? "",
    baseUrl: tracker?.baseUrl ?? "",
    teamUuid: tracker?.teamUuid ?? "",
    email: tracker?.email ?? "",
    password: "",
  }));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => {
    setDraft((previous) => ({ ...previous, ...patch }));
    setMessage(null);
  };
  const passwordSaved =
    tracker !== null && (typeof tracker.password !== "string" || tracker.password !== "");
  const disabled = busy || !props.canEdit;
  const isOnes = draft.kind === "ones";

  /** Writes the full tracker list with this one replaced (or appended). */
  const writeTracker = (next: IssueTrackerConnection | null, extra: ServerSettingsPatch = {}) => {
    const issueTrackers =
      next === null
        ? trackers.filter((t) => t.id !== id)
        : tracker
          ? trackers.map((t) => (t.id === id ? next : t))
          : [...trackers, next];
    return save({ issueTrackers, ...extra });
  };

  const saveConnection = async () => {
    setBusy(true);
    setMessage(null);
    const ok = await writeTracker({
      id,
      kind: draft.kind,
      name: draft.name.trim(),
      baseUrl: draft.baseUrl.trim(),
      teamUuid: draft.kind === "ones" ? draft.teamUuid.trim() : "",
      email: draft.email.trim(),
      password: draft.password === "" ? (tracker?.password ?? "") : draft.password,
      statusFilter: tracker?.statusFilter ?? { mode: "default", statusIds: [] },
      doneStatusId: tracker?.doneStatusId ?? "",
      projectDoneStatusIds: tracker?.projectDoneStatusIds ?? {},
    });
    setBusy(false);
    if (!ok) return;
    setDraft((previous) => ({ ...previous, password: "" }));
    setMessage("Saved.");
    if (tracker) void catalog.reload();
  };

  const remove = async () => {
    if (!tracker) return props.onDiscard?.();
    setBusy(true);
    await writeTracker(null, {
      issueProjectBindings: bindings.filter((b) => b.trackerId !== id),
    });
    setBusy(false);
  };

  const test = async () => {
    setBusy(true);
    const result = await testConnection({ environmentId, input: { trackerId: id } });
    setBusy(false);
    setMessage(
      result._tag === "Success"
        ? `${result.value.ok ? "Connected" : "Failed"}: ${result.value.message}`
        : "Connection test failed.",
    );
    if (result._tag === "Success" && result.value.ok) void catalog.reload();
  };

  return (
    <div className="grid gap-3 rounded-md border p-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {tracker ? issueTrackerLabel(tracker) : "New tracker"}
        </span>
        {autoDev.enabled && catalog.catalog && bindings.some((b) => b.trackerId === id) ? (
          <NextSyncLabel
            lastPollAt={catalog.catalog.lastAutoDevPollAt ?? null}
            intervalMinutes={autoDev.intervalMinutes}
          />
        ) : null}
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={disabled}
          onClick={() => void remove()}
        >
          {tracker ? "Delete" : "Discard"}
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Type">
          <Select
            disabled={disabled}
            value={draft.kind}
            onValueChange={(kind) => kind && set({ kind })}
          >
            <SelectTrigger size="sm" aria-label="Tracker type">
              <SelectValue>
                {(kind: IssueTrackerKind) => ISSUE_TRACKER_KIND_LABELS[kind]}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {TRACKER_KINDS.map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {ISSUE_TRACKER_KIND_LABELS[kind]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </Field>
        <Field label="Name (optional)">
          <Input
            size="sm"
            placeholder={ISSUE_TRACKER_KIND_LABELS[draft.kind]}
            value={draft.name}
            disabled={disabled}
            onChange={(event) => set({ name: event.target.value })}
          />
        </Field>
        <Field label="URL">
          <Input
            size="sm"
            type="url"
            placeholder={isOnes ? "https://ones.example.com" : "https://jira.example.com"}
            value={draft.baseUrl}
            disabled={disabled}
            onChange={(event) => set({ baseUrl: event.target.value })}
          />
        </Field>
        {isOnes ? (
          <Field label="Team UUID (optional)">
            <Input
              size="sm"
              placeholder="First team of the account"
              value={draft.teamUuid}
              disabled={disabled}
              onChange={(event) => set({ teamUuid: event.target.value })}
            />
          </Field>
        ) : null}
        <Field label="Email">
          <Input
            size="sm"
            type="email"
            value={draft.email}
            disabled={disabled}
            onChange={(event) => set({ email: event.target.value })}
          />
        </Field>
        <Field label={isOnes ? "Password" : "API token"}>
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
      {isOnes ? null : (
        <p className="text-xs text-muted-foreground">
          Jira is not supported yet: the connection is saved, but its issues are not fetched.
        </p>
      )}
      <div className="flex items-center justify-between gap-3">
        <p role="status" className="text-xs text-muted-foreground">
          {message}
        </p>
        <div className="flex shrink-0 gap-2">
          {supported ? (
            <Button type="button" size="xs" variant="outline" disabled={disabled} onClick={test}>
              Test connection
            </Button>
          ) : null}
          <Button type="button" size="xs" disabled={disabled} onClick={saveConnection}>
            Save
          </Button>
        </div>
      </div>

      {configured && tracker ? (
        <ProjectBindingsField
          environmentId={environmentId}
          tracker={tracker}
          catalog={catalog}
          disabled={disabled}
          onDoneStatusChange={(trackerProjectId, statusId) => {
            const { [trackerProjectId]: _old, ...rest } = tracker.projectDoneStatusIds;
            void writeTracker({
              ...tracker,
              projectDoneStatusIds:
                statusId === "" ? rest : { ...rest, [trackerProjectId]: statusId },
            });
          }}
        />
      ) : null}
      {configured && tracker && catalog.catalog ? (
        <StatusFilterField
          value={tracker.statusFilter}
          statuses={catalog.catalog.statuses}
          disabled={disabled}
          onChange={(statusFilter) => void writeTracker({ ...tracker, statusFilter })}
        />
      ) : null}
      {configured && tracker && catalog.catalog ? (
        <DoneStatusField
          value={tracker.doneStatusId}
          statuses={catalog.catalog.statuses}
          disabled={disabled}
          onChange={(doneStatusId) => void writeTracker({ ...tracker, doneStatusId })}
        />
      ) : null}
    </div>
  );
}

function ProjectBindingsField(props: {
  environmentId: EnvironmentId;
  tracker: IssueTrackerConnection;
  catalog: ReturnType<typeof useIssueTrackerCatalog>;
  disabled: boolean;
  onDoneStatusChange: (trackerProjectId: string, statusId: string) => void;
}) {
  const { environmentId, tracker, catalog } = props;
  const save = useSaveSettings(environmentId);
  const savedBindings = useScopedSettings((settings) => settings.issueProjectBindings);
  const localProjects = useProjects().filter(
    (project) =>
      project.environmentId === environmentId && !project.isScratch && !project.archivedAt,
  );
  // Bindings save on toggle; the Save button covers the connection fields.
  const toggleBinding = (onesProjectUuid: string, localPath: string, bound: boolean) => {
    const matches = (b: IssueProjectBinding) =>
      b.trackerId === tracker.id &&
      b.onesProjectUuid === onesProjectUuid &&
      b.localPath === localPath;
    const bindings: IssueProjectBinding[] = bound
      ? [...savedBindings, { onesProjectUuid, trackerId: tracker.id, localPath }]
      : savedBindings.filter((b) => !matches(b));
    void save({ issueProjectBindings: bindings });
  };

  return (
    <div className="grid gap-2 border-t pt-3">
      <div className="flex items-center justify-between gap-3">
        <Label>Projects</Label>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Reload tracker projects"
          onClick={() => void catalog.reload()}
        >
          <RefreshCwIcon />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Choose the T4 projects each tracker project's issues belong to. One tracker project can feed
        several T4 projects. The status picker sets where its issues move after auto development,
        overriding the default below.
      </p>
      {catalog.error ? (
        <p className="text-xs text-destructive">{catalog.error}</p>
      ) : catalog.catalog === null ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : catalog.catalog.projects.length === 0 ? (
        <p className="text-xs text-muted-foreground">No projects visible.</p>
      ) : (
        <ul className="grid divide-y rounded-md border">
          {catalog.catalog.projects.map((trackerProject) => {
            const bound = new Set(
              savedBindings
                .filter(
                  (b) => b.trackerId === tracker.id && b.onesProjectUuid === trackerProject.id,
                )
                .map((b) => b.localPath),
            );
            const boundTitles = localProjects
              .filter((project) => bound.has(project.workspaceRoot))
              .map((project) => project.title);
            return (
              <li key={trackerProject.id} className="flex items-center gap-3 px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-sm">{trackerProject.name}</span>
                {catalog.catalog?.statuses.length ? (
                  <div className="w-40 shrink-0">
                    <StatusSelect
                      value={tracker.projectDoneStatusIds[trackerProject.id] ?? ""}
                      statuses={catalog.catalog.statuses}
                      emptyLabel="Default done status"
                      disabled={props.disabled}
                      onChange={(statusId) => props.onDoneStatusChange(trackerProject.id, statusId)}
                    />
                  </div>
                ) : null}
                <Menu>
                  <MenuTrigger
                    disabled={props.disabled}
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
                            toggleBinding(trackerProject.id, project.workspaceRoot, checked)
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
  );
}

function AutoDevField(props: { environmentId: EnvironmentId; canEdit: boolean }) {
  const autoDev = useScopedSettings((settings) => settings.issueAutoDev);
  const save = useSaveSettings(props.environmentId);
  const [interval, setIntervalDraft] = useState(autoDev.intervalMinutes);
  const disabled = !props.canEdit;
  return (
    <div className="grid gap-2 border-t pt-4">
      <div className="flex flex-wrap items-center gap-3">
        <Switch
          checked={autoDev.enabled}
          disabled={disabled}
          aria-label="Auto development"
          onCheckedChange={(checked) => void save({ issueAutoDev: { enabled: Boolean(checked) } })}
        />
        <span className="text-sm">Auto development</span>
        <span className="text-xs text-muted-foreground">every</span>
        <div className="w-20">
          <Input
            size="sm"
            type="number"
            min={MIN_ISSUE_AUTO_DEV_INTERVAL_MINUTES}
            max={MAX_ISSUE_AUTO_DEV_INTERVAL_MINUTES}
            value={interval}
            disabled={disabled}
            aria-label="Poll interval in minutes"
            onChange={(event) => setIntervalDraft(Number(event.target.value))}
            onBlur={() => {
              if (
                Number.isInteger(interval) &&
                interval >= MIN_ISSUE_AUTO_DEV_INTERVAL_MINUTES &&
                interval <= MAX_ISSUE_AUTO_DEV_INTERVAL_MINUTES
              ) {
                if (interval !== autoDev.intervalMinutes) {
                  void save({ issueAutoDev: { intervalMinutes: interval } });
                }
              } else {
                setIntervalDraft(autoDev.intervalMinutes);
              }
            }}
          />
        </div>
        <span className="text-xs text-muted-foreground">minutes</span>
      </div>
      <p className="text-xs text-muted-foreground">
        Issues assigned to you whose description starts with <code>#!t4code</code> start a thread
        automatically using the project's default model. When a run finishes, its summary is posted
        as an issue comment and the changes are committed and pushed with the issue number, title
        and that summary. Other commits from a thread started from an issue use the issue number and
        title as the message, with the description as the body.
      </p>
    </div>
  );
}

/** Polls run on a 5s tick once due, so the next one is the last plus whole intervals. */
function nextAutoDevPollAt(lastPollAt: number | null, intervalMinutes: number, now: number) {
  if (lastPollAt === null) return null;
  const interval = intervalMinutes * 60_000;
  return lastPollAt + Math.max(1, Math.ceil((now - lastPollAt) / interval)) * interval;
}

function NextSyncLabel(props: { lastPollAt: number | null; intervalMinutes: number }) {
  const [now, setNow] = useState(() => Date.now());
  const next = nextAutoDevPollAt(props.lastPollAt, props.intervalMinutes, now);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- re-render when the shown time passes
  useEffect(() => {
    if (next === null) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, next - Date.now()) + 1000);
    return () => clearTimeout(timer);
  }, [next]);
  return (
    <span className="shrink-0 text-xs text-muted-foreground">
      Next sync{" "}
      {next === null
        ? "soon"
        : new Date(next).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
    </span>
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
    <div className="grid gap-2 border-t pt-3">
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

const LEAVE_STATUS = "__leave__";

function DoneStatusField(props: {
  value: string;
  statuses: ReadonlyArray<IssueTrackerStatus>;
  disabled: boolean;
  onChange: (statusId: string) => void;
}) {
  return (
    <div className="grid gap-2 border-t pt-3">
      <Label>Status after auto development</Label>
      <p className="text-xs text-muted-foreground">
        When an auto-development run completes, move the issue to this status unless its project
        picks its own above. Skipped when the issue's workflow has no transition to it from its
        current status.
      </p>
      <div>
        <StatusSelect
          value={props.value}
          statuses={props.statuses}
          emptyLabel="Leave unchanged"
          disabled={props.disabled}
          onChange={props.onChange}
        />
      </div>
    </div>
  );
}

/** Picks one status; `""` is the empty choice shown as `emptyLabel`. */
function StatusSelect(props: {
  value: string;
  statuses: ReadonlyArray<IssueTrackerStatus>;
  emptyLabel: string;
  disabled: boolean;
  onChange: (statusId: string) => void;
}) {
  const names = new Map(props.statuses.map((s) => [s.id, s.name]));
  return (
    <Select
      disabled={props.disabled}
      value={props.value === "" ? LEAVE_STATUS : props.value}
      onValueChange={(value) => {
        const next = !value || value === LEAVE_STATUS ? "" : value;
        if (next !== props.value) props.onChange(next);
      }}
    >
      <SelectTrigger size="sm" aria-label={props.emptyLabel}>
        <SelectValue>
          {(value: string) =>
            value === LEAVE_STATUS ? props.emptyLabel : (names.get(value) ?? value)
          }
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value={LEAVE_STATUS}>{props.emptyLabel}</SelectItem>
        {props.statuses.map((status) => (
          <SelectItem key={status.id} value={status.id}>
            {status.name}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
