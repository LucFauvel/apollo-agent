/**
 * Prints the release candidate promote-to-stable promotes when no tag is given (rules in
 * release-checks.ts newestReleaseCandidate: newest published `vX.Y.Z` prerelease; nightlies are
 * never candidates). Exits 1 when there is none.
 *
 *   node apps/desktop/scripts/release/pick-candidate.ts      (env: GH_TOKEN, GITHUB_REPOSITORY)
 */
import { execFileSync } from "node:child_process";
import { type ListedCandidate, newestReleaseCandidate } from "./release-checks.ts";

const repo = process.env.GITHUB_REPOSITORY ?? "LucFauvel/apollo-agent";
const list = JSON.parse(
  execFileSync("gh", ["release", "list", "--repo", repo, "--limit", "200", "--json", "tagName,isPrerelease,isDraft,publishedAt"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }),
) as Array<ListedCandidate>;
const tag = newestReleaseCandidate(list);
if (!tag) {
  console.error("No published release candidate (vX.Y.Z prerelease) to promote.");
  process.exit(1);
}
console.log(tag);
