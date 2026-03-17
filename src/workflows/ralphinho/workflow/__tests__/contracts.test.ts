import { describe, expect, test } from "bun:test";
import {
  STAGE_RETRY_POLICIES,
  stageNodeId,
} from "../contracts";

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
