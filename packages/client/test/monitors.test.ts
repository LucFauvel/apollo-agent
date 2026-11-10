import type { BotId, Monitor, SessionId } from "@apollo/contracts";
import { describe, expect, it } from "vitest";
import { monitorStatusLine, runningMonitors } from "../src/index.ts";

const monitor = (over: Partial<Monitor>): Monitor => ({
  id: "mon_1",
  botId: "bot_1" as BotId,
  sessionId: "ses_1" as SessionId,
  description: "errors in the log",
  command: "tail -f log | grep ERROR",
  cwd: "/tmp",
  status: "running",
  stoppedBy: null,
  startedAt: 0,
  endedAt: null,
  deadline: null,
  events: 0,
  lastEvent: null,
  lastEventAt: null,
  exitCode: null,
  ...over,
});

describe("monitors", () => {
  it("lists a session's running monitors, oldest first", () => {
    const all = [
      monitor({ id: "b", startedAt: 20 }),
      monitor({ id: "a", startedAt: 10 }),
      monitor({ id: "ended", status: "stopped" }),
      monitor({ id: "other", sessionId: "ses_2" as SessionId }),
    ];
    expect(runningMonitors(all, "ses_1" as SessionId).map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("says how many events it delivered and when it stops", () => {
    expect(monitorStatusLine(monitor({}), 30_000)).toBe("no events yet · running 30s · until stopped");
    expect(monitorStatusLine(monitor({ events: 1, deadline: 3_600_000 }), 600_000)).toBe("1 event · running 10m · stops in 50m");
    expect(monitorStatusLine(monitor({ events: 3, deadline: 9_000_000 }), 0)).toBe("3 events · running 0s · stops in 2h 30m");
  });
});
