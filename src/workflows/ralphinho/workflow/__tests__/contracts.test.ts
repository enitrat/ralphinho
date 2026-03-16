import { describe, expect, test } from "bun:test";
import {
  IMPLEMENT_RETRIES,
  IMPLEMENT_RETRY_POLICY,
  PLAN_RETRIES,
  PLAN_RETRY_POLICY,
  RESEARCH_RETRIES,
  RESEARCH_RETRY_POLICY,
  TEST_RETRIES,
  TEST_RETRY_POLICY,
  buildPlanInputSignature,
  buildResearchInputSignature,
  stageNodeId,
} from "../contracts";

describe("stageNodeId", () => {
  test("builds stable node ids", () => {
    expect(stageNodeId("u1", "plan")).toBe("u1:plan");
  });
});

describe("retry policy semantics", () => {
  test("uses backoff policy for research and plan", () => {
    expect(RESEARCH_RETRY_POLICY.kind).toBe("backoff");
    expect(PLAN_RETRY_POLICY.kind).toBe("backoff");
    expect(RESEARCH_RETRY_POLICY.retries).toBe(RESEARCH_RETRIES);
    expect(PLAN_RETRY_POLICY.retries).toBe(PLAN_RETRIES);
  });

  test("uses fail-fast policy for implement and test", () => {
    expect(IMPLEMENT_RETRY_POLICY.kind).toBe("fail-fast");
    expect(TEST_RETRY_POLICY.kind).toBe("fail-fast");
    expect(IMPLEMENT_RETRY_POLICY.retries).toBe(IMPLEMENT_RETRIES);
    expect(TEST_RETRY_POLICY.retries).toBe(TEST_RETRIES);
  });
});

describe("input signatures", () => {
  test("research signature changes when research inputs change", () => {
    const a = buildResearchInputSignature({
      unitId: "u1",
      unitName: "Unit",
      unitDescription: "Desc",
      unitCategory: "large",
      rfcSource: "docs/rfc.md",
      rfcSections: ["A"],
      referencePaths: ["docs/rfc.md"],
      evictionContext: null,
    });
    const b = buildResearchInputSignature({
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
    const a = buildPlanInputSignature({
      unitId: "u1",
      unitName: "Unit",
      unitDescription: "Desc",
      unitCategory: "large",
      acceptanceCriteria: ["AC1"],
      contextFilePath: "docs/research/u1.md",
      researchSummary: "summary",
      evictionContext: null,
    });
    const b = buildPlanInputSignature({
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
