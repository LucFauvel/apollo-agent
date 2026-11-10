import * as Schema from "effect/Schema";
import { AccountProvider } from "./domain.ts";

/** Claude Code or Codex on the computer Apollo runs on: whether it is there, and its own login. */
export const AgentCliState = Schema.Struct({
  provider: AccountProvider,
  /** The CLI Apollo found (`null`: not found). */
  executable: Schema.NullOr(Schema.String),
  /** Claude Code comes with Apollo here (development runs): sessions work without the CLI. */
  bundled: Schema.Boolean,
  /** Apollo is running the official installer. */
  install: Schema.NullOr(Schema.Struct({ step: Schema.String, startedAt: Schema.Number })),
  /** Why the last install failed. */
  installError: Schema.NullOr(Schema.String),
  /** This computer's own login (`null` while unknown, or without the CLI). */
  login: Schema.NullOr(
    Schema.Struct({
      loggedIn: Schema.Boolean,
      email: Schema.NullOr(Schema.String),
      orgName: Schema.NullOr(Schema.String),
      /** e.g. `pro`, `max`, `team`, `plus`. */
      plan: Schema.NullOr(Schema.String),
    }),
  ),
  /**
   * A sign-in is in progress: the page to open, the code to enter there (Codex device
   * sign-in), and why it stopped if it failed.
   */
  signIn: Schema.NullOr(
    Schema.Struct({
      url: Schema.NullOr(Schema.String),
      userCode: Schema.NullOr(Schema.String),
      /** Claude: the page may show a code to paste back (`agentClis.submitCode`). */
      needsCode: Schema.Boolean,
      error: Schema.NullOr(Schema.String),
    }),
  ),
});
export type AgentCliState = typeof AgentCliState.Type;
