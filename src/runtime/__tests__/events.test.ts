import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { readEventLog } from "../events";

const TMP_PREFIX = `/tmp/super-ralph-events-${process.pid}-`;
const created: string[] = [];

async function writeTmp(contents: string): Promise<string> {
  const path = `${TMP_PREFIX}${Date.now()}-${Math.random().toString(16).slice(2)}.ndjson`;
  await Bun.write(path, contents);
  created.push(path);
  return path;
}

afterEach(() => {
  for (const path of created.splice(0)) {
    try {
      rmSync(path);
    } catch {
      // ignore cleanup failures
    }
  }
});

describe("readEventLog", () => {
  test("returns [] when file does not exist", async () => {
    const events = await readEventLog("/tmp/does-not-exist-events.ndjson");
    expect(events).toEqual([]);
  });

  test("skips malformed JSON lines and unknown event types", async () => {
    const path = await writeTmp([
      '{"type":"node-started","timestamp":1,"runId":"run-1","nodeId":"u:implement","unitId":"u","stageName":"implement"}',
      "not-json",
      '{"type":"unknown-event","timestamp":2}',
      '{"type":"node-completed","timestamp":3,"runId":"run-1","nodeId":"u:implement","unitId":"u","stageName":"implement"}',
      "",
    ].join("\n"));

    const events = await readEventLog(path);
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("node-started");
    expect(events[1]?.type).toBe("node-completed");
  });
});
