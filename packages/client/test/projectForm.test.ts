import { describe, expect, it } from "vitest";
import type { Project } from "@apollo/contracts";
import { contextConflict, edited, fieldsOf, projectUpdate, rebase, startEdit } from "../src/projectForm.ts";

const project = (fields: Partial<Project> = {}) =>
  ({ id: "prj_1", botId: "bot_1", name: "Send", summary: "File sharing", context: "Goals: ship", cwd: null, status: "active", createdAt: 0, updatedAt: 0, ...fields }) as Project;

const type = (edit: ReturnType<typeof startEdit>, key: "name" | "summary" | "cwd" | "context", value: string) => ({
  ...edit,
  draft: { ...edit.draft, [key]: value },
});

describe("the project form", () => {
  it("saves only the fields the user edited, keeping an agent's context update", () => {
    let edit = type(startEdit(project()), "name", "Send v2");
    const agentUpdate = project({ context: "Goals: ship\n\nDecided: S3." });
    edit = rebase(edit, fieldsOf(agentUpdate));
    expect(edit.draft.context).toBe("Goals: ship\n\nDecided: S3.");
    expect(edited(edit)).toEqual(["name"]);
    expect(projectUpdate(edit)).toEqual({ name: "Send v2" });
    expect(contextConflict(edit, fieldsOf(agentUpdate))).toBe(false);
  });

  it("flags a context edit made from an older context, and sends what it started from", () => {
    let edit = type(startEdit(project()), "context", "Goals: ship by Friday");
    const agentUpdate = project({ context: "Goals: ship\n\nDecided: S3." });
    edit = rebase(edit, fieldsOf(agentUpdate));
    expect(edit.draft.context).toBe("Goals: ship by Friday");
    expect(contextConflict(edit, fieldsOf(agentUpdate))).toBe(true);
    expect(projectUpdate(edit)).toEqual({ context: "Goals: ship by Friday", expectedContext: "Goals: ship" });
  });

  it("clears the workspace with null", () => {
    const edit = type(startEdit(project({ cwd: "/work/send" })), "cwd", " ");
    expect(projectUpdate(edit)).toEqual({ cwd: null });
  });
});
