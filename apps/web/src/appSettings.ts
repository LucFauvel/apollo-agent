import type { AppSettings, ProjectInfo } from "@apollo/contracts";
import { useEffect, useState } from "react";
import { rpc } from "./rpc.ts";

/** Shows a path under the home directory as `~/…`. */
export const tildify = (path: string, home: string) =>
  home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;

/** A folder-friendly version of a bot name: "Code Review" → "code-review". */
export const slugify = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "bot";

const NAMES = [
  "Atlas", "Nova", "Orion", "Vega", "Lyra", "Juno", "Iris", "Echo", "Sol", "Rhea", "Kepler", "Tycho",
  "Hubble", "Halley", "Cassini", "Io", "Titan", "Ceres", "Luna", "Pixel", "Comet", "Quasar", "Nebula", "Polaris",
];

/** A name no existing bot uses, picked at random so new bots don't all start the same. */
export const suggestBotName = (taken: Iterable<string>) => {
  const used = new Set([...taken].map((n) => n.trim().toLowerCase()));
  const free = NAMES.filter((n) => !used.has(n.toLowerCase()));
  if (free.length > 0) return free[Math.floor(Math.random() * free.length)]!;
  let i = 2;
  while (used.has(`atlas ${i}`)) i++;
  return `Atlas ${i}`;
};

/** App settings and the projects found in the project folders; `null` until loaded. */
export function useAppSettings() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [projects, setProjects] = useState<ReadonlyArray<ProjectInfo>>([]);
  useEffect(() => {
    let alive = true;
    rpc((c) => c["app.settings"]())
      .then((s) => alive && setSettings(s))
      .catch(() => undefined);
    rpc((c) => c["app.projects"]())
      .then((p) => alive && setProjects(p))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return { settings, projects };
}
