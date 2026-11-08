import * as Schema from "effect/Schema";

/**
 * What agents change in git repositories, detected deterministically each turn from
 * snapshots of the working tree, and the semantic view of each file's diff. Only the
 * explanations (`note`, `summaries`) come from the worker's model.
 */

export const FileStatus = Schema.Literals(["added", "modified", "deleted", "renamed"]);
export type FileStatus = typeof FileStatus.Type;

export const ChangedFile = Schema.Struct({
  /** Relative to the repository. */
  path: Schema.String,
  oldPath: Schema.NullOr(Schema.String),
  status: FileStatus,
  /** null for binary files. */
  additions: Schema.NullOr(Schema.Number),
  deletions: Schema.NullOr(Schema.Number),
});
export type ChangedFile = typeof ChangedFile.Type;

/** The files one turn changed in one repository. */
export const RepoChanges = Schema.Struct({
  /** The repository's (or worktree's) folder. */
  repo: Schema.String,
  /** Its folder name, for display. */
  name: Schema.String,
  files: Schema.Array(ChangedFile),
});
export type RepoChanges = typeof RepoChanges.Type;

/** A changed file in the overview, with the worker's explanation when it gave one. */
export const OverviewFile = Schema.Struct({
  ...ChangedFile.fields,
  note: Schema.NullOr(Schema.String),
});
export type OverviewFile = typeof OverviewFile.Type;

/** Everything a session changed so far, per repository (first snapshot to latest). */
export const SessionChanges = Schema.Struct({
  sessionId: Schema.String,
  title: Schema.String,
  repos: Schema.Array(
    Schema.Struct({ repo: Schema.String, name: Schema.String, files: Schema.Array(OverviewFile) }),
  ),
  /** The worker's summaries of its changes, newest first. */
  summaries: Schema.Array(Schema.Struct({ text: Schema.String, at: Schema.Number })),
  updatedAt: Schema.Number,
});
export type SessionChanges = typeof SessionChanges.Type;

/** For an orchestrator: its own changes and its workers'; for a worker: its own. */
export const ChangesOverview = Schema.Struct({ sessions: Schema.Array(SessionChanges) });
export type ChangesOverview = typeof ChangesOverview.Type;

/** A worker's summary of one turn's changes (`apollo_explain_changes`). */
export const TurnSummary = Schema.Struct({
  /** The turn: seq of its TurnStarted event. */
  turnSeq: Schema.Number,
  text: Schema.String,
  at: Schema.Number,
});
export type TurnSummary = typeof TurnSummary.Type;

/**
 * What the conversation shows with each turn's changes card (one session only, unlike the
 * overview): the worker's summaries per turn, and the cards the user cleared.
 */
export const ConversationChanges = Schema.Struct({
  /** Newest first. */
  summaries: Schema.Array(TurnSummary),
  /** Seqs of the FilesChanged events whose cards the user cleared from the conversation. */
  dismissed: Schema.Array(Schema.Number),
});
export type ConversationChanges = typeof ConversationChanges.Type;

export const DiffLine = Schema.Struct({
  kind: Schema.Literals(["add", "del", "ctx"]),
  text: Schema.String,
  oldNo: Schema.NullOr(Schema.Number),
  newNo: Schema.NullOr(Schema.Number),
});
export type DiffLine = typeof DiffLine.Type;

export const SemanticSymbol = Schema.Struct({
  /** Qualified by enclosing declarations (`Store.listBots`), or "Module scope". */
  name: Schema.String,
  kind: Schema.Literals(["function", "method", "class", "type", "constant", "section", "module"]),
  change: Schema.Literals(["added", "removed", "modified"]),
  additions: Schema.Number,
  deletions: Schema.Number,
  hunks: Schema.Array(Schema.Struct({ oldStart: Schema.Number, newStart: Schema.Number, lines: Schema.Array(DiffLine) })),
  note: Schema.NullOr(Schema.String),
});
export type SemanticSymbol = typeof SemanticSymbol.Type;

export const SemanticFileDiff = Schema.Struct({
  ...ChangedFile.fields,
  note: Schema.NullOr(Schema.String),
  symbols: Schema.Array(SemanticSymbol),
  /** Set when the file is binary or too large to show. */
  omitted: Schema.NullOr(Schema.String),
});
export type SemanticFileDiff = typeof SemanticFileDiff.Type;
