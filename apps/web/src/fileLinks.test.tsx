import type { SessionId } from "@apollo/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownText, markdownShownText } from "./components/Code.tsx";
import { FileLinkSession } from "./components/FileLink.tsx";

const session = "ses_0123456789abcdef0123" as SessionId;
const render = (text: string) =>
  renderToStaticMarkup(
    <FileLinkSession.Provider value={session}>
      <MarkdownText>{text}</MarkdownText>
    </FileLinkSession.Provider>,
  );
const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => decodeURIComponent(m[1]!.replace(/&amp;/g, "&").replace(/\+/g, " ")));

describe("file links in messages", () => {
  it("link paths in text, code spans and links to the session's files", () => {
    const html = render("See `src/app.ts:12`, /Users/me/report.pdf and [the plan](file:///Users/me/plan.md). Web: https://example.com/a.md");
    expect(hrefs(html)).toEqual([
      `/api/files/${session}/content?path=src/app.ts`,
      `/api/files/${session}/content?path=/Users/me/report.pdf`,
      `/api/files/${session}/content?path=/Users/me/plan.md`,
      "https://example.com/a.md",
    ]);
    expect(html).toContain("<code>src/app.ts:12</code>");
  });

  it("pass escaped file names on decoded", () => {
    expect(hrefs(render("[report](/Users/me/report%23final.md) and [mine](</Users/me/My Report.md>)"))).toEqual([
      `/api/files/${session}/content?path=/Users/me/report#final.md`,
      `/api/files/${session}/content?path=/Users/me/My Report.md`,
    ]);
  });

  it("leave code blocks and other code alone", () => {
    expect(hrefs(render("```\ncat src/app.ts\n```\n\nRun `pnpm test` on /api/auth/session."))).toEqual([]);
  });

  it("are plain text outside a conversation", () => {
    expect(hrefs(renderToStaticMarkup(<MarkdownText>{"Open src/app.ts"}</MarkdownText>))).toEqual([]);
  });

  it("keep search text as shown", () => {
    expect(markdownShownText("See `src/app.ts:12` and /Users/me/a.md.")).toBe("See src/app.ts:12 and /Users/me/a.md.");
  });
});
