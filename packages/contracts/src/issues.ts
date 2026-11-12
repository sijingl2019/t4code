import * as Schema from "effect/Schema";

import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Marker at the start of an issue's plain-text description that opts it into auto development. */
export const ISSUE_AUTO_DEV_MARKER = "#!t4code";

export const IssueAttachmentRef = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
  isImage: Schema.Boolean,
});
export type IssueAttachmentRef = typeof IssueAttachmentRef.Type;

export const IssueComment = Schema.Struct({
  author: Schema.String,
  createdAt: Schema.String,
  text: Schema.String,
});
export type IssueComment = typeof IssueComment.Type;

export const Issue = Schema.Struct({
  uuid: Schema.String,
  /** Display key, e.g. `ONES-123`. */
  key: Schema.String,
  number: Schema.Number,
  title: Schema.String,
  /** Plain text; the auto-dev marker is read from here. */
  descriptionText: Schema.String,
  status: Schema.String,
  url: Schema.String,
  /** Id of the tracker project the issue belongs to. */
  trackerProjectId: Schema.String,
  updatedAt: Schema.String,
  comments: Schema.Array(IssueComment),
  attachments: Schema.Array(IssueAttachmentRef),
});
export type Issue = typeof Issue.Type;

export const IssueListInput = Schema.Struct({ projectId: ProjectId });
export type IssueListInput = typeof IssueListInput.Type;

export const IssueGetInput = Schema.Struct({ issueUuid: TrimmedNonEmptyString });
export type IssueGetInput = typeof IssueGetInput.Type;

/** An attachment downloaded by the server, sent inline so the composer can attach it. */
export const IssueFile = Schema.Struct({
  name: Schema.String,
  mimeType: Schema.String,
  dataBase64: Schema.String,
});
export type IssueFile = typeof IssueFile.Type;

export const IssueGetResult = Schema.Struct({
  issue: Issue,
  /** Ready-to-send prompt text built from the issue (title, description, comments, links). */
  prompt: Schema.String,
  files: Schema.Array(IssueFile),
});
export type IssueGetResult = typeof IssueGetResult.Type;

export const IssueTestConnectionResult = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.String,
});
export type IssueTestConnectionResult = typeof IssueTestConnectionResult.Type;

/** A project in the issue tracker (e.g. an ONES project), not a T4 project. */
export const IssueTrackerProject = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});
export type IssueTrackerProject = typeof IssueTrackerProject.Type;

export const IssueTrackerStatus = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** Tracker's own grouping, e.g. ONES `to_do` / `in_progress` / `done`. */
  category: Schema.String,
});
export type IssueTrackerStatus = typeof IssueTrackerStatus.Type;

/** What the settings UI needs to bind projects and pick statuses. */
export const IssueTrackerCatalog = Schema.Struct({
  projects: Schema.Array(IssueTrackerProject),
  statuses: Schema.Array(IssueTrackerStatus),
});
export type IssueTrackerCatalog = typeof IssueTrackerCatalog.Type;

export class IssueTrackerError extends Schema.TaggedError<IssueTrackerError>()(
  "IssueTrackerError",
  { message: Schema.String },
) {}

/** True when the description opts into auto development (`#!t4code` at its start). */
export function hasAutoDevMarker(descriptionText: string): boolean {
  return descriptionText.trimStart().startsWith(ISSUE_AUTO_DEV_MARKER);
}
