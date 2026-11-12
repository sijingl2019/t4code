// @effect-diagnostics globalDate:off - plain Promise client wrapped by IssueService.
/**
 * ONES (private deployment) adapter. Endpoints and fields were verified against a real server;
 * see docs/ones-api-notes.md in the kika project before changing them.
 */
import type {
  Issue,
  IssueAttachmentRef,
  IssueStatusFilter,
  IssueTrackerProject,
  IssueTrackerStatus,
} from "@t3tools/contracts";

import {
  IssueTrackerClient,
  IssueTrackerClientError,
  type Json as J,
} from "./IssueTrackerClient.ts";

export interface OnesConnection {
  readonly baseUrl: string;
  readonly teamUuid: string;
  readonly email: string;
  readonly password: string;
}

const LIMIT = 500;
const LIST_QUERY = (user: string, filtered: boolean): string =>
  `{ tasks(filter: { assign_in: ["${user}"]${filtered ? ', statusCategory_notIn: ["done"]' : ""} }, limit: ${LIMIT}) { uuid number name status{uuid name} project{uuid} descriptionText serverUpdateStamp } }`;
// The verified query has no status category, so done tasks are also filtered by name.
const DONE_NAME = /^(?![未待]).*(完成|关闭|取消|已发布|done|closed|resolved)$/i;

const iso = (us: unknown): string =>
  typeof us === "number" ? new Date(Math.floor(us / 1000)).toISOString() : "";

/** Inline images in ONES rich text: presigned src plus data-uuid (used as the name). */
export function extractImages(html: string): IssueAttachmentRef[] {
  const out: IssueAttachmentRef[] = [];
  for (const m of (html ?? "").matchAll(/<img\b[^>]*>/gi)) {
    const src = m[0].match(/\bsrc="([^"]+)"/i)?.[1]?.replace(/&amp;/g, "&");
    if (!src) continue;
    const name =
      m[0].match(/\bdata-uuid="([^"]+)"/i)?.[1] ?? src.split("?")[0]?.split("/").pop() ?? "image";
    out.push({ name, url: src, isImage: true });
  }
  return out;
}

export class OnesClient extends IssueTrackerClient {
  private token = "";
  private userUuid = "";
  private team: string;
  private filtered = true;
  private readonly connection: OnesConnection;

  constructor(connection: OnesConnection, fetchImpl: typeof fetch = fetch) {
    super(connection.baseUrl, fetchImpl);
    this.connection = connection;
    this.team = connection.teamUuid;
  }

