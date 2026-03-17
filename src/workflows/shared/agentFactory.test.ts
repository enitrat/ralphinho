import { describe, expect, test, mock } from "bun:test";

// ── Mock smithers-orchestrator before importing the module under test ─────

const claudeConstructorCalls: Array<Record<string, unknown>> = [];
const codexConstructorCalls: Array<Record<string, unknown>> = [];

mock.module("smithers-orchestrator", () => {
  class MockClaudeCodeAgent {
    readonly opts: Record<string, unknown>;
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      claudeConstructorCalls.push(opts);
    }
  }

  class MockCodexAgent {
    readonly opts: Record<string, unknown>;
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      codexConstructorCalls.push(opts);
    }
  }

  return { ClaudeCodeAgent: MockClaudeCodeAgent, CodexAgent: MockCodexAgent };
});

const { createAgentFactory } = await import("./agentFactory");

// ── Helpers ──────────────────────────────────────────────────────────────

function makeFactory(idleTimeoutMs = 10 * 60 * 1000) {
  return createAgentFactory({
    repoRoot: "/repo",
    workspacePolicy: "## WORKSPACE POLICY\nDo not refuse dirty state.",
    executionPolicy: "## EXECUTION POLICY\nComplete fully.",
    idleTimeoutMs,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("createAgentFactory", () => {
  test("returns createClaude and createCodex but NOT buildSystemPrompt", () => {
    const factory = makeFactory();
    expect(typeof factory.createClaude).toBe("function");
    expect(typeof factory.createCodex).toBe("function");
    expect("buildSystemPrompt" in factory).toBe(false);
  });

  describe("createClaude", () => {
    test("passes correct systemPrompt to ClaudeCodeAgent", () => {
      claudeConstructorCalls.length = 0;
      const factory = makeFactory();
      factory.createClaude("Planner — Create plan");

      expect(claudeConstructorCalls).toHaveLength(1);
      const opts = claudeConstructorCalls[0]!;
      const systemPrompt = opts.systemPrompt as string;
      expect(systemPrompt).toContain("# Role: Planner — Create plan");
      expect(systemPrompt).toContain("## WORKSPACE POLICY");
      expect(systemPrompt).toContain("## EXECUTION POLICY");
    });

    test("propagates idleTimeoutMs to ClaudeCodeAgent", () => {
      claudeConstructorCalls.length = 0;
      const factory = makeFactory(10 * 60 * 1000);
      factory.createClaude("Researcher");

      expect(claudeConstructorCalls).toHaveLength(1);
      expect(claudeConstructorCalls[0]!.idleTimeoutMs).toBe(10 * 60 * 1000);
    });

    test("uses provided model override", () => {
      claudeConstructorCalls.length = 0;
      const factory = makeFactory();
      factory.createClaude("Code Reviewer", "claude-opus-4-6");

      expect(claudeConstructorCalls[0]!.model).toBe("claude-opus-4-6");
    });

    test("uses a default model when none is provided", () => {
      claudeConstructorCalls.length = 0;
      const factory = makeFactory();
      factory.createClaude("Implementer");

      expect(typeof claudeConstructorCalls[0]!.model).toBe("string");
      expect((claudeConstructorCalls[0]!.model as string).length).toBeGreaterThan(0);
    });
  });

  describe("createCodex", () => {
    test("passes correct systemPrompt to CodexAgent", () => {
      codexConstructorCalls.length = 0;
      const factory = makeFactory();
      factory.createCodex("Implementer — Write code", "gpt-5.4");

      expect(codexConstructorCalls).toHaveLength(1);
      const opts = codexConstructorCalls[0]!;
      const systemPrompt = opts.systemPrompt as string;
      expect(systemPrompt).toContain("# Role: Implementer — Write code");
      expect(systemPrompt).toContain("## WORKSPACE POLICY");
      expect(systemPrompt).toContain("## EXECUTION POLICY");
    });

    test("propagates idleTimeoutMs to CodexAgent", () => {
      codexConstructorCalls.length = 0;
      const factory = makeFactory(15 * 60 * 1000);
      factory.createCodex("Refactor Hunter", "gpt-5.4");

      expect(codexConstructorCalls).toHaveLength(1);
      expect(codexConstructorCalls[0]!.idleTimeoutMs).toBe(15 * 60 * 1000);
    });

    test("different idleTimeoutMs values are preserved independently", () => {
      codexConstructorCalls.length = 0;
      const ralphFactory = makeFactory(10 * 60 * 1000);
      const improvFactory = makeFactory(15 * 60 * 1000);

      ralphFactory.createCodex("Agent A", "gpt-5.3-codex");
      improvFactory.createCodex("Agent B", "gpt-5.4");

      expect(codexConstructorCalls[0]!.idleTimeoutMs).toBe(10 * 60 * 1000);
      expect(codexConstructorCalls[1]!.idleTimeoutMs).toBe(15 * 60 * 1000);
    });

    test("forwards reasoningEffort when provided", () => {
      codexConstructorCalls.length = 0;
      const factory = makeFactory();
      factory.createCodex("Reviewer", "gpt-5.4", "medium");

      expect(codexConstructorCalls).toHaveLength(1);
      const opts = codexConstructorCalls[0]!;
      expect(opts.config).toEqual({ model_reasoning_effort: "medium" });
    });

    test("omits config when reasoningEffort is not provided", () => {
      codexConstructorCalls.length = 0;
      const factory = makeFactory();
      factory.createCodex("Implementer", "gpt-5.3-codex");

      expect(codexConstructorCalls).toHaveLength(1);
      expect(codexConstructorCalls[0]!.config).toBeUndefined();
    });
  });
});
