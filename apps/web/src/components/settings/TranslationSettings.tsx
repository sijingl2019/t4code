import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_TRANSLATION_PROMPTS,
  TRANSLATION_LANGUAGES,
  TranslationLanguage,
  TranslationReasoningEffort,
  type EnvironmentId,
  type TranslationPrompt,
  type TranslationService,
  type TranslationServiceKind,
  type TranslationSettings as TranslationSettingsValue,
} from "@t3tools/contracts";
import { ArrowDownIcon, ArrowUpIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { randomUUID } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings } from "./useScopedSettings";

const SECTION_TITLE = "Translation";
const KIND_LABELS: Record<TranslationServiceKind, string> = {
  google: "Google",
  openai: "OpenAI compatible",
};
const LANGUAGES = TranslationLanguage.literals;
const EFFORTS = TranslationReasoningEffort.literals;
const PREPROCESS_OPTIONS = [
  {
    key: "removeLineBreaks",
    title: "Remove line breaks",
    description: "Join wrapped lines; blank lines stay paragraph breaks.",
  },
  { key: "splitSnakeCase", title: "Split snake_case", description: "foo_bar becomes foo bar." },
  { key: "splitCamelCase", title: "Split camelCase", description: "fooBar becomes foo bar." },
  { key: "splitPascalCase", title: "Split PascalCase", description: "FooBar becomes Foo Bar." },
  { key: "splitKebabCase", title: "Split kebab-case", description: "foo-bar becomes foo bar." },
] as const;

/** Mounted per environment: translation runs on, and keeps its API keys in, that server. */
export function TranslationSettings() {
  const { environment, scope } = useSettingsScope();
  if (scope.kind !== "environment" || !environment) {
    return (
      <SettingsSection title={SECTION_TITLE}>
        <SettingsScopeNotice target="environment">
          Choose one environment to configure translation.
        </SettingsScopeNotice>
      </SettingsSection>
    );
  }
  return <TranslationSettingsForm environmentId={environment.environmentId} />;
}

function TranslationSettingsForm({ environmentId }: { environmentId: EnvironmentId }) {
  const settings = useScopedSettings((value) => value.translation);
  const canEdit = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: true });
  const save = async (patch: Partial<TranslationSettingsValue>) =>
    (await updateSettings({ environmentId, input: { patch: { translation: patch } } }))._tag ===
    "Success";
  const [editing, setEditing] = useState<TranslationService | null>(null);

  const services = settings.services;
  const saveServices = (next: ReadonlyArray<TranslationService>) => save({ services: next });
  const move = (index: number, by: -1 | 1) => {
    const next = [...services];
    const [item] = next.splice(index, 1);
    if (!item) return;
    next.splice(index + by, 0, item);
    void saveServices(next);
  };
  const addService = (kind: TranslationServiceKind) =>
    setEditing({
      id: randomUUID(),
      kind,
      name: KIND_LABELS[kind],
      enabled: true,
      timeoutMs: 30_000,
      baseUrl: kind === "google" ? "https://translation.googleapis.com" : "",
      apiKey: "",
      model: "",
      temperature: 0,
      reasoningEffort: "",
      customParams: "{}",
      prompts: DEFAULT_TRANSLATION_PROMPTS,
    });

  return (
    <SettingsSection title={SECTION_TITLE}>
      <SettingsRow
        {...searchableSetting("translation")}
        description="Translate selected assistant text into this language."
        control={
          <LanguageSelect
            label="Target language"
            disabled={!canEdit}
            value={settings.targetLanguage}
            onChange={(targetLanguage) => void save({ targetLanguage })}
          />
        }
      />
      <SettingsRow
        title="Fallback language"
        description="Used when the selected text is already in the target language."
        control={
          <LanguageSelect
            label="Fallback language"
            disabled={!canEdit}
            value={settings.fallbackLanguage}
            onChange={(fallbackLanguage) => void save({ fallbackLanguage })}
          />
        }
      />
      {PREPROCESS_OPTIONS.map((option) => (
        <SettingsRow
          key={option.key}
          title={option.title}
          description={option.description}
          control={
            <Switch
              disabled={!canEdit}
              checked={settings[option.key]}
              onCheckedChange={(checked) => void save({ [option.key]: Boolean(checked) })}
              aria-label={option.title}
            />
          }
        />
      ))}
      <SettingsRow
        title="Services"
        description="Every enabled service translates the selection; results show in this order."
        control={
          <Menu>
            <MenuTrigger disabled={!canEdit} render={<Button size="sm" variant="outline" />}>
              <PlusIcon aria-hidden="true" />
              Add service
            </MenuTrigger>
            <MenuPopup>
              <MenuItem onClick={() => addService("google")}>{KIND_LABELS.google}</MenuItem>
              <MenuItem onClick={() => addService("openai")}>{KIND_LABELS.openai}</MenuItem>
            </MenuPopup>
          </Menu>
        }
      >
        {services.length > 0 ? (
          <div className="mt-3 grid gap-2">
            {services.map((service, index) => (
              <div key={service.id} className="flex items-center gap-2 rounded-md border px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{service.name || service.id}</div>
                  <div className="text-xs text-muted-foreground">{KIND_LABELS[service.kind]}</div>
                </div>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Move up"
                  disabled={!canEdit || index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUpIcon aria-hidden="true" />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Move down"
                  disabled={!canEdit || index === services.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDownIcon aria-hidden="true" />
                </Button>
                <Switch
                  disabled={!canEdit}
                  checked={service.enabled}
                  onCheckedChange={(checked) =>
                    void saveServices(
                      services.map((s) =>
                        s.id === service.id ? { ...s, enabled: Boolean(checked) } : s,
                      ),
                    )
                  }
                  aria-label={`Enable ${service.name}`}
                />
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Edit ${service.name}`}
                  disabled={!canEdit}
                  onClick={() => setEditing(service)}
                >
                  <PencilIcon aria-hidden="true" />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Delete ${service.name}`}
                  disabled={!canEdit}
                  onClick={() => void saveServices(services.filter((s) => s.id !== service.id))}
                >
                  <Trash2Icon aria-hidden="true" />
                </Button>
              </div>
            ))}
          </div>
        ) : null}
      </SettingsRow>
      {editing ? (
        <ServiceDialog
          environmentId={environmentId}
          service={editing}
          onClose={() => setEditing(null)}
          onSave={async (next) => {
            const exists = services.some((s) => s.id === next.id);
            const ok = await saveServices(
              exists ? services.map((s) => (s.id === next.id ? next : s)) : [...services, next],
            );
            if (ok) setEditing(null);
          }}
        />
      ) : null}
    </SettingsSection>
  );
}

