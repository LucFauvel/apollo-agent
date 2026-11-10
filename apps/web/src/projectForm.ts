import type { Project } from "@apollo/contracts";

export interface ProjectFields {
  readonly name: string;
  readonly summary: string;
  readonly cwd: string;
  readonly context: string;
}

const KEYS = ["name", "summary", "cwd", "context"] as const;

export const fieldsOf = (project: Project | null): ProjectFields => ({
  name: project?.name ?? "",
  summary: project?.summary ?? "",
  cwd: project?.cwd ?? "",
  context: project?.context ?? "",
});

/**
 * An edit of a project: `base` is what each field was when the user started editing it,
 * `draft` what the form shows.
 */
export interface ProjectEdit {
  readonly base: ProjectFields;
  readonly draft: ProjectFields;
}

export const startEdit = (project: Project | null): ProjectEdit => ({ base: fieldsOf(project), draft: fieldsOf(project) });

/** Takes the latest project into every field the user has not edited (agents update projects too). */
export const rebase = (edit: ProjectEdit, latest: ProjectFields): ProjectEdit => {
  const base = { ...edit.base };
  const draft = { ...edit.draft };
  for (const key of KEYS) {
    if (draft[key] === base[key]) {
      base[key] = latest[key];
      draft[key] = latest[key];
    }
  }
  return { base, draft };
};

export const edited = (edit: ProjectEdit) => KEYS.filter((key) => edit.draft[key] !== edit.base[key]);

/**
 * What to send to save the edit: the edited fields only. A context edit carries the context it
 * started from, so the server refuses it when an agent changed the context meanwhile.
 */
export const projectUpdate = (edit: ProjectEdit) => {
  const keys = edited(edit);
  const has = (key: (typeof KEYS)[number]) => keys.includes(key);
  return {
    ...(has("name") ? { name: edit.draft.name } : {}),
    ...(has("summary") ? { summary: edit.draft.summary } : {}),
    ...(has("cwd") ? { cwd: edit.draft.cwd.trim() ? edit.draft.cwd : null } : {}),
    ...(has("context") ? { context: edit.draft.context, expectedContext: edit.base.context } : {}),
  };
};

/** The user's context edit started from an older context than the project has now. */
export const contextConflict = (edit: ProjectEdit, latest: ProjectFields) =>
  edit.draft.context !== edit.base.context && edit.base.context !== latest.context;
