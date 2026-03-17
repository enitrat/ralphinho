import type {
  FinalReviewRow,
  ImplementRow,
  OutputSnapshot,
  ReviewFixRow,
  TestRow,
} from "./state";

export type DecisionStatus = "pending" | "rejected" | "approved" | "invalidated";

export type DurableDecision = {
  unitId: string;
  iteration: number;
  status: Exclude<DecisionStatus, "pending">;
  readyToMoveOn: boolean;
  approved: boolean;
  reasoning: string;
  qualityScore: number | null;
  approvalSupersededRejection: boolean;
  approvalOnlyCorrectedFormatting: boolean;
};

export type DecisionAudit = {
  unitId: string;
  status: DecisionStatus;
  history: DurableDecision[];
  finalDecision: DurableDecision | null;
  lastRejection: DurableDecision | null;
  lastApproval: DurableDecision | null;
  latestApproval: DurableDecision | null;
  mergeEligible: boolean;
  semanticallyComplete: boolean;
};

function byIterationAsc<T extends { iteration: number }>(a: T, b: T): number {
  return a.iteration - b.iteration;
}

function hasPassingTestsSince(rows: TestRow[], iteration: number, upToIteration: number): boolean {
  return rows.some((row) => {
    return row.iteration > iteration && row.iteration <= upToIteration && row.testsPassed;
  });
}

function hasSubstantiveWorkSince(
  implementRows: ImplementRow[],
  reviewFixRows: ReviewFixRow[],
  testRows: TestRow[],
  iteration: number,
  upToIteration: number,
): boolean {
  const changedImplement = implementRows.some((row) => {
    return row.iteration > iteration && row.iteration <= upToIteration;
  });
  const changedReviewFix = reviewFixRows.some((row) => {
    return row.iteration > iteration && row.iteration <= upToIteration;
  });
  return changedImplement || changedReviewFix || hasPassingTestsSince(testRows, iteration, upToIteration);
}

function deriveDurableDecisionHistory(
  unitId: string,
  finalReviewRows: FinalReviewRow[],
  implementRows: ImplementRow[],
  reviewFixRows: ReviewFixRow[],
  testRows: TestRow[],
): DurableDecision[] {
  const history: DurableDecision[] = [];
  let lastRejectionIteration: number | null = null;

  for (const row of [...finalReviewRows].sort(byIterationAsc)) {
    const iteration = row.iteration;
    const approved = row.readyToMoveOn && row.approved;

    if (!approved) {
      history.push({
        unitId,
        iteration,
        status: "rejected",
        readyToMoveOn: row.readyToMoveOn,
        approved: row.approved,
        reasoning: row.reasoning ?? "",
        qualityScore: row.qualityScore ?? null,
        approvalSupersededRejection: false,
        approvalOnlyCorrectedFormatting: false,
      });
      lastRejectionIteration = iteration;
      continue;
    }

    const supersededRejection = lastRejectionIteration !== null;
    const hasFreshEvidence = supersededRejection
      ? hasSubstantiveWorkSince(
        implementRows,
        reviewFixRows,
        testRows,
        lastRejectionIteration,
        iteration,
      )
      : true;
    const status: DurableDecision["status"] = supersededRejection && !hasFreshEvidence
      ? "invalidated"
      : "approved";

    history.push({
      unitId,
      iteration,
      status,
      readyToMoveOn: row.readyToMoveOn,
      approved: row.approved,
      reasoning: row.reasoning ?? "",
      qualityScore: row.qualityScore ?? null,
      approvalSupersededRejection: supersededRejection && hasFreshEvidence,
      approvalOnlyCorrectedFormatting: supersededRejection && !hasFreshEvidence,
    });

    if (status === "approved") {
      lastRejectionIteration = null;
    }
  }

  return history;
}

export function getDecisionAudit(snapshot: OutputSnapshot, unitId: string): DecisionAudit {
  const finalReviewRows = snapshot.finalReviewHistory(unitId);
  const implementRows = snapshot.implementHistory(unitId);
  const reviewFixRows = snapshot.reviewFixHistory(unitId);
  const testRows = snapshot.testHistory(unitId);
  const history = deriveDurableDecisionHistory(
    unitId,
    finalReviewRows,
    implementRows,
    reviewFixRows,
    testRows,
  );

  const finalDecision = history.at(-1) ?? null;
  const lastRejection = [...history].reverse().find((row) => row.status === "rejected") ?? null;
  const lastApproval = [...history].reverse().find((row) => row.status === "approved") ?? null;
  const latestApproval = [...history].reverse().find((row) => row.approved) ?? null;
  const latestTest = snapshot.latestTest(unitId);
  const mergeEligible = finalDecision?.status === "approved" && latestTest?.testsPassed === true;

  return {
    unitId,
    status: finalDecision?.status ?? "pending",
    history,
    finalDecision,
    lastRejection,
    lastApproval,
    latestApproval,
    mergeEligible,
    semanticallyComplete: snapshot.isUnitLanded(unitId) && mergeEligible,
  };
}

export function isMergeEligible(snapshot: OutputSnapshot, unitId: string): boolean {
  return getDecisionAudit(snapshot, unitId).mergeEligible;
}
