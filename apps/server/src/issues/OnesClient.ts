/**
 * ONES (private deployment) client. Endpoints and fields were verified against a real server;
 * see docs/ones-api-notes.md in the kika project before changing them.
 */
import type { Issue, IssueAttachmentRef } from "@t3tools/contracts";

class OnesError extends Error {}

export interface OnesConnection {
  readonly baseUrl: string;
  readonly teamUuid: string;
  readonly email: string;
  readonly password: string;
}

type J = any;

const TIMEOUT_MS = 30_000;
const LIMIT = 500;
const LIST_QUERY = (user: string, filtered: boolean): string =>
  `{ tasks(filter: { assign_in: ["${user}"]${filtered ? ', statusCategory_notIn: ["done"]' : ""} }, limit: ${LIMIT}) { uuid number name key status{uuid name} assign{uuid name} } }`;
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

export class OnesClient {
  private token = "";
  private userUuid = "";
  private team: string;
  private filtered = true;
  private loginPromise: Promise<void> | null = null;

  constructor(
    private readonly connection: OnesConnection,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.team = connection.teamUuid;
  }

  private get base(): string {
    return this.connection.baseUrl.replace(/\/+$/, "");
  }

  private ensureLogin(): Promise<void> {
    this.loginPromise ??= this.login().finally(() => {
      this.loginPromise = null;
    });
    return this.loginPromise;
  }

  private async login(): Promise<void> {
    if (!this.base || !this.connection.email || !this.connection.password) {
      throw new OnesError("ONES is not configured (URL, email and password are required).");
    }
    const res = await this.fetchImpl(`${this.base}/project/api/project/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: this.connection.email, password: this.connection.password }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401) throw new OnesError("ONES login rejected (check email/password).");
    if (res.status === 404) throw new OnesError("ONES login endpoint not found: check the URL.");
    if (!res.ok) throw new OnesError(`ONES login failed: HTTP ${res.status}`);
    const j: J = await res.json();
    if (!j?.user?.token || !j?.user?.uuid) {
      throw new OnesError("ONES login response is missing the user token.");
    }
    this.token = j.user.token;
    this.userUuid = j.user.uuid;
    this.team ||= j.teams?.[0]?.uuid ?? "";
  }

  private authHeaders(): Record<string, string> {
    return { "Ones-Auth-Token": this.token, "Ones-User-Id": this.userUuid };
  }

  private async api(method: string, path: string, body?: unknown, retried = false): Promise<J> {
    if (!this.token) await this.ensureLogin();
    const res = await this.fetchImpl(`${this.base}/project/api/project/team/${this.team}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...this.authHeaders() },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401) {
      if (retried) throw new OnesError("ONES rejected the session after re-login.");
      this.token = "";
      return this.api(method, path, body, true);
    }
    if (!res.ok) {
      throw Object.assign(new OnesError(`ONES ${method} ${path} failed: HTTP ${res.status}`), {
        status: res.status,
      });
    }
    return res.json();
  }

  /** Logs in and reports who and which team, for the settings "Test connection" button. */
  async testConnection(): Promise<string> {
    this.token = "";
    await this.ensureLogin();
    return `Signed in to team ${this.team}.`;
  }

  /** Open tasks assigned to the signed-in user, with details. */
  async listMyOpenIssues(): Promise<Issue[]> {
    if (!this.token) await this.ensureLogin();
    let r: J;
    try {
      r = await this.api("POST", "/items/graphql", {
        query: LIST_QUERY(this.userUuid, this.filtered),
      });
    } catch (e) {
      if (!this.filtered || (e as { status?: number }).status !== 400) throw e;
      this.filtered = false;
      r = await this.api("POST", "/items/graphql", { query: LIST_QUERY(this.userUuid, false) });
    }
    const tasks: J[] = (r?.data?.tasks ?? []).filter(
      (t: J) => !DONE_NAME.test(t.status?.name ?? ""),
    );
    const out: Issue[] = [];
    for (const t of tasks) out.push(await this.loadIssue(t.uuid, t.status?.name ?? ""));
    return out;
  }

  async loadIssue(uuid: string, status = ""): Promise<Issue> {
    const d = await this.api("GET", `/task/${uuid}/info`);
    const m = await this.api("GET", `/task/${uuid}/messages`);
    const discussions: J[] = (m?.messages?.messages ?? [])
      .filter((x: J) => x.type === "discussion")
      .toSorted((a: J, b: J) => a.send_time - b.send_time);
    const attachments = extractImages(d.desc_rich ?? "");
    for (const x of discussions) {
      if (x.resource) {
        attachments.push({
          name: x.resource.name,
          // Unverified URL shape (no sample task had attachments in kika's probe).
          url: `${this.base}/project/api/project/team/${this.team}/res/attachment/${x.resource.uuid}`,
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
      url: `${this.base}/project/#/team/${this.team}/task/${d.uuid}`,
      onesProjectUuid: d.project_uuid ?? "",
      updatedAt: iso(d.server_update_stamp),
      comments: discussions
        .filter((x) => x.text)
        .map((x) => ({ author: x.from_name ?? "", createdAt: iso(x.send_time), text: x.text })),
      attachments,
    };
  }

  /** ONES headers go only to the ONES origin; presigned URLs on other hosts get none. */
  async download(url: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const sameOrigin = new URL(url).origin === new URL(this.base).origin;
    if (sameOrigin && !this.token) await this.ensureLogin();
    const res = await this.fetchImpl(url, {
      headers: sameOrigin ? this.authHeaders() : {},
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new OnesError(`Attachment download failed: HTTP ${res.status}`);
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      mimeType:
        res.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream",
    };
  }
}
