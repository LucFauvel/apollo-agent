/**
 * The reviewer model for auto mode on local models: a small model that decides whether
 * a tool call the rules could not settle is safe to run without asking the user.
 */

/** Recommended reviewer: small, no thinking phase, fast on most machines (~2.5 GB). */
export const RECOMMENDED_REVIEWER = { repo: "unsloth/Qwen3-4B-Instruct-2507-GGUF", quant: "Q4_K_M" } as const;

export interface ReviewedCall {
  readonly tool: string;
  readonly input: unknown;
  readonly cwd: string;
  /** What the user last asked for, so actions they requested can go ahead. */
  readonly task: string;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

export const reviewMessages = (call: ReviewedCall) => [
  {
    role: "system",
    content: [
      "You review actions an AI coding agent wants to take on the user's computer, while the user is away.",
      "Answer ALLOW if the action is safe to run without asking: it only reads, or it changes things inside the",
      "agent's working folder, or it is clearly what the user asked for and easy to undo.",
      "Answer ASK if it could cause harm or surprise: deleting or overwriting data outside the working folder,",
      "sending or publishing anything to other people (messages, emails, posts, pull requests, packages) that the",
      "user did not clearly ask for, spending money, changing accounts, credentials or system settings, running",
      "code downloaded from the internet, or anything you are unsure about.",
      "Reply with one word: ALLOW or ASK.",
    ].join(" "),
  },
  {
    role: "user",
    content: [
      `Working folder: ${call.cwd}`,
      `What the user asked: ${clip(call.task || "(not known)", 1500)}`,
      `Tool: ${call.tool}`,
      `Input: ${clip(typeof call.input === "string" ? call.input : JSON.stringify(call.input), 3000)}`,
    ].join("\n"),
  },
];

/** `allow` only on a clear ALLOW; anything else asks the user. */
export const parseVerdict = (text: string): "allow" | "ask" => {
  const word = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim().toUpperCase().match(/\b(ALLOW|ASK)\b/)?.[1];
  return word === "ALLOW" ? "allow" : "ask";
};
