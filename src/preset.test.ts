import { describe, expect, test } from "bun:test";

import {
  loadScheduledPreset,
  resolveScheduledPresetPaths,
} from "./preset-runtime";

describe("resolveScheduledPresetPaths", () => {
  test("derives config, plan, and db paths from RALPHINHO_DIR", () => {
    const paths = resolveScheduledPresetPaths({
      RALPHINHO_DIR: "/repo/.ralphinho",
    });

    expect(paths).toEqual({
      ralphDir: "/repo/.ralphinho",
      configPath: "/repo/.ralphinho/config.json",
      planPath: "/repo/.ralphinho/work-plan.json",
      dbPath: "/repo/.ralphinho/workflow.db",
    });
  });

  test("throws when RALPHINHO_DIR is missing", () => {
    expect(() => resolveScheduledPresetPaths({})).toThrow(
      "Missing RALPHINHO_DIR",
    );
  });
});

describe("loadScheduledPreset", () => {
  test("throws a useful error when config cannot be read", () => {
    expect(() =>
      loadScheduledPreset({
        RALPHINHO_DIR: "/missing",
      }),
    ).toThrow("Failed to load ralphinho config");
  });
});