  protected async login(): Promise<void> {
    if (!this.baseUrl || !this.connection.email || !this.connection.password) {
      throw new IssueTrackerClientError(
        "ONES is not configured (URL, email and password are required).",
      );
    }
    const res = await this.fetchTimed(`${this.baseUrl}/project/api/project/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: this.connection.email, password: this.connection.password }),
    });
    if (res.status === 401)
      throw new IssueTrackerClientError("ONES login rejected (check email/password).");
    if (res.status === 404)
      throw new IssueTrackerClientError("ONES login endpoint not found: check the URL.");
    if (!res.ok) throw new IssueTrackerClientError(`ONES login failed: HTTP ${res.status}`);
    const j: J = await res.json();
    if (!j?.user?.token || !j?.user?.uuid) {
      throw new IssueTrackerClientError("ONES login response is missing the user token.");
    }
    this.token = j.user.token;
    this.userUuid = j.user.uuid;
    this.team ||= j.teams?.[0]?.uuid ?? "";
  }

  protected authHeaders(): Record<string, string> {
    return { "Ones-Auth-Token": this.token, "Ones-User-Id": this.userUuid };
  }

  protected sessionSummary(): string {
    return `Signed in to team ${this.team}.`;
  }

  // Login fills in the team when none is configured, so it must run before the URL is built.
  private async api(method: string, path: string, body?: unknown): Promise<J> {
    await this.ensureLogin();
    return this.requestJson(
      method,
      `${this.baseUrl}/project/api/project/team/${this.team}${path}`,
      body,
    );
  }

  /** Verified: graphql `projects { uuid name }`. */
  async listProjects(): Promise<IssueTrackerProject[]> {
    const r = await this.api("POST", "/items/graphql", { query: "{ projects { uuid name } }" });
    return (r?.data?.projects ?? []).map((p: J) => ({ id: String(p.uuid), name: String(p.name) }));
  }

  /**
   * Verified: GET `.../res/attachment/{uuid}` returns the file's metadata as JSON, with a
   * presigned `url` (valid one hour) that serves the bytes.
   */
  protected override async resolveDownloadUrl(url: string): Promise<string> {
    if (!/\/res\/attachment\/[^/?]+$/.test(url)) return url;
    const meta: J = await this.requestJson("GET", url);
    if (typeof meta?.url !== "string") {
      throw new IssueTrackerClientError(`ONES attachment has no download URL: ${url}`);
    }
    return meta.url;
  }

  /** Verified: GET `/task_statuses`. */
  async listStatuses(): Promise<IssueTrackerStatus[]> {
    const r = await this.api("GET", "/task_statuses");
    return (r?.task_statuses ?? []).map((s: J) => ({
      id: String(s.uuid),
      name: String(s.name),
      category: String(s.category ?? ""),
    }));
  }

  async listMyIssues(filter: IssueStatusFilter): Promise<Issue[]> {
    await this.ensureLogin();
    // An explicit filter needs every status, so the server-side "not done" filter is skipped.
    const filtered = filter.mode === "default" && this.filtered;
    let r: J;
    try {
      r = await this.api("POST", "/items/graphql", { query: LIST_QUERY(this.userUuid, filtered) });
    } catch (e) {
      if (!filtered || (e as IssueTrackerClientError).status !== 400) throw e;
      this.filtered = false;
      r = await this.api("POST", "/items/graphql", { query: LIST_QUERY(this.userUuid, false) });
    }
    const ids = new Set(filter.statusIds);
    const tasks: J[] = (r?.data?.tasks ?? []).filter((t: J) =>
      filter.mode === "include"
        ? ids.has(t.status?.uuid)
        : filter.mode === "exclude"
          ? !ids.has(t.status?.uuid)
          : !DONE_NAME.test(t.status?.name ?? ""),
    );
    // One query, no per-task detail calls: a task whose details the user may not open (403)
    // must not hide the rest. Comments and attachments come from `loadIssue` on pick.
    return tasks.map((t) => ({
      uuid: t.uuid,
      key: `ONES-${t.number}`,
      number: t.number,
      title: t.name ?? "",
      descriptionText: t.descriptionText ?? "",
      status: t.status?.name ?? "",
      url: `${this.baseUrl}/project/#/team/${this.team}/task/${t.uuid}`,
      trackerProjectId: t.project?.uuid ?? "",
      updatedAt: iso(t.serverUpdateStamp),
      comments: [],
      attachments: [],
    }));
  }

  async loadIssue(uuid: string, status = ""): Promise<Issue> {
    const d = await this.api("GET", `/task/${uuid}/info`);
    const m = await this.api("GET", `/task/${uuid}/messages`);
    // Verified shape: `{ messages: [...], count, has_next }`.
    const discussions: J[] = (Array.isArray(m?.messages) ? m.messages : [])
      .filter((x: J) => x.type === "discussion")
      .toSorted((a: J, b: J) => a.send_time - b.send_time);
    const attachments = extractImages(d.desc_rich ?? "");
    for (const x of discussions) {
      if (x.resource) {
        attachments.push({
          name: x.resource.name,
          url: `${this.baseUrl}/project/api/project/team/${this.team}/res/attachment/${x.resource.uuid}`,
          isImage: String(x.resource.mime ?? "").startsWith("image/"),
        });
      }
    }
    return {
      uuid: d.uuid,
      key: `ONES-${d.number}`,
      number: d.number,
      title: d.summary ?? "",
      descriptionText: d.desc ?? "",
      status,
      url: `${this.baseUrl}/project/#/team/${this.team}/task/${d.uuid}`,
      trackerProjectId: d.project_uuid ?? "",
      updatedAt: iso(d.server_update_stamp),
      comments: discussions
        .filter((x) => x.text)
        .map((x) => ({ author: x.from_name ?? "", createdAt: iso(x.send_time), text: x.text })),
      attachments,
    };
  }
}
