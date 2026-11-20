import { TranslationSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { detectLanguage, fillPrompt, preprocessText, resolveTargetLanguage } from "./translate.ts";

const defaults = Schema.decodeSync(TranslationSettings)({});
const settings = (patch: Partial<TranslationSettings> = {}) => ({
  ...defaults,
  ...patch,
});

describe("translation", () => {
  it("preprocesses identifiers and soft line breaks", () => {
    const all = settings({
      removeLineBreaks: true,
      splitSnakeCase: true,
      splitCamelCase: true,
      splitPascalCase: true,
      splitKebabCase: true,
    });
    expect(preprocessText("foo_bar fooBar FooBar foo-bar", all)).toBe(
      "foo bar foo bar Foo Bar foo bar",
    );
    expect(preprocessText("one\ntwo\n\nthree", all)).toBe("one two\n\nthree");
    expect(preprocessText("foo_bar\nbaz", settings())).toBe("foo_bar\nbaz");
  });

  it("detects the script and falls back when it already is the target", () => {
    expect(detectLanguage("任务已经完成")).toBe("zh-Hans");
    expect(detectLanguage("これはテストです")).toBe("ja");
    expect(detectLanguage("Task 3 is done")).toBe("en");
    expect(resolveTargetLanguage("zh-Hans", settings())).toBe("en");
    expect(resolveTargetLanguage("en", settings())).toBe("zh-Hans");
  });

  it("fills prompt variables and leaves unknown ones", () => {
    expect(
      fillPrompt("Translate into {target_language}: {text} {other}", {
        text: "hi",
        source: "en",
        target: "zh-Hans",
      }),
    ).toBe("Translate into Simplified Chinese: hi {other}");
  });
});
