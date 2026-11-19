import { execFile } from "node:child_process";
import { ApolloError } from "@apollo/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const FIELDS = "number,title,state,isDraft,url,headRepository,headRepositoryOwner,reviewDecision,statusCheckRollup,reviews,comments";

export interface GhCheck {
  readonly __typename?: string;
  readonly name?: string;
  readonly context?: string;
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly state?: string;
}

export interface GhPullRequest {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly isDraft: boolean;
  readonly url: string;
  readonly reviewDecision: string | null;
  readonly statusCheckRollup: ReadonlyArray<GhCheck> | null;
  readonly reviews: ReadonlyArray<{ author?: { login?: string }; state: string; body?: string; submittedAt?: string }> | null;
  readonly comments: ReadonlyArray<{ author?: { login?: string }; body?: string; createdAt?: string }> | null;
}

/** A review comment as GitHub's REST API returns it, from any of the three lists. */
export interface GhComment {
  readonly kind: "inline" | "review" | "conversation";
  readonly id: number;
  readonly author: string;
  readonly bot: boolean;
  readonly body: string;
  readonly path: string | null;
  readonly line: number | null;
  readonly url: string;
  readonly createdAt: string;
  /** Reviews only: APPROVED, CHANGES_REQUESTED, COMMENTED... */
  readonly state?: string;
}

const gh = (args: ReadonlyArray<string>) =>
  new Promise<string>((resolve, reject) => {
    execFile("gh", [...args], { maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1" } }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      const text = (stderr || error.message).trim();
      reject(
        new Error(
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? "the GitHub CLI (gh) is not installed; install it and run `gh auth login`"
            : text,
        ),
      );
    });
  });

const lines = (out: string) =>
  out
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);

interface RestUser {
  login?: string;
  type?: string;
}

const user = (raw: Record<string, unknown>) => (raw.user ?? {}) as RestUser;

const call = <A>(what: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (error) => new ApolloError({ code: "invalid", message: `${what}: ${(error as Error).message}` }) });

/** GitHub, through the user's GitHub CLI. Everything Apollo posts goes out under their account. */
const live = {
  view: (url: string) => call(`could not read ${url}`, async () => JSON.parse(await gh(["pr", "view", url, "--json", FIELDS])) as GhPullRequest),

  comments: (repo: string, number: number) =>
    call(`could not read the comments on ${repo}#${number}`, async () => {
      const list = (path: string) => gh(["api", "--paginate", path, "--jq", ".[]"]).then(lines);
      const [inline, reviews, conversation] = await Promise.all([
        list(`repos/${repo}/pulls/${number}/comments`),
        list(`repos/${repo}/pulls/${number}/reviews`),
        list(`repos/${repo}/issues/${number}/comments`),
      ]);
      const out: Array<GhComment> = [];
      for (const c of inline) {
        out.push({
          kind: "inline",
          id: c.id as number,
          author: user(c).login ?? "someone",
          bot: user(c).type === "Bot",
          body: (c.body as string) ?? "",
          path: (c.path as string) ?? null,
          line: (c.line as number | null) ?? (c.original_line as number | null) ?? null,
          url: (c.html_url as string) ?? "",
          createdAt: (c.created_at as string) ?? "",
        });
      }
      for (const r of reviews) {
        out.push({
          kind: "review",
          id: r.id as number,
          author: user(r).login ?? "someone",
          bot: user(r).type === "Bot",
          body: (r.body as string) ?? "",
          path: null,
          line: null,
          url: (r.html_url as string) ?? "",
          createdAt: (r.submitted_at as string) ?? "",
          state: r.state as string,
        });
      }
      for (const c of conversation) {
        out.push({
          kind: "conversation",
          id: c.id as number,
          author: user(c).login ?? "someone",
          bot: user(c).type === "Bot",
          body: (c.body as string) ?? "",
          path: null,
          line: null,
          url: (c.html_url as string) ?? "",
          createdAt: (c.created_at as string) ?? "",
        });
      }
      return out;
    }),

  /** Replies in the comment's thread (inline), or on the PR's conversation (the rest). */
  reply: (repo: string, number: number, to: { kind: GhComment["kind"]; id: number }, body: string) =>
    call(`could not reply on ${repo}#${number}`, async () => {
      const path =
        to.kind === "inline" ? `repos/${repo}/pulls/${number}/comments/${to.id}/replies` : `repos/${repo}/issues/${number}/comments`;
      const raw = JSON.parse(await gh(["api", "-X", "POST", path, "-f", `body=${body}`])) as Record<string, unknown>;
      return { id: String(raw.id), url: (raw.html_url as string) ?? "" };
    }),
};

export class GitHub extends Context.Service<GitHub, typeof live>()("apollo/GitHub") {}

export const layer = Layer.succeed(GitHub, live);
