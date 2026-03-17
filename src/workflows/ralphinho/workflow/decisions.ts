import type { OutputSnapshot } from "./state";

export type DecisionStatus = "approved" | "rejected" | "pending" | "invalidated";

export type FinalDecision = {
  iteration: number;
  status: DecisionStatus;
  reasoning: string;
  approvalSupersededRejection: boolean;
  approvalOnlyCorrectedFormatting: boolean;
};

export type DecisionAudit = {
  finalDecision: FinalDecision | null;
};

export function getDecisionAudit(snapshot: OutputSnapshot, unitId: string): DecisionAudit {
  const reviewLoopResult = snapshot.latestReviewLoopResult(unitId);
  if (!reviewLoopResult) {
    return { finalDecision: null };
  }

  const status: DecisionStatus = reviewLoopResult.passed
    ? "approved"
    : reviewLoopResult.exhausted
      ? "rejected"
      : "pending";

  const reasoning = reviewLoopResult.passed
    ? "Review loop passed with no major or critical findings."
    : reviewLoopResult.exhausted
      ? "Review loop exhausted max passes before reaching approval threshold."
      : "Review loop still in progress.";

  return {
    finalDecision: {
      iteration: reviewLoopResult.iterationCount,
      status,
      reasoning,
      approvalSupersededRejection: false,
      approvalOnlyCorrectedFormatting: false,
    },
  };
}
