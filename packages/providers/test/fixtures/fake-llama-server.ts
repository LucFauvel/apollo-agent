import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: { model?: string; stream?: boolean; system?: unknown } | null;
}

const readBody = async (request: IncomingMessage) => {
  const chunks: Array<Buffer> = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString();
  return text ? (JSON.parse(text) as RecordedRequest["body"]) : null;
};

/**
 * Just enough of llama-server for Apollo: the model list, `/props`, and an
 * Anthropic Messages endpoint that always answers `reply`.
 */
export const startFakeLlamaServer = async (options: { model: string; contextSize: number; reply: string }) => {
  const requests: Array<RecordedRequest> = [];
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://x").pathname;
    const body = await readBody(request);
    requests.push({ path, authorization: request.headers.authorization, body });
    const json = (value: unknown) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };

    if (path === "/v1/models") {
      return json({ object: "list", data: [{ id: options.model, object: "model", meta: { n_params: 1.5e9 } }] });
    }
    if (path === "/props") return json({ default_generation_settings: { n_ctx: options.contextSize } });
    if (path === "/v1/messages/count_tokens") return json({ input_tokens: 100 });
    if (path !== "/v1/messages") {
      response.writeHead(404).end();
      return;
    }

    const usage = { input_tokens: 120, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const message = {
      id: `msg_${requests.length}`,
      type: "message",
      role: "assistant",
      model: body?.model ?? options.model,
      content: [{ type: "thinking", thinking: "The user wants a pong.", signature: "" }, { type: "text", text: options.reply }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage,
    };
    if (!body?.stream) return json(message);

    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (data: Record<string, unknown>) => response.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
    send({ type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { ...usage, output_tokens: 1 } } });
    // A model that thinks first, in two chunks, then answers.
    send({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
    send({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "The user wants " } });
    send({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "a pong." } });
    send({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "" } });
    send({ type: "content_block_stop", index: 0 });
    send({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
    send({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: options.reply } });
    send({ type: "content_block_stop", index: 1 });
    send({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } });
    send({ type: "message_stop" });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};
