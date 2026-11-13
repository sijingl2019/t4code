/**
 * Issue tracker adapter registry. Each adapter turns one tracker connection into a client; adding a
 * tracker means a new `IssueTrackerClient` subclass plus one entry here.
 */
import {
  settingsSecretLiteral,
  type IssueStatusFilter,
  type IssueTrackerConnection,
  type IssueTrackerKind,
} from "@t3tools/contracts";

import type { IssueTrackerClient } from "./IssueTrackerClient.ts";
import { OnesClient } from "./OnesClient.ts";

interface IssueTrackerAdapter {
  readonly create: (connection: IssueTrackerConnection) => IssueTrackerClient;
}

const onesConnection = (connection: IssueTrackerConnection) => ({
  baseUrl: connection.baseUrl,
  teamUuid: connection.teamUuid,
  email: connection.email,
  // ponytail: secret-provider references (1Password, …) are not resolved here; literals only.
  password: settingsSecretLiteral(connection.password),
});

// ponytail: Jira is selectable in settings but has no adapter yet; add a JiraClient here.
const adapters: Partial<Record<IssueTrackerKind, IssueTrackerAdapter>> = {
  ones: { create: (connection) => new OnesClient(onesConnection(connection)) },
};

export const issueTrackerAdapter = (kind: IssueTrackerKind): IssueTrackerAdapter | undefined =>
  adapters[kind];

/** Identifies the connection; a changed key means a new client (and a fresh login). */
export const connectionKey = (connection: IssueTrackerConnection) =>
  `${connection.kind}:${JSON.stringify(onesConnection(connection))}`;

/** An include/exclude list with nothing picked means "not set". */
export const effectiveStatusFilter = ({
  statusFilter,
}: IssueTrackerConnection): IssueStatusFilter =>
  statusFilter.statusIds.length > 0 ? statusFilter : { mode: "default", statusIds: [] };
