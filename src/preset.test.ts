import { describe, expect, test } from "bun:test";

import {
  loadReviewPreset,
  loadScheduledPreset,
  resolveScheduledPresetPaths,
} from "./preset-runtime";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

describe("loadReviewPreset", () => {
  test("loads review-discovery config and review plan", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "super-ralph-review-"));
    const ralphDir = join(fixtureRoot, ".ralphinho");
    mkdirSync(ralphDir, { recursive: true });

    writeFileSync(
      join(ralphDir, "config.json"),
      JSON.stringify({
        mode: "review-discovery",
        repoRoot: fixtureRoot,
        reviewInstruction: "Review src/api",
        reviewInstructionSource: null,
        reviewPaths: ["src/api"],
        reviewAgentOverride: null,
        agents: { claude: true, codex: true, gh: false },
        maxConcurrency: 4,
        createdAt: "2026-03-16T00:00:00.000Z",
      }),
    );
    writeFileSync(
      join(ralphDir, "review-plan.json"),
      JSON.stringify({
        source: null,
        instruction: "Review src/api",
        generatedAt: "2026-03-16T00:00:00.000Z",
        repo: {
          projectName: "fixture",
          buildCmds: {},
          testCmds: {},
        },
        slices: [{
          id: "src-api-1234abcd",
          mode: "slice",
          path: "src/api",
          entryType: "directory",
          focusAreas: ["bugs"],
          rationale: "Review the api boundary",
          risk: "medium",
          inferredPaths: [],
        }],
      }),
    );

    const loaded = loadReviewPreset({
      RALPHINHO_DIR: ralphDir,
      RALPHINHO_PLAN_PATH: join(ralphDir, "review-plan.json"),
    });

    expect(loaded.config.mode).toBe("review-discovery");
    expect(loaded.reviewPlan.slices).toHaveLength(1);
    expect(loaded.reviewPlan.slices[0]?.path).toBe("src/api");
  });
});
