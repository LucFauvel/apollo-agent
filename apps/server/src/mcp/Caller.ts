import type { BotId, SessionId, SessionRole } from "@apollo/contracts";
import * as Context from "effect/Context";

/** The agent session calling an MCP tool, resolved from its bearer token. */
export class McpCaller extends Context.Service<
  McpCaller,
  { readonly sessionId: SessionId; readonly botId: BotId; readonly role: SessionRole }
>()("apollo/McpCaller") {}
