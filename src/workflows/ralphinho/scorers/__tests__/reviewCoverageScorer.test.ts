import { describe, expect, test } from "bun:test";
import { reviewCoverageScorer } from "../reviewCoverageScorer";
import type { AgentLike } from "smithers-orchestrator";

function createMockJudge(responseText: string): AgentLike {
  return {
    generate: async () => ({ text: responseText }),
  } as unknown as AgentLike;
}

describe("reviewCoverageScorer", () => {
  test("returns a scorer with id 'review-coverage'", () => {
    const judge = createMockJudge('{ "score": 0.8, "reason": "good" }');
    const scorer = reviewCoverageScorer(judge);
    expect(scorer.id).toBe("review-coverage");
    expect(scorer.name).toBe("Review Coverage");
  });

  test("delegates to the judge and parses a valid score", async () => {
    const judge = createMockJudge('{ "score": 0.9, "reason": "thorough review" }');
    const scorer = reviewCoverageScorer(judge);
    const result = await scorer.score({
      input: "Review this code",
      output: { severity: "minor", feedback: "Looks good", issues: [] },
    });
    expect(result.score).toBe(0.9);
    expect(result.reason).toBe("thorough review");
  });

  test("clamps score to [0, 1] range", async () => {
    const judge = createMockJudge('{ "score": 1.5, "reason": "over" }');
    const scorer = reviewCoverageScorer(judge);
    const result = await scorer.score({
      input: "Review this",
      output: { severity: "none" },
    });
    expect(result.score).toBe(1);
  });

  test("returns score 0 when judge response is not parseable JSON", async () => {
    const judge = createMockJudge("I cannot evaluate this properly");
    const scorer = reviewCoverageScorer(judge);
    const result = await scorer.score({
      input: "Review this",
      output: { severity: "none" },
    });
    expect(result.score).toBe(0);
    expect(result.reason).toBe("Failed to parse judge response as JSON");
  });
});
