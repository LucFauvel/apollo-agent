import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BotId, Skill } from "@apollo/contracts";

/**
 * Mirrors a bot's active skills to disk so the providers load them natively.
 *
 * The directory is a Claude Code plugin (`.claude-plugin/plugin.json` +
 * `skills/<name>/SKILL.md`). Codex reads the same `skills/` folder as an extra
 * skill root. The database stays the source of truth; this is a derived copy.
 */
export const PLUGIN_NAME = "apollo-skills";

/** Names that are safe to use as a directory and that both providers accept. */
const SAFE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const pluginDir = (dataDir: string, botId: BotId): string => join(dataDir, "skills", botId);

/** The bot's own active skills shadow global ones with the same name. */
export const effectiveSkills = (skills: ReadonlyArray<Skill>): Array<Skill> => {
  const byName = new Map<string, Skill>();
  for (const skill of skills) {
    if (skill.status !== "active" || !SAFE_NAME.test(skill.name)) continue;
    const current = byName.get(skill.name);
    if (!current || (current.botId === null && skill.botId !== null)) byName.set(skill.name, skill);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
};

// JSON strings are valid YAML scalars, which keeps quotes and colons safe.
export const renderSkillMd = (skill: Skill): string =>
  [
    "---",
    `name: ${JSON.stringify(skill.name)}`,
    `description: ${JSON.stringify(skill.description.replace(/\s+/g, " ").trim())}`,
    "---",
    "",
    skill.body.trim(),
    "",
  ].join("\n");

/** Writes `content` only when it changed, via a temp file and rename. */
const writeIfChanged = (path: string, content: string): boolean => {
  try {
    if (readFileSync(path, "utf8") === content) return false;
  } catch {
    // missing: write it
  }
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, content);
  renameSync(temp, path);
  return true;
};

/**
 * Brings `dir` in line with `skills`. Returns whether anything changed, so callers
 * only ask live sessions to reload when needed.
 */
export const syncSkills = (dir: string, skills: ReadonlyArray<Skill>): boolean => {
  const wanted = effectiveSkills(skills);
  const skillsRoot = join(dir, "skills");
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  mkdirSync(skillsRoot, { recursive: true });

  let changed = writeIfChanged(
    join(dir, ".claude-plugin", "plugin.json"),
    `${JSON.stringify(
      { name: PLUGIN_NAME, version: "1.0.0", description: "Skills learned and approved in Apollo." },
      null,
      2,
    )}\n`,
  );

  const names = new Set(wanted.map((s) => s.name));
  for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!names.has(entry.name)) {
      rmSync(join(skillsRoot, entry.name), { recursive: true, force: true });
      changed = true;
    }
  }
  for (const skill of wanted) {
    mkdirSync(join(skillsRoot, skill.name), { recursive: true });
    changed = writeIfChanged(join(skillsRoot, skill.name, "SKILL.md"), renderSkillMd(skill)) || changed;
  }
  return changed;
};