function LanguageSelect(props: {
  readonly label: string;
  readonly value: TranslationLanguage;
  readonly disabled: boolean;
  readonly onChange: (value: TranslationLanguage) => void;
}) {
  return (
    <Select
      disabled={props.disabled}
      value={props.value}
      onValueChange={(value) => value && props.onChange(value)}
    >
      <SelectTrigger size="sm" aria-label={props.label} className="w-40">
        <SelectValue>
          {(value: TranslationLanguage) => TRANSLATION_LANGUAGES[value].label}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {LANGUAGES.map((language) => (
          <SelectItem key={language} value={language}>
            {TRANSLATION_LANGUAGES[language].label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function Field(props: {
  readonly label: string;
  readonly hint?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label>{props.label}</Label>
      {props.children}
      {props.hint ? <p className="text-xs text-muted-foreground">{props.hint}</p> : null}
    </div>
  );
}

function ServiceDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly service: TranslationService;
  readonly onClose: () => void;
  readonly onSave: (service: TranslationService) => Promise<void>;
}) {
  // A saved key arrives redacted; sending it back keeps the stored one.
  const [draft, setDraft] = useState(props.service);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const translate = useAtomCommand(serverEnvironment.translateText, { reportFailure: false });
  const set = (patch: Partial<TranslationService>) => {
    setDraft((previous) => ({ ...previous, ...patch }));
    setMessage(null);
  };
  const setPrompt = (index: number, patch: Partial<TranslationPrompt> | null) =>
    set({
      prompts:
        patch === null
          ? draft.prompts.filter((_, i) => i !== index)
          : draft.prompts.map((prompt, i) => (i === index ? { ...prompt, ...patch } : prompt)),
    });
  const isOpenAi = draft.kind === "openai";

  const test = async () => {
    setBusy(true);
    setMessage(null);
    const result = await translate({
      environmentId: props.environmentId,
      input: { text: "Hello, world.", service: draft },
    });
    setBusy(false);
    if (result._tag !== "Success") {
      const cause = squashAtomCommandFailure(result);
      setMessage(
        `Failed: ${cause !== null && typeof cause === "object" && "detail" in cause ? String(cause.detail) : String(cause)}`,
      );
      return;
    }
    const first = result.value.results[0];
    setMessage(first?.text !== undefined ? `Connected: ${first.text}` : `Failed: ${first?.error}`);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup className="w-full sm:w-[34rem]">
        <DialogHeader>
          <DialogTitle>{KIND_LABELS[draft.kind]}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-4">
            <Field label="Name">
              <Input size="sm" value={draft.name} onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field label="Timeout (ms)">
              <Input
                size="sm"
                type="number"
                min={1000}
                max={300000}
                value={draft.timeoutMs}
                onChange={(e) =>
                  set({
                    timeoutMs: Math.min(300_000, Math.max(1000, Number(e.target.value) || 30_000)),
                  })
                }
              />
            </Field>
            <Field label="Base URL" hint="The full API base URL, without a trailing slash.">
              <Input
                size="sm"
                placeholder={
                  isOpenAi ? "https://api.openai.com/v1" : "https://translation.googleapis.com"
                }
                value={draft.baseUrl}
                onChange={(e) => set({ baseUrl: e.target.value })}
              />
            </Field>
            <Field
              label="API key"
              hint={isOpenAi ? "May stay empty for local servers." : undefined}
            >
              <Input
                size="sm"
                type="password"
                value={typeof draft.apiKey === "string" ? draft.apiKey : ""}
                onChange={(e) => set({ apiKey: e.target.value })}
              />
            </Field>
            <Field label="Model">
              <Input
                size="sm"
                placeholder={isOpenAi ? "" : "nmt"}
                value={draft.model}
                onChange={(e) => set({ model: e.target.value })}
              />
            </Field>
            {isOpenAi ? (
              <>
                <Field label="Temperature" hint="0 gives stable translations.">
                  <Input
                    size="sm"
                    type="number"
                    step={0.1}
                    min={0}
                    max={2}
                    value={draft.temperature}
                    onChange={(e) => set({ temperature: Number(e.target.value) || 0 })}
                  />
                </Field>
                <Field
                  label="Reasoning effort"
                  hint="Sent as reasoning_effort; Default sends nothing."
                >
                  <Select
                    value={draft.reasoningEffort}
                    onValueChange={(value) => value !== null && set({ reasoningEffort: value })}
                  >
                    <SelectTrigger size="sm" aria-label="Reasoning effort">
                      <SelectValue>
                        {(value: TranslationReasoningEffort) => value || "Default"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {EFFORTS.map((effort) => (
                        <SelectItem key={effort} value={effort}>
                          {effort || "Default"}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </Field>
                <Field
                  label="Custom parameters (JSON)"
                  hint="A JSON object merged into the request body; its keys win."
                >
                  <Textarea
                    size="sm"
                    value={draft.customParams}
                    onChange={(e) => set({ customParams: e.target.value })}
                  />
                </Field>
                <Field
                  label="Prompts"
                  hint="Variables: {source_language}, {target_language}, {detected_source_language}, {text}."
                >
                  <div className="grid gap-3">
                    {draft.prompts.map((prompt, index) => (
                      // oxlint-disable-next-line react/no-array-index-key -- prompts have no identity besides their position
                      <div key={index} className="grid gap-1.5">
                        <div className="flex items-center gap-2">
                          <Select
                            value={prompt.role}
                            onValueChange={(role) => role && setPrompt(index, { role })}
                          >
                            <SelectTrigger size="sm" aria-label="Prompt role" className="flex-1">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectPopup>
                              <SelectItem value="system">system</SelectItem>
                              <SelectItem value="user">user</SelectItem>
                              <SelectItem value="assistant">assistant</SelectItem>
                            </SelectPopup>
                          </Select>
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            aria-label="Remove prompt"
                            onClick={() => setPrompt(index, null)}
                          >
                            <Trash2Icon aria-hidden="true" />
                          </Button>
                        </div>
                        <Textarea
                          size="sm"
                          value={prompt.content}
                          onChange={(e) => setPrompt(index, { content: e.target.value })}
                        />
                      </div>
                    ))}
                    <div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          set({ prompts: [...draft.prompts, { role: "user", content: "" }] })
                        }
                      >
                        Add prompt
                      </Button>
                    </div>
                  </div>
                </Field>
              </>
            ) : null}
            {message ? <p className="text-xs text-muted-foreground">{message}</p> : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => void test()}>
            Test connection
          </Button>
          <div className="flex-1" />
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await props.onSave({ ...draft, name: draft.name.trim() || KIND_LABELS[draft.kind] });
              setBusy(false);
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
