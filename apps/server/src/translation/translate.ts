import {
  settingsSecretLiteral,
  TRANSLATION_LANGUAGES,
  TranslationError,
  type TranslateInput,
  type TranslateResult,
  type TranslateServiceResult,
  type TranslationLanguage,
  type TranslationService,
  type TranslationSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { SECRET_REDACTED } from "../settingsSecrets.ts";

export function preprocessText(text: string, settings: TranslationSettings): string {
  let next = text;
  if (settings.removeLineBreaks) {
    // Single line breaks are soft wraps; blank lines stay paragraph breaks.
    next = next
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.replace(/\s*\n\s*/g, " "))
      .join("\n\n");
  }
  if (settings.splitSnakeCase) next = next.replace(/([A-Za-z0-9])_+(?=[A-Za-z0-9])/g, "$1 ");
  if (settings.splitKebabCase) next = next.replace(/([A-Za-z0-9])-+(?=[A-Za-z])/g, "$1 ");
  if (settings.splitPascalCase) {
    next = next.replace(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g, (word) =>
      word.replace(/([a-z0-9])([A-Z])/g, "$1 $2"),
    );
  }
  if (settings.splitCamelCase) {
    next = next.replace(/\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+\b/g, (word) =>
      word.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase(),
    );
  }
  return next;
}

// ponytail: script-based guess; Latin-script languages other than English read as English.
export function detectLanguage(text: string): TranslationLanguage {
  const count = (pattern: RegExp) => text.match(pattern)?.length ?? 0;
  const kana = count(/[぀-ヿ]/g);
  const hangul = count(/[가-힯]/g);
  const han = count(/\p{Script=Han}/gu);
  const cyrillic = count(/\p{Script=Cyrillic}/gu);
  const latin = count(/\p{Script=Latin}/gu);
  const max = Math.max(kana, hangul, han, cyrillic, latin);
  if (max === 0 || max === latin) return "en";
  if (max === kana || (kana > 0 && max === han)) return "ja";
  if (max === hangul) return "ko";
  if (max === cyrillic) return "ru";
  return "zh-Hans";
}

const sameLanguage = (a: TranslationLanguage, b: TranslationLanguage) =>
  a === b || (a.startsWith("zh") && b.startsWith("zh"));

export function resolveTargetLanguage(
  detected: TranslationLanguage,
  settings: TranslationSettings,
): TranslationLanguage {
  return sameLanguage(detected, settings.targetLanguage)
    ? settings.fallbackLanguage
    : settings.targetLanguage;
}

export function fillPrompt(
  template: string,
  values: { text: string; source: TranslationLanguage; target: TranslationLanguage },
): string {
  const vars: Record<string, string> = {
    text: values.text,
    source_language: TRANSLATION_LANGUAGES[values.source].english,
    detected_source_language: TRANSLATION_LANGUAGES[values.source].english,
    target_language: TRANSLATION_LANGUAGES[values.target].english,
  };
  return template.replace(/\{(\w+)\}/g, (match, name: string) => vars[name] ?? match);
}

const trimSlash = (url: string) => url.replace(/\/+$/, "");

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  ms: number,
  fetchImpl: typeof fetch = fetch,
) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ms),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${raw.slice(0, 300)}`);
  return JSON.parse(raw) as unknown;
}

async function callService(
  service: TranslationService,
  text: string,
  source: TranslationLanguage,
  target: TranslationLanguage,
): Promise<string> {
  const apiKey = settingsSecretLiteral(service.apiKey);
  if (service.kind === "google") {
    const base = trimSlash(service.baseUrl || "https://translation.googleapis.com");
    const json = (await postJson(
      `${base}/language/translate/v2?key=${encodeURIComponent(apiKey)}`,
      {
        q: text,
        target: TRANSLATION_LANGUAGES[target].google,
        format: "text",
        ...(service.model ? { model: service.model } : {}),
      },
      {},
      service.timeoutMs,
    )) as { data?: { translations?: Array<{ translatedText?: string }> } };
    const translated = json.data?.translations?.[0]?.translatedText;
    if (translated === undefined) throw new Error("Google returned no translation.");
    return translated;
  }
  if (!service.baseUrl) throw new Error("Base URL is required.");
  if (!service.model) throw new Error("Model is required.");
  let custom: unknown;
  try {
    custom = JSON.parse(service.customParams || "{}");
  } catch {
    throw new Error("Custom parameters are not valid JSON.");
  }
  if (custom === null || typeof custom !== "object" || Array.isArray(custom)) {
    throw new Error("Custom parameters must be a JSON object.");
  }
  // ponytail: non-streaming; the popover shows the whole result at once.
  const json = (await postJson(
    `${trimSlash(service.baseUrl)}/chat/completions`,
    {
      model: service.model,
      temperature: service.temperature,
      messages: service.prompts.map((prompt) => ({
        role: prompt.role,
        content: fillPrompt(prompt.content, { text, source, target }),
      })),
      ...(service.reasoningEffort ? { reasoning_effort: service.reasoningEffort } : {}),
      ...custom,
      stream: false,
    },
    apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    service.timeoutMs,
  )) as { choices?: Array<{ message?: { content?: string } }> };
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("The service returned no message.");
  return content.trim();
}

export const translateText = Effect.fn("Translation.translate")(function* (
  settings: TranslationSettings,
  input: TranslateInput,
) {
  const services = input.service
    ? [
        input.service.apiKey === SECRET_REDACTED
          ? {
              ...input.service,
              apiKey: settings.services.find((s) => s.id === input.service?.id)?.apiKey ?? "",
            }
          : input.service,
      ]
    : settings.services.filter((service) => service.enabled);
  if (services.length === 0) {
    return yield* new TranslationError({
      detail: "No translation service is enabled. Add one in Settings → Translation.",
    });
  }
  const sourceText = preprocessText(input.text, settings).trim();
  const source = detectLanguage(sourceText);
  const target = resolveTargetLanguage(source, settings);
  const results = yield* Effect.forEach(
    services,
    (service) =>
      Effect.promise(() =>
        callService(service, sourceText, source, target).then(
          (text): TranslateServiceResult => ({ serviceId: service.id, name: service.name, text }),
          (error: unknown): TranslateServiceResult => ({
            serviceId: service.id,
            name: service.name,
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      ),
    { concurrency: "unbounded" },
  );
  return { sourceText, targetLanguage: target, results } satisfies TranslateResult;
});
