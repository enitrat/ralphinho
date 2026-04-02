import type { AgentLike } from "smithers-orchestrator";
import type { Scorer } from "smithers-orchestrator";
import { llmJudge } from "smithers-orchestrator";
import type { ScorerInput } from "smithers-orchestrator";

/**
 * LLM-as-judge scorer that evaluates how thoroughly a code review
 * covers the changed files — completeness, depth, and actionability.
 */
export function reviewCoverageScorer(judge: AgentLike): Scorer {
  return llmJudge({
    id: "review-coverage",
    name: "Review Coverage",
    description:
      "Evaluates whether the code review thoroughly covers the changed files",
    judge,
    instructions: `You are a code review coverage evaluator. Your job is to determine if a code review is thorough and covers the important aspects of the changes.

Key Principles:
1. Check that all changed files are addressed
2. Evaluate depth of feedback (superficial vs substantive)
3. Assess whether critical issues (bugs, security, performance) are identified
4. Consider actionability of the feedback
5. Empty or missing reviews should score 0`,
    promptTemplate: ({ input, output }: ScorerInput) =>
      `Evaluate how thoroughly this code review covers the changes.

Input (what was reviewed): ${JSON.stringify(input)}

Review output: ${JSON.stringify(output)}

Respond with a JSON object: { "score": <number 0-1>, "reason": "<brief explanation>" }

Where 1.0 means exhaustive coverage and 0.0 means no meaningful review.`,
  });
}
