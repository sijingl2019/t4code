import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { SettingsSecretValue } from "./settingsSecretValue.ts";

export const TRANSLATION_LANGUAGES = {
  "zh-Hans": { label: "简体中文", english: "Simplified Chinese", google: "zh-CN" },
  "zh-Hant": { label: "繁體中文", english: "Traditional Chinese", google: "zh-TW" },
  en: { label: "English", english: "English", google: "en" },
  ja: { label: "日本語", english: "Japanese", google: "ja" },
  ko: { label: "한국어", english: "Korean", google: "ko" },
  fr: { label: "Français", english: "French", google: "fr" },
  de: { label: "Deutsch", english: "German", google: "de" },
  es: { label: "Español", english: "Spanish", google: "es" },
  ru: { label: "Русский", english: "Russian", google: "ru" },
} as const;
export const TranslationLanguage = Schema.Literals([
  "zh-Hans",
  "zh-Hant",
  "en",
  "ja",
  "ko",
  "fr",
  "de",
  "es",
  "ru",
]);
export type TranslationLanguage = typeof TranslationLanguage.Type;

export const TranslationServiceKind = Schema.Literals(["google", "openai"]);
export type TranslationServiceKind = typeof TranslationServiceKind.Type;

export const TranslationReasoningEffort = Schema.Literals([
  "",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
]);
export type TranslationReasoningEffort = typeof TranslationReasoningEffort.Type;

export const TranslationPrompt = Schema.Struct({
  role: Schema.Literals(["system", "user", "assistant"]),
  content: Schema.String,
});
export type TranslationPrompt = typeof TranslationPrompt.Type;

export const DEFAULT_TRANSLATION_PROMPTS: ReadonlyArray<TranslationPrompt> = [
  {
    role: "system",
    content:
      "You are a professional translator.\nRules:\n- Output ONLY the translation, no explanation, no quotes.\n- Preserve original formatting, line breaks, and punctuation.\n- For technical terms, keep the English original in parentheses.",
  },
  { role: "user", content: "Translate into {target_language}:\n\n{text}" },
];

/** One translation backend. `apiKey` is kept in the secret store and redacted for clients. */
export const TranslationService = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: TranslationServiceKind,
  name: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 300_000 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(30_000)),
  ),
  baseUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  // `secretSetting` from settings.ts, which imports this module.
  apiKey: SettingsSecretValue.pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
    Schema.annotateKey({ settingsSecret: true }),
  ),
  model: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /** OpenAI-compatible only from here on. */
  temperature: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  /** Empty sends no `reasoning_effort`. */
  reasoningEffort: TranslationReasoningEffort.pipe(
    Schema.withDecodingDefault(Effect.succeed("" as const)),
  ),
  /** A JSON object merged into the request body; its keys win. */
  customParams: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("{}"))),
  prompts: Schema.Array(TranslationPrompt).pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_TRANSLATION_PROMPTS)),
  ),
});
export type TranslationService = typeof TranslationService.Type;

export const TranslationSettings = Schema.Struct({
  targetLanguage: TranslationLanguage.pipe(
    Schema.withDecodingDefault(Effect.succeed("zh-Hans" as const)),
  ),
  /** Used when the detected source language already is the target. */
  fallbackLanguage: TranslationLanguage.pipe(
    Schema.withDecodingDefault(Effect.succeed("en" as const)),
  ),
  removeLineBreaks: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  splitSnakeCase: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  splitCamelCase: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  splitPascalCase: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  splitKebabCase: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  services: Schema.Array(TranslationService).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type TranslationSettings = typeof TranslationSettings.Type;

export const TranslationSettingsPatch = Schema.Struct({
  targetLanguage: Schema.optionalKey(TranslationLanguage),
  fallbackLanguage: Schema.optionalKey(TranslationLanguage),
  removeLineBreaks: Schema.optionalKey(Schema.Boolean),
  splitSnakeCase: Schema.optionalKey(Schema.Boolean),
  splitCamelCase: Schema.optionalKey(Schema.Boolean),
  splitPascalCase: Schema.optionalKey(Schema.Boolean),
  splitKebabCase: Schema.optionalKey(Schema.Boolean),
  services: Schema.optionalKey(Schema.Array(TranslationService)),
});

export const TranslateInput = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(20_000)),
  /** Translate with this (unsaved) service only, e.g. to test it; a redacted key uses the saved one. */
  service: Schema.optionalKey(TranslationService),
});
export type TranslateInput = typeof TranslateInput.Type;

export const TranslateServiceResult = Schema.Struct({
  serviceId: Schema.String,
  name: Schema.String,
  text: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
});
export type TranslateServiceResult = typeof TranslateServiceResult.Type;

export const TranslateResult = Schema.Struct({
  sourceText: Schema.String,
  targetLanguage: TranslationLanguage,
  results: Schema.Array(TranslateServiceResult),
});
export type TranslateResult = typeof TranslateResult.Type;

export class TranslationError extends Schema.TaggedError<TranslationError>()("TranslationError", {
  detail: Schema.String,
}) {}
