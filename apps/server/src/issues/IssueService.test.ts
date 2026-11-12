import { hasAutoDevMarker, type Issue } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildIssuePrompt } from "./IssueService.ts";
import { extractImages, OnesClient } from "./OnesClient.ts";

const issue: Issue = {
  uuid: "u1",
  key: "ONES-7",
  number: 7,
  title: "Fix login",
  descriptionText: "  #!auto\nLogin fails on Safari",
  status: "进行中",
  url: "https://ones.example/project/#/team/t/task/u1",
  trackerProjectId: "p1",
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

  it("re-logs in once on 401 and maps ONES projects", async () => {
    let logins = 0;
    let graphqlCalls = 0;
    const fakeFetch = (async (url: string) => {
      if (url.endsWith("/auth/login")) {
        logins++;
        return Response.json({ user: { token: `t${logins}`, uuid: "me" }, teams: [{ uuid: "T" }] });
      }
      graphqlCalls++;
      // The team comes from login, so it must already be in the first request's URL.
      if (!url.includes("/team/T/")) return new Response("", { status: 404 });
      if (graphqlCalls === 1) return new Response("", { status: 401 });
      return Response.json({ data: { projects: [{ uuid: "p1", name: "Qiko" }] } });
    }) as typeof fetch;
    const client = new OnesClient(
      { baseUrl: "https://ones.example/", teamUuid: "", email: "a@b", password: "x" },
      fakeFetch,
    );
    expect(await client.listProjects()).toEqual([{ id: "p1", name: "Qiko" }]);
    expect(logins).toBe(2);
  });

  it("filters listed issues by status: default hides done, include/exclude use status ids", async () => {
    const queries: string[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/auth/login")) {
        return Response.json({ user: { token: "t", uuid: "me" }, teams: [{ uuid: "T" }] });
      }
      queries.push(String(init?.body));
      const task = (uuid: string, status: string, name: string) => ({
        uuid,
        number: 1,
        name: uuid,
        status: { uuid: status, name },
        project: { uuid: "p" },
      });
      return Response.json({
        data: {
          tasks: [
            task("a", "todo", "To Do"),
            task("b", "dev", "研发完成"),
            task("c", "test", "待验证"),
          ],
        },
      });
    }) as typeof fetch;
    const client = new OnesClient(
      { baseUrl: "https://ones.example", teamUuid: "", email: "a@b", password: "x" },
      fakeFetch,
    );
    const uuids = async (filter: Parameters<OnesClient["listMyIssues"]>[0]) =>
      (await client.listMyIssues(filter)).map((issue) => issue.uuid);
    expect(await uuids({ mode: "default", statusIds: [] })).toEqual(["a", "c"]);
    expect(await uuids({ mode: "include", statusIds: ["dev"] })).toEqual(["b"]);
    expect(await uuids({ mode: "exclude", statusIds: ["todo"] })).toEqual(["b", "c"]);
    // Only the default asks ONES to drop the done category.
    expect(queries.map((q) => q.includes("statusCategory_notIn"))).toEqual([true, false, false]);
  });
});
