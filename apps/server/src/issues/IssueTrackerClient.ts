// @effect-diagnostics extendsNativeError:off - plain Promise clients wrapped by IssueService.
/**
 * Base class for issue tracker adapters. It owns what every tracker shares: the login session
 * (one login in flight, re-login once on 401), timed JSON requests, and attachment downloads.
 * Subclasses supply authentication and the tracker's own project/issue endpoints.
 */
import type {
  Issue,
  IssueStatusFilter,
  IssueTrackerProject,
  IssueTrackerStatus,
} from "@t3tools/contracts";

export class IssueTrackerClientError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export type Json = any;

const TIMEOUT_MS = 30_000;

export abstract class IssueTrackerClient {
  private loginPromise: Promise<void> | null = null;
  private loggedIn = false;

  protected readonly baseUrl: string;
  protected readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, fetchImpl: typeof fetch = fetch) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
  }

  /** Signs in and stores whatever `authHeaders` needs. */
  protected abstract login(): Promise<void>;
  protected abstract authHeaders(): Record<string, string>;
  /** Shown by "Test connection" after a successful login. */
  protected abstract sessionSummary(): string;

  abstract listProjects(): Promise<IssueTrackerProject[]>;
  abstract listStatuses(): Promise<IssueTrackerStatus[]>;
  /**
   * Issues assigned to the signed-in user, narrowed by `filter` (the adapter's own "not done" rule
   * for `default`). Comments and attachments may be left empty.
   */
  abstract listMyIssues(filter: IssueStatusFilter): Promise<Issue[]>;
  /** One issue with comments and attachments. */
  abstract loadIssue(id: string, status?: string): Promise<Issue>;
  /** Posts `text` verbatim (no markup interpretation) as a comment on the issue. */
  abstract addComment(id: string, text: string): Promise<void>;

  async testConnection(): Promise<string> {
    this.loggedIn = false;
    await this.ensureLogin();
    return this.sessionSummary();
  }

  protected async ensureLogin(): Promise<void> {
    if (this.loggedIn) return;
    this.loginPromise ??= this.login()
      .then(() => {
        this.loggedIn = true;
      })
      .finally(() => {
        this.loginPromise = null;
      });
    return this.loginPromise;
  }

  protected fetchTimed(url: string, init: RequestInit = {}): Promise<Response> {
    return this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  }

  /** Authenticated JSON request; a 401 re-logs in once. */
  protected async requestJson(method: string, url: string, body?: unknown): Promise<Json> {
    for (let attempt = 0; ; attempt++) {
      await this.ensureLogin();
      const res = await this.fetchTimed(url, {
        method,
        headers: { "Content-Type": "application/json", ...this.authHeaders() },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (res.status === 401 && attempt === 0) {
        this.loggedIn = false;
        continue;
      }
      if (res.status === 401) {
        throw new IssueTrackerClientError("The tracker rejected the session after re-login.", 401);
      }
      if (!res.ok) {
        throw new IssueTrackerClientError(
          `${method} ${url} failed: HTTP ${res.status}`,
          res.status,
        );
      }
      return res.json();
    }
  }

  /** Auth headers go only to the tracker's origin; presigned URLs on other hosts get none. */
  /** Turns an attachment reference into the URL that serves its bytes; identity by default. */
  protected async resolveDownloadUrl(url: string): Promise<string> {
    return url;
  }

  async download(reference: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const url = await this.resolveDownloadUrl(reference);
    const sameOrigin = new URL(url).origin === new URL(this.baseUrl).origin;
    if (sameOrigin) await this.ensureLogin();
    const res = await this.fetchTimed(url, { headers: sameOrigin ? this.authHeaders() : {} });
    if (!res.ok)
      throw new IssueTrackerClientError(`Attachment download failed: HTTP ${res.status}`);
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      mimeType:
        res.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream",
    };
  }
}
