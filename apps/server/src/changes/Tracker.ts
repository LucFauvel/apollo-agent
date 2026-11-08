import type { DatabaseSync } from "node:sqlite";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { ChangedFile, ChangeReport, OverviewFile, RepoChanges, SemanticFileDiff, SessionChanges } from "@apollo/contracts";
import { commitsSince, commonGitDir, diffFile, diffFiles, fileAt, headOf, pathsIn, repoRoot, resolveBaseline, snapshot } from "./git.ts";
import { semanticDiff } from "./semantic.ts";

/**
 * What each turn changes in git repositories, without asking the agent:
 *
 * - When a turn starts, the session's repositories are snapshotted: the one it works in
 *   (its cwd or worktree), and any it changed before. A repository a tool call touches
 *   for the first time in a turn (a path in its summary) is snapshotted then.
 * - When the turn ends, each is snapshotted again; the difference is the turn's changes.
 * - A session's overall changes run from its first snapshot of a repository to its latest.
 *
 * Workers explain their changes (`apollo_explain_changes`); those notes are the only part
 * a model writes.
 */

/** Diffs larger than this are listed, not shown. */
const MAX_DIFF_BYTES = 600_000;
/** A full diff lists at most this many files (the rest are counted) and commits. */
export const MAX_REPORT_FILES = 500;
const MAX_REPORT_COMMITS = 50;

interface Turn {
  readonly seq: number;
  readonly cwd: string;
  /** Before-snapshots per repository: the git dir and tree. */
  readonly before: Map<string, Promise<{ gitDir: string; tree: string } | null>>;
}

interface Row {
  turn_seq: number;
  repo: string;
  git_dir: string;
  before_tree: string;
  after_tree: string;
  files: string;
  created_at: number;
}

export interface ExplainItem {
  readonly path: string;
  readonly explanation: string;
  readonly symbols?: ReadonlyArray<{ readonly name: string; readonly explanation: string }> | undefined;
}

