import { ApolloError } from "@apollo/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { Jobs } from "../jobs/Jobs.ts";
import { McpCaller } from "./Caller.ts";

/** Background commands: start a long-running command, come back to it later. */

const shared = {
  failure: ApolloError,
  failureMode: "return" as const,
  dependencies: [McpCaller],
};

const Status = Schema.Struct({
  jobId: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
  running: Schema.Boolean,
  exitCode: Schema.NullOr(Schema.Number),
  signal: Schema.NullOr(Schema.String),
  seconds: Schema.Number,
  logPath: Schema.String,
  output: Schema.String,
});

const { output: _output, ...summaryFields } = Status.fields;
const JobSummary = Schema.Struct(summaryFields);

const lines = Schema.optional(Schema.Number).annotate({ description: "Lines of output to return (default 60, max 400)." });

const Run = Tool.make("apollo_job_run", {
  ...shared,
  description: [
    "Run a shell command in the background and return at once with a jobId: dev servers, builds, test suites,",
    "anything that takes more than a few seconds. It runs in your working directory unless `cwd` says otherwise.",
    "When it ends while you are not waiting on it, Apollo sends you a message with its exit code and last output",
    "(turn off with notify: false, e.g. for servers). Use apollo_job_wait to block until it ends, apollo_job_status",
    "to read its output, apollo_job_stop to stop it.",
  ].join(" "),
  parameters: Schema.Struct({
    command: Schema.String,
    cwd: Schema.optional(Schema.String),
    notify: Schema.optional(Schema.Boolean),
  }),
  success: Status,
});

const Wait = Tool.make("apollo_job_wait", {
  ...shared,
  description:
    "Wait until a background job ends (or `timeoutSeconds` passes, default 120, max 600), then return its exit code and last output.",
  parameters: Schema.Struct({ jobId: Schema.String, timeoutSeconds: Schema.optional(Schema.Number), lines }),
  success: Schema.Struct({ ...Status.fields, timedOut: Schema.Boolean }),
}).annotate(Tool.Readonly, true);

const JobStatusTool = Tool.make("apollo_job_status", {
  ...shared,
  description: "A background job's state and its latest output, without waiting.",
  parameters: Schema.Struct({ jobId: Schema.String, lines }),
  success: Status,
}).annotate(Tool.Readonly, true);

const Stop = Tool.make("apollo_job_stop", {
  ...shared,
  description: "Stop a background job and everything it started.",
  parameters: Schema.Struct({ jobId: Schema.String }),
  success: Status,
});

const List = Tool.make("apollo_job_list", {
  ...shared,
  description: "This session's background jobs, running and finished.",
  success: Schema.Struct({ jobs: Schema.Array(JobSummary) }),
}).annotate(Tool.Readonly, true);

export const JobToolkit = Toolkit.make(Run, Wait, JobStatusTool, Stop, List);

export const handlers = JobToolkit.toLayer(
  Effect.gen(function* () {
    const jobs = yield* Jobs;
    return {
      apollo_job_run: ({ command, cwd, notify }) => Effect.flatMap(McpCaller, (caller) => jobs.start(caller, { command, cwd, notify })),
      apollo_job_wait: ({ jobId, timeoutSeconds, lines }) =>
        Effect.flatMap(McpCaller, (caller) => jobs.wait(caller, jobId, timeoutSeconds ?? 120, lines)),
      apollo_job_status: ({ jobId, lines }) => Effect.flatMap(McpCaller, (caller) => jobs.status(caller, jobId, lines)),
      apollo_job_stop: ({ jobId }) => Effect.flatMap(McpCaller, (caller) => jobs.stop(caller, jobId)),
      apollo_job_list: () => Effect.flatMap(McpCaller, (caller) => Effect.map(jobs.list(caller), (list) => ({ jobs: list }))),
    };
  }),
);
