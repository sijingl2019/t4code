import { hasAutoDevMarker, type Issue } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildIssuePrompt } from "./IssueService.ts";
import { extractImages } from "./OnesClient.ts";

const issue: Issue = {
  uuid: "u1",
  key: "ONES-7",
  number: 7,
  title: "Fix login",
  descriptionText: "  #!auto\nLogin fails on Safari",
  status: "进行中",
  url: "https://ones.example/project/#/team/t/task/u1",
  onesProjectUuid: "p1",
  updatedAt: "",
  comments: [{ author: "Ann", createdAt: "", text: "repro on 17.2" }],
  attachments: [],
};

describe("ONES issues", () => {
  it("detects the #!auto marker only at the start of the description", () => {
    expect(hasAutoDevMarker("#!auto do it")).toBe(true);
    expect(hasAutoDevMarker("\n  #!auto")).toBe(true);
    expect(hasAutoDevMarker("please #!auto")).toBe(false);
    expect(hasAutoDevMarker("")).toBe(false);
  });

  it("builds an auto prompt without the marker and with the no-commit rule", () => {
    const prompt = buildIssuePrompt(issue, { auto: true, attachmentPaths: ["C:/a/1-shot.png"] });
    expect(prompt).toContain("[ONES-7] Fix login");
    expect(prompt).toContain("Login fails on Safari");
    expect(prompt).not.toContain("#!auto");
    expect(prompt).toContain("git commit");
    expect(prompt).toContain("C:/a/1-shot.png");
    expect(prompt).toContain("Ann: repro on 17.2");
  });

  it("builds a manual prompt without the auto constraints", () => {
    expect(buildIssuePrompt(issue, { auto: false })).not.toContain("## 约束");
  });

  it("extracts inline images with presigned src and data-uuid name", () => {
    expect(
      extractImages('<p>x</p><img data-uuid="img1" src="https://s3/a.png?sig=1&amp;x=2">'),
    ).toEqual([{ name: "img1", url: "https://s3/a.png?sig=1&x=2", isImage: true }]);
  });
});
