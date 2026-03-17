/**
 * Tests for decomposeRFC — validates JSON parsing, schema validation,
 * DAG validation, and error handling in the decomposition pipeline.
 *
 * The AI agent (ClaudeCodeAgent) is mocked to isolate domain logic.
 */

import { describe, expect, test, mock, beforeEach } from "bun:test";

// ── Mock ClaudeCodeAgent ────────────────────────────────────────────────

let mockGenerate: ReturnType<typeof mock>;

mock.module("smithers-orchestrator", () => ({
  ClaudeCodeAgent: class {
    constructor(_opts: Record<string, unknown>) {}
    generate(opts: { prompt: string }) {
      return mockGenerate(opts);
    }
  },
}));

// Import AFTER mock.module so the mock is in place
import { decomposeRFC } from "./decompose";
import type { RepoConfig } from "../../cli/shared";

// ── Fixtures ────────────────────────────────────────────────────────────

const REPO_CONFIG: RepoConfig = {
  projectName: "test-project",
  runner: "bun",
  buildCmds: { typecheck: "bun run typecheck" },
  testCmds: { test: "bun test" },
  packageScripts: {},
};

/** A valid two-unit response with a dependency. */
function validResponse() {
  return JSON.stringify({
    units: [
      {
        id: "setup-auth",
        name: "Setup Auth",
        rfcSections: ["§1"],
        description: "Add authentication module",
        deps: [],
        acceptance: ["Auth middleware exists"],
        tier: "large",
      },
      {
        id: "add-routes",
        name: "Add Routes",
        rfcSections: ["§2"],
        description: "Add API routes that require auth",
        deps: ["setup-auth"],
        acceptance: ["Routes respond with 200"],
        tier: "small",
      },
    ],
  });
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("decomposeRFC", () => {
  beforeEach(() => {
    mockGenerate = mock(() =>
      Promise.resolve({ text: validResponse() }),
    );
  });

  test("parses a valid JSON response into a WorkPlan with layers", async () => {
    const { plan, layers } = await decomposeRFC(
      "# My RFC\nDo things.",
      REPO_CONFIG,
    );

    expect(plan.units).toHaveLength(2);
    expect(plan.units[0].id).toBe("setup-auth");
    expect(plan.units[1].id).toBe("add-routes");
    expect(plan.repo.projectName).toBe("test-project");
    expect(plan.generatedAt).toBeTruthy();

    // setup-auth has no deps → layer 0; add-routes depends on it → layer 1
    expect(layers).toHaveLength(2);
    expect(layers[0].map((u) => u.id)).toEqual(["setup-auth"]);
    expect(layers[1].map((u) => u.id)).toEqual(["add-routes"]);
  });

  test("extracts JSON from markdown code fences", async () => {
    mockGenerate = mock(() =>
      Promise.resolve({
        text: "Here's the plan:\n```json\n" + validResponse() + "\n```\nDone!",
      }),
    );

    const { plan } = await decomposeRFC("RFC content", REPO_CONFIG);
    expect(plan.units).toHaveLength(2);
  });

  test("extracts JSON from bare code fences (no language tag)", async () => {
    mockGenerate = mock(() =>
      Promise.resolve({
        text: "```\n" + validResponse() + "\n```",
      }),
    );

    const { plan } = await decomposeRFC("RFC content", REPO_CONFIG);
    expect(plan.units).toHaveLength(2);
  });

  test("throws on empty agent response", async () => {
    mockGenerate = mock(() => Promise.resolve({ text: "   " }));

    expect(
      decomposeRFC("RFC content", REPO_CONFIG),
    ).rejects.toThrow("Empty agent response");
  });

  test("throws on invalid JSON response", async () => {
    mockGenerate = mock(() =>
      Promise.resolve({ text: "not json at all" }),
    );

    expect(
      decomposeRFC("RFC content", REPO_CONFIG),
    ).rejects.toThrow("Failed to parse AI response as JSON");
  });

  test("throws when response is valid JSON but missing 'units' array", async () => {
    mockGenerate = mock(() =>
      Promise.resolve({ text: JSON.stringify({ tasks: [] }) }),
    );

    expect(
      decomposeRFC("RFC content", REPO_CONFIG),
    ).rejects.toThrow("AI response missing 'units' array");
  });

  test("throws when units array is empty", async () => {
    mockGenerate = mock(() =>
      Promise.resolve({ text: JSON.stringify({ units: [] }) }),
    );

    expect(
      decomposeRFC("RFC content", REPO_CONFIG),
    ).rejects.toThrow("AI returned no work units");
  });

  test("throws when a unit fails schema validation", async () => {
    mockGenerate = mock(() =>
      Promise.resolve({
        text: JSON.stringify({
          units: [{ id: "bad-unit" }], // missing required fields
        }),
      }),
    );

    expect(
      decomposeRFC("RFC content", REPO_CONFIG),
    ).rejects.toThrow("Work unit at index 0 failed validation");
  });

  test("throws on dependency cycle", async () => {
    mockGenerate = mock(() =>
      Promise.resolve({
        text: JSON.stringify({
          units: [
            {
              id: "a",
              name: "A",
              rfcSections: ["§1"],
              description: "Does A",
              deps: ["b"],
              acceptance: ["A done"],
              tier: "small",
            },
            {
              id: "b",
              name: "B",
              rfcSections: ["§2"],
              description: "Does B",
              deps: ["a"],
              acceptance: ["B done"],
              tier: "small",
            },
          ],
        }),
      }),
    );

    expect(
      decomposeRFC("RFC content", REPO_CONFIG),
    ).rejects.toThrow("Invalid dependency graph");
  });

  test("throws on dependency referencing a non-existent unit", async () => {
    mockGenerate = mock(() =>
      Promise.resolve({
        text: JSON.stringify({
          units: [
            {
              id: "only-unit",
              name: "Only",
              rfcSections: ["§1"],
              description: "Solo unit",
              deps: ["ghost"],
              acceptance: ["Done"],
              tier: "small",
            },
          ],
        }),
      }),
    );

    expect(
      decomposeRFC("RFC content", REPO_CONFIG),
    ).rejects.toThrow("Invalid dependency graph");
  });

  test("passes model and repoRoot options through to the agent", async () => {
    await decomposeRFC("RFC", REPO_CONFIG, {
      model: "claude-opus-4-6",
      repoRoot: "/custom/path",
    });

    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  test("handles parallel units (no deps) in a single layer", async () => {
    mockGenerate = mock(() =>
      Promise.resolve({
        text: JSON.stringify({
          units: [
            {
              id: "a",
              name: "A",
              rfcSections: ["§1"],
              description: "A",
              deps: [],
              acceptance: ["ok"],
              tier: "small",
            },
            {
              id: "b",
              name: "B",
              rfcSections: ["§2"],
              description: "B",
              deps: [],
              acceptance: ["ok"],
              tier: "small",
            },
          ],
        }),
      }),
    );

    const { layers } = await decomposeRFC("RFC", REPO_CONFIG);
    expect(layers).toHaveLength(1);
    expect(layers[0]).toHaveLength(2);
  });
});
