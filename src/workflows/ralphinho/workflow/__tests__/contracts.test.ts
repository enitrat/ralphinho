import { describe, expect, test } from "bun:test";
import {
  TIER_STAGES,
  STAGE_RETRY_POLICIES,
  stageNodeId,
} from "../contracts";
import { scheduledOutputSchemas } from "../../schemas";

describe("stageNodeId", () => {
  test("builds stable node ids", () => {
    expect(stageNodeId("u1", "plan")).toBe("u1:plan");
  });
});

describe("retry policy semantics", () => {
  test("uses backoff policy for research and plan", () => {
    expect(STAGE_RETRY_POLICIES["research"].kind).toBe("backoff");
    expect(STAGE_RETRY_POLICIES["plan"].kind).toBe("backoff");
  });

  test("uses fail-fast policy for implement and test", () => {
    expect(STAGE_RETRY_POLICIES["implement"].kind).toBe("fail-fast");
    expect(STAGE_RETRY_POLICIES["test"].kind).toBe("fail-fast");
  });

  test("does not expose a retry policy for removed final-review stage", () => {
    expect("final-review" in STAGE_RETRY_POLICIES).toBe(false);
  });
});

describe("stage contracts", () => {
  test("small and large tier stages do not include final-review", () => {
    expect(TIER_STAGES.small).not.toContain("final-review");
    expect(TIER_STAGES.large).not.toContain("final-review");
  });
});

describe("scheduled output schemas", () => {
  test("removes final_review and adds review_loop_result", () => {
    expect("final_review" in scheduledOutputSchemas).toBe(false);
    expect("review_loop_result" in scheduledOutputSchemas).toBe(true);
  });

  test("review_loop_result validates expected fields", () => {
    const parsed = scheduledOutputSchemas.review_loop_result.parse({
      iterationCount: 2,
      codeSeverity: "minor",
      prdSeverity: "none",
      passed: true,
      exhausted: false,
    });

    expect(parsed.iterationCount).toBe(2);
    expect(parsed.codeSeverity).toBe("minor");
    expect(parsed.prdSeverity).toBe("none");
    expect(parsed.passed).toBe(true);
    expect(parsed.exhausted).toBe(false);
  });
});

describe("input signatures", () => {
  test("research signature changes when research inputs change", () => {
    const a = JSON.stringify({
      unitId: "u1",
      unitName: "Unit",
      unitDescription: "Desc",
      unitCategory: "large",
      rfcSource: "docs/rfc.md",
      rfcSections: ["A"],
      referencePaths: ["docs/rfc.md"],
      evictionContext: null,
    });
    const b = JSON.stringify({
      unitId: "u1",
      unitName: "Unit",
      unitDescription: "Desc",
      unitCategory: "large",
      rfcSource: "docs/rfc.md",
      rfcSections: ["B"],
      referencePaths: ["docs/rfc.md"],
      evictionContext: null,
    });
    expect(a).not.toBe(b);
  });

  test("plan signature changes when plan inputs change", () => {
    const a = JSON.stringify({
      unitId: "u1",
      unitName: "Unit",
      unitDescription: "Desc",
      unitCategory: "large",
      acceptanceCriteria: ["AC1"],
      contextFilePath: "docs/research/u1.md",
      researchSummary: "summary",
      evictionContext: null,
    });
    const b = JSON.stringify({
      unitId: "u1",
      unitName: "Unit",
      unitDescription: "Desc",
      unitCategory: "large",
      acceptanceCriteria: ["AC2"],
      contextFilePath: "docs/research/u1.md",
      researchSummary: "summary",
      evictionContext: null,
    });
    expect(a).not.toBe(b);
  });
});
