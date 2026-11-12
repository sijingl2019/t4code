/**
 * Issue tracker adapter registry. Each adapter turns its own settings into a client; adding a
 * tracker means a new `IssueTrackerClient` subclass plus one entry here.
 */
import {
  settingsSecretLiteral,
  type IssueStatusFilter,
  type ServerSettings,
} from "@t3tools/contracts";

import type { IssueTrackerClient } from "./IssueTrackerClient.ts";
import { OnesClient } from "./OnesClient.ts";

interface IssueTrackerAdapter {
  /** Identifies the connection; a changed key means a new client (and a fresh login). */
  readonly connectionKey: (settings: ServerSettings) => string;
  readonly create: (settings: ServerSettings) => IssueTrackerClient;
  readonly statusFilter: (settings: ServerSettings) => IssueStatusFilter;
}

const onesConnection = (settings: ServerSettings) => ({
  baseUrl: settings.ones.baseUrl,
  teamUuid: settings.ones.teamUuid,
  email: settings.ones.email,
  // ponytail: secret-provider references (1Password, …) are not resolved here; literals only.
  password: settingsSecretLiteral(settings.ones.password),
});

const ones: IssueTrackerAdapter = {
  connectionKey: (settings) => `ones:${JSON.stringify(onesConnection(settings))}`,
  create: (settings) => new OnesClient(onesConnection(settings)),
  // An include/exclude list with nothing picked means "not set".
  statusFilter: ({ ones: { statusFilter } }) =>
    statusFilter.statusIds.length > 0 ? statusFilter : { mode: "default", statusIds: [] },
};

/** The configured tracker. ONES is the only adapter so far. */
export const issueTrackerFor = (_settings: ServerSettings): IssueTrackerAdapter => ones;
