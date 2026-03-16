import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildReviewPlan } from "./plan";

const createdDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("buildReviewPlan", () => {
  test("dedupes overlapping paths in favor of the more specific slice", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "super-ralph-plan-"));
    createdDirs.push(repoRoot);

    await mkdir(join(repoRoot, "src", "api"), { recursive: true });
    await writeFile(join(repoRoot, "src", "api", "auth.ts"), "export const auth = true;\n", "utf8");

    const plan = await buildReviewPlan({
      repoRoot,
      instruction: "Review for bugs and security issues",
      promptSourcePath: null,
      explicitPaths: ["src", "src/api/auth.ts"],
      repoConfig: {
        projectName: "fixture",
        runner: "bun",
        buildCmds: {},
        testCmds: {},
        packageScripts: {},
      },
    });

    expect(plan.slices).toHaveLength(1);
    expect(plan.slices[0]?.path).toBe("src/api/auth.ts");
    expect(plan.slices[0]?.focusAreas).toContain("bugs");
    expect(plan.slices[0]?.focusAreas).toContain("security");
  });

  test("adds one cross-cutting slice when multiple bounded paths are reviewed", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "super-ralph-plan-"));
    createdDirs.push(repoRoot);

    await mkdir(join(repoRoot, "src", "api"), { recursive: true });
    await mkdir(join(repoRoot, "src", "lib"), { recursive: true });
    await writeFile(join(repoRoot, "src", "api", "auth.ts"), "export const auth = true;\n", "utf8");
    await writeFile(join(repoRoot, "src", "lib", "token.ts"), "export const token = true;\n", "utf8");

    const plan = await buildReviewPlan({
      repoRoot,
      instruction: "Review for bugs, architecture issues, and simplification opportunities",
      promptSourcePath: null,
      explicitPaths: ["src/api/auth.ts", "src/lib/token.ts"],
      repoConfig: {
        projectName: "fixture",
        runner: "bun",
        buildCmds: {},
        testCmds: {},
        packageScripts: {},
      },
    });

    expect(plan.slices).toHaveLength(3);
    expect(plan.slices.filter((slice) => slice.mode === "slice")).toHaveLength(2);
    const crossCutting = plan.slices.find((slice) => slice.mode === "cross-cutting");
    expect(crossCutting).toBeDefined();
    expect(crossCutting?.entryType).toBe("virtual");
    expect(crossCutting?.focusAreas).toContain("architecture");
    expect(crossCutting?.focusAreas).toContain("simplification");
    expect(crossCutting?.inferredPaths).toEqual(["src/lib/token.ts"]);
  });
});