export const makeChangeTracker = (db: DatabaseSync, home: string) => {
  const turns = new Map<string, Turn>();
  const rootCache = new Map<string, { at: number; root: string | null }>();

  const rootOf = async (path: string) => {
    const cached = rootCache.get(path);
    if (cached && Date.now() - cached.at < 60_000) return cached.root;
    const root = await repoRoot(path);
    if (rootCache.size > 2000) rootCache.clear();
    rootCache.set(path, { at: Date.now(), root });
    return root;
  };

  const take = async (repo: string) => {
    try {
      const gitDir = await commonGitDir(repo);
      return { gitDir, tree: await snapshot(repo) };
    } catch {
      return null;
    }
  };

  const knownRepos = (sessionId: string) =>
    (db.prepare("select distinct repo from turn_changes where session_id = ?").all(sessionId) as Array<{ repo: string }>).map((r) => r.repo);

  const watch = (turn: Turn, repo: string) => {
    if (!turn.before.has(repo)) turn.before.set(repo, take(repo));
  };

  /** Snapshots the session's repositories as the turn starts. */
  const turnStarted = async (sessionId: string, seq: number, cwd: string) => {
    const turn: Turn = { seq, cwd, before: new Map() };
    turns.set(sessionId, turn);
    const own = await rootOf(cwd);
    for (const repo of new Set([...(own ? [own] : []), ...knownRepos(sessionId)])) watch(turn, repo);
    // Resolves once every snapshot is taken: changes after this belong to the turn.
    await Promise.all(turn.before.values());
  };

  /** A tool call in the running turn: snapshots repositories it names that are not watched yet. */
  const toolStarted = async (sessionId: string, summary: string) => {
    const turn = turns.get(sessionId);
    if (!turn || !summary) return;
    for (const path of pathsIn(summary, home, turn.cwd)) {
      const repo = await rootOf(path);
      if (repo) watch(turn, repo);
    }
    await Promise.all(turn.before.values());
  };

  /** The running turn's changes so far (or, with `finish`, its final changes, stored). */
  const collect = async (sessionId: string, finish: boolean): Promise<Array<RepoChanges & { gitDir: string; before: string; after: string }>> => {
    const turn = turns.get(sessionId);
    if (!turn) return [];
    if (finish) turns.delete(sessionId);
    const result: Array<RepoChanges & { gitDir: string; before: string; after: string }> = [];
    for (const [repo, pending] of turn.before) {
      const before = await pending;
      if (!before) continue;
      const after = await take(repo);
      if (!after) continue;
      const files = await diffFiles(before.gitDir, before.tree, after.tree).catch(() => []);
      if (files.length === 0) continue;
      result.push({ repo, name: basename(repo), files, gitDir: before.gitDir, before: before.tree, after: after.tree });
    }
    if (finish) {
      const now = Date.now();
      const insert = db.prepare(
        `insert or replace into turn_changes (session_id, turn_seq, repo, git_dir, before_tree, after_tree, files, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of result) insert.run(sessionId, turn.seq, r.repo, r.gitDir, r.before, r.after, JSON.stringify(r.files), now);
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  };

  const turnCompleted = async (sessionId: string): Promise<{ seq: number; repos: Array<RepoChanges> } | null> => {
    const seq = turns.get(sessionId)?.seq;
    if (seq === undefined) return null;
    const repos = (await collect(sessionId, true)).map(({ repo, name, files }) => ({ repo, name, files }));
    return { seq, repos };
  };

  /** The turn a session is in, if any. */
  const currentTurn = (sessionId: string) => turns.get(sessionId)?.seq ?? null;

  // --- explanations --------------------------------------------------------

  /**
   * Stores a worker's explanation of its changes in the running turn. Paths may be relative
   * to a repository or absolute; ones that match no changed file are returned as unknown.
   */
  const explain = async (sessionId: string, summary: string, items: ReadonlyArray<ExplainItem>) => {
    const seq = currentTurn(sessionId);
    if (seq === null) return { attached: 0, unknown: items.map((i) => i.path), changed: [] as Array<string> };
    const changes = await collect(sessionId, false);
    const now = Date.now();
    const insert = db.prepare(
      `insert or replace into change_notes (session_id, turn_seq, repo, path, symbol, text, created_at) values (?, ?, ?, ?, ?, ?, ?)`,
    );
    if (summary.trim()) insert.run(sessionId, seq, "", "", "", summary.trim(), now);
    const cwd = turns.get(sessionId)?.cwd ?? "";
    const unknown: Array<string> = [];
    let attached = 0;
    for (const item of items) {
      const absolute = isAbsolute(item.path) ? item.path : resolve(cwd, item.path);
      const match = changes
        .flatMap((r) => r.files.map((f) => ({ repo: r.repo, file: f })))
        .find(({ repo, file }) => file.path === item.path || relative(repo, absolute) === file.path || file.oldPath === item.path);
      if (!match) {
        unknown.push(item.path);
        continue;
      }
      if (item.explanation.trim()) insert.run(sessionId, seq, match.repo, match.file.path, "", item.explanation.trim(), now);
      for (const symbol of item.symbols ?? []) {
        if (symbol.explanation.trim()) insert.run(sessionId, seq, match.repo, match.file.path, symbol.name.trim(), symbol.explanation.trim(), now);
      }
      attached++;
    }
    return { attached, unknown, changed: changes.flatMap((r) => r.files.map((f) => `${r.name}/${f.path}`)) };
  };

  /** Notes for a turn, for the worker's report to its orchestrator. */
  const turnNotes = (sessionId: string, seq: number) =>
    db
      .prepare("select repo, path, symbol, text from change_notes where session_id = ? and turn_seq = ? order by repo, path, symbol")
      .all(sessionId, seq) as Array<{ repo: string; path: string; symbol: string; text: string }>;

  /** The latest note per file and symbol, across the session's turns. */
  const latestNotes = (sessionId: string) => {
    const rows = db
      .prepare("select repo, path, symbol, text from change_notes where session_id = ? and path != '' order by turn_seq, created_at")
      .all(sessionId) as Array<{ repo: string; path: string; symbol: string; text: string }>;
    const notes = new Map<string, string>();
    for (const row of rows) notes.set(`${row.repo}\0${row.path}\0${row.symbol}`, row.text);
    return notes;
  };

  // --- the session's overall changes ------------------------------------------

  const rowsOf = (sessionId: string, repo?: string) =>
    (repo
      ? db.prepare("select * from turn_changes where session_id = ? and repo = ? order by turn_seq").all(sessionId, repo)
      : db.prepare("select * from turn_changes where session_id = ? order by turn_seq").all(sessionId)) as unknown as Array<Row>;

  /** First snapshot to latest, per repository. */
  const spans = (sessionId: string) => {
    const byRepo = new Map<string, { gitDir: string; before: string; after: string; rows: Array<Row> }>();
    for (const row of rowsOf(sessionId)) {
      const span = byRepo.get(row.repo);
      if (!span) byRepo.set(row.repo, { gitDir: row.git_dir, before: row.before_tree, after: row.after_tree, rows: [row] });
      else {
        span.after = row.after_tree;
        span.rows.push(row);
      }
    }
    return byRepo;
  };

  /** When the trees are gone (garbage-collected), the turns' own file lists, merged. */
  const mergedFiles = (rows: ReadonlyArray<Row>): Array<ChangedFile> => {
    const files = new Map<string, ChangedFile>();
    for (const row of rows) for (const f of JSON.parse(row.files) as Array<ChangedFile>) files.set(f.path, f);
    return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
  };

  const overviewCache = new Map<string, Array<ChangedFile>>();

  const sessionChanges = async (sessionId: string, title: string): Promise<SessionChanges | null> => {
    const notes = latestNotes(sessionId);
    const repos: Array<{ repo: string; name: string; files: Array<OverviewFile> }> = [];
    let updatedAt = 0;
    for (const [repo, span] of spans(sessionId)) {
      updatedAt = Math.max(updatedAt, ...span.rows.map((r) => r.created_at));
      const key = `${span.gitDir}\0${span.before}\0${span.after}`;
      let files = overviewCache.get(key);
      if (!files) {
        files = await diffFiles(span.gitDir, span.before, span.after).catch(() => mergedFiles(span.rows));
        if (overviewCache.size > 500) overviewCache.clear();
        overviewCache.set(key, files);
      }
      // Changed, then changed back: nothing to show for this repository.
      if (files.length === 0) continue;
      repos.push({
        repo,
        name: basename(repo),
        files: files.map((f) => ({ ...f, note: notes.get(`${repo}\0${f.path}\0`) ?? null })),
      });
    }
    const summaries = (
      db
        .prepare("select text, created_at from change_notes where session_id = ? and path = '' order by created_at desc limit 20")
        .all(sessionId) as Array<{ text: string; created_at: number }>
    ).map((r) => ({ text: r.text, at: r.created_at }));
    if (repos.length === 0 && summaries.length === 0) return null;
    return { sessionId, title, repos: repos.sort((a, b) => a.name.localeCompare(b.name)), summaries, updatedAt };
  };

  /**
   * One changed file between two trees as a semantic diff. `notes` are the explanations of
   * this file, by symbol ("" for the file itself).
   */
  const semanticFile = async (
    gitDir: string,
    before: string,
    after: string,
    changed: ChangedFile,
    notes: ReadonlyMap<string, string>,
  ): Promise<SemanticFileDiff> => {
    const path = changed.path;
    const base = { ...changed, note: notes.get("") ?? null, symbols: [] };
    if (changed.additions === null) return { ...base, omitted: "Binary file" };
    const diff = await diffFile(gitDir, before, after, path, changed.oldPath).catch(() => null);
    if (diff === null) return { ...base, omitted: "This version is no longer in the repository." };
    if (diff.length > MAX_DIFF_BYTES) return { ...base, omitted: `Too large to show (${changed.additions + (changed.deletions ?? 0)} changed lines)` };
    const [oldContent, newContent] = await Promise.all([
      changed.status === "added" ? null : fileAt(gitDir, before, changed.oldPath ?? path),
      changed.status === "deleted" ? null : fileAt(gitDir, after, path),
    ]);
    const symbolNote = (name: string) => {
      const exact = notes.get(name);
      if (exact) return exact;
      // A worker may name `listBots` for `Store.listBots`.
      for (const [symbol, text] of notes) {
        if (symbol && (name.endsWith(`.${symbol}`) || symbol.endsWith(`.${name}`))) return text;
      }
      return null;
    };
    const symbols = semanticDiff(path, oldContent, newContent, diff).map((s) => ({ ...s, note: symbolNote(s.name) }));
    return { ...base, symbols, omitted: null };
  };

  /** The notes of one file out of `repo\0path\0symbol`-keyed notes, by symbol. */
  const notesOfFile = (notes: ReadonlyMap<string, string>, repo: string, path: string) => {
    const result = new Map<string, string>();
    for (const [key, text] of notes) {
      const [r, p, symbol] = key.split("\0");
      if (r === repo && p === path) result.set(symbol ?? "", text);
    }
    return result;
  };

  /** One file of a session's overall changes, as a semantic diff with the worker's notes. */
  const file = async (sessionId: string, repo: string, path: string): Promise<SemanticFileDiff | null> => {
    const span = spans(sessionId).get(repo);
    if (!span) return null;
    const files = await diffFiles(span.gitDir, span.before, span.after).catch(() => mergedFiles(span.rows));
    const changed = files.find((f) => f.path === path);
    if (!changed) return null;
    return semanticFile(span.gitDir, span.before, span.after, changed, notesOfFile(latestNotes(sessionId), repo, path));
  };

  // --- the full diff of a repository against its baseline (asked for by the user) --------

  /**
   * The latest explanation per file and symbol of a repository, from any session and turn:
   * notes are kept by worktree folder, so every worktree of the same git dir counts (paths
   * are relative to the repository, so they line up).
   */
  const repoNotes = (repo: string, gitDir: string) => {
    const rows = db
      .prepare(
        `select path, symbol, text from change_notes
         where path != '' and (repo = ? or repo in (select distinct repo from turn_changes where git_dir = ?))
         order by created_at`,
      )
      .all(repo, gitDir) as Array<{ path: string; symbol: string; text: string }>;
    const notes = new Map<string, string>();
    for (const row of rows) notes.set(`${row.path}\0${row.symbol}`, row.text);
    return notes;
  };

  /**
   * Everything that differs in the repository around `path` from its baseline (see
   * `resolveBaseline`): commits since the merge base and the working tree as it is now.
   */
  const report = async (path: string, ref?: string): Promise<{ repo: RepoChanges; report: ChangeReport }> => {
    const repo = await repoRoot(path);
    if (!repo) throw new Error(`${path} is not in a git repository`);
    const gitDir = await commonGitDir(repo);
    const baseline = await resolveBaseline(repo, ref);
    const [tree, head, history] = await Promise.all([snapshot(repo), headOf(repo), commitsSince(repo, baseline.commit, MAX_REPORT_COMMITS)]);
    const files = await diffFiles(gitDir, baseline.tree, tree);
    const shown = files.slice(0, MAX_REPORT_FILES);
    const listed = new Set(shown.map((f) => f.path));
    const notes = [...repoNotes(repo, gitDir)]
      .filter(([key]) => key.endsWith("\0") && listed.has(key.slice(0, -1)))
      .map(([key, text]) => ({ path: key.slice(0, -1), text }));
    return {
      repo: { repo, name: basename(repo), files: shown },
      report: {
        gitDir,
        base: { ref: baseline.ref, commit: baseline.commit, tree: baseline.tree },
        head: { branch: head.branch, commit: head.commit, tree },
        commitCount: history.count,
        commits: history.commits,
        uncommitted: tree !== head.tree,
        moreFiles: files.length - shown.length,
        notes,
      },
    };
  };

  /** One file of a full diff, as a semantic diff with the latest explanations of it. */
  const reportFile = async (repo: string, report: ChangeReport, path: string): Promise<SemanticFileDiff | null> => {
    const files = await diffFiles(report.gitDir, report.base.tree, report.head.tree).catch(() => null);
    if (files === null) return null;
    const changed = files.find((f) => f.path === path);
    if (!changed) return null;
    const notes = new Map<string, string>();
    for (const [key, text] of repoNotes(repo, report.gitDir)) {
      const at = key.indexOf("\0");
      if (key.slice(0, at) === path) notes.set(key.slice(at + 1), text);
    }
    return semanticFile(report.gitDir, report.base.tree, report.head.tree, changed, notes);
  };

  return { turnStarted, toolStarted, turnCompleted, currentTurn, explain, turnNotes, sessionChanges, file, report, reportFile };
};

export type ChangeTracker = ReturnType<typeof makeChangeTracker>;
