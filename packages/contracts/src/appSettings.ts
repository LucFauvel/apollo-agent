import * as Schema from "effect/Schema";

/** App-wide settings shared by every bot. Paths are absolute (`~` is expanded on save). */
export const AppSettings = Schema.Struct({
  /** Folders that hold the user's projects (e.g. `~/git`). Bots may look for projects there. */
  projectFolders: Schema.Array(Schema.String),
  /** Where new bots get their own workspace folder by default. */
  workspaceRoot: Schema.String,
  /** The user's home directory, for display. */
  homeDir: Schema.String,
  /** Skills bots save wait for the user's approval (off: they are active right away, as in Hermes). */
  reviewSkills: Schema.Boolean,
});
export type AppSettings = typeof AppSettings.Type;

export const UpdateAppSettingsInput = Schema.Struct({
  projectFolders: Schema.optional(Schema.Array(Schema.String)),
  workspaceRoot: Schema.optional(Schema.String),
  reviewSkills: Schema.optional(Schema.Boolean),
});
export type UpdateAppSettingsInput = typeof UpdateAppSettingsInput.Type;

/** A project found in one of the project folders. */
export const ProjectInfo = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  /** The project folder it was found in. */
  folder: Schema.String,
  git: Schema.Boolean,
});
export type ProjectInfo = typeof ProjectInfo.Type;
