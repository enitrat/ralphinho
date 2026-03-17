/**
 * RFC Decomposition — AI-powered RFC → work units + dependency DAG.
 *
 * Takes an RFC file content and repo context, calls an AI agent
 * to produce a structured WorkPlan with parallelizable work units.
 */

import { ClaudeCodeAgent } from "smithers-orchestrator";
import type { RepoConfig } from "../../cli/shared";
import {
  workPlanSchema,
  workUnitSchema,
  type WorkPlan,
  type WorkUnit,
  validateDAG,
  computeLayers,
} from "./types";

/** Default model used when none is specified by the caller. */
const DEFAULT_MODEL = "claude-sonnet-4-6";

const DECOMPOSE_SYSTEM_PROMPT = `You are a senior software architect decomposing an RFC/PRD into executable work units for an automated AI development pipeline.

Your job is to:
1. Read the RFC carefully and identify all discrete deliverables
2. Break them into work units that can be implemented independently
3. Determine dependency relationships between units
4. Assign complexity tiers based on scope
5. Write concrete acceptance criteria for each unit

## Rules

- Each work unit should be a single, cohesive piece of work
- **Prefer fewer, cohesive units over many granular ones.** Only split when units touch genuinely independent files. Each unit adds pipeline overhead (research, plan, implement, test, review) and merge risk. A larger unit that touches 5 related files is better than 3 small units that conflict at merge time.
- **Minimize cross-unit file overlap.** If two units would modify the same file, strongly prefer combining them into one unit. Cross-unit file overlap causes merge conflicts that require expensive re-runs.
- Dependencies should only exist where there's a real code dependency (shared types, imports, etc.)
- Don't create artificial sequential ordering — if two units can be done in parallel, they should have no deps between them
- Acceptance criteria must be verifiable (not vague like "works correctly")
- **Tests are part of the work unit, not a follow-on unit.** Do NOT create separate "write tests for X" units. Tests for a behavior are written alongside that behavior in the same unit. A unit that adds a feature includes both the implementation and the tests. A unit that fixes a bug includes the reproducing test and the fix. Never decompose "implement X" + "test X" as two separate units.

## Complexity Tiers

- **small**: Single-file or few-file changes with clear scope. Config tweaks, simple refactors, thin wrappers, adding exports.
- **large**: Multi-file features, API changes, architectural work, security-sensitive changes. Needs full pipeline with research and planning.

## Output Format

Return ONLY valid JSON matching this schema:
{
  "units": [
    {
      "id": "kebab-case-id",
      "name": "Human Readable Name",
      "rfcSections": ["§3", "§3.2"],
      "description": "What needs to be done, in detail",
      "deps": ["other-unit-id"],
      "acceptance": ["specific verifiable criterion"],
      "tier": "small"
    }
  ]
}`;

function buildDecomposePrompt(
  rfcContent: string,
  repoConfig: RepoConfig,
): string {
  const repoInfo = [
    `Project: ${repoConfig.projectName}`,
    `Package manager: ${repoConfig.runner}`,
    repoConfig.buildCmds && Object.keys(repoConfig.buildCmds).length > 0
      ? `Build commands: ${Object.entries(repoConfig.buildCmds).map(([k, v]) => `${k}: ${v}`).join(", ")}`
      : null,
    repoConfig.testCmds && Object.keys(repoConfig.testCmds).length > 0
      ? `Test commands: ${Object.entries(repoConfig.testCmds).map(([k, v]) => `${k}: ${v}`).join(", ")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  return `## Repository Context

${repoInfo}

## RFC Content

${rfcContent}

## Task

Decompose this RFC into work units. Prefer fewer cohesive units over many granular ones — minimize cross-unit file overlap to avoid merge conflicts. Only add dependencies where there's a real code dependency. Return ONLY the JSON object.`;
}

export interface DecomposeOptions {
  /** Model to use for the AI agent. Defaults to DEFAULT_MODEL. */
  model?: string;
  /** Absolute path to the repo root. Used as the agent's working directory. */
  repoRoot?: string;
}

/**
 * Decompose an RFC into work units using an AI agent.
 */
export async function decomposeRFC(
  rfcContent: string,
  repoConfig: RepoConfig,
  options: DecomposeOptions = {},
): Promise<{ plan: WorkPlan; layers: WorkUnit[][] }> {
  const prompt = buildDecomposePrompt(rfcContent, repoConfig);
  const rawResult = await callAI(prompt, {
    model: options.model ?? DEFAULT_MODEL,
    repoRoot: options.repoRoot ?? process.cwd(),
  });

  // Parse the JSON response
  let jsonStr = rawResult;
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) jsonStr = fenceMatch[1];

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr.trim());
  } catch (e: any) {
    throw new Error(
      `Failed to parse AI response as JSON: ${e.message}\n\nRaw response:\n${rawResult.slice(0, 500)}`,
    );
  }

  // Validate top-level shape before accessing .units
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("units" in parsed) ||
    !Array.isArray((parsed as { units: unknown }).units)
  ) {
    throw new Error(
      "AI response missing 'units' array.\n\nRaw response:\n" +
        rawResult.slice(0, 500),
    );
  }

  // Validate each unit against the schema before further processing
  const rawUnits = (parsed as { units: unknown[] }).units;
  const units: WorkUnit[] = rawUnits.map((u, i) => {
    const result = workUnitSchema.safeParse(u);
    if (!result.success) {
      throw new Error(
        `Work unit at index ${i} failed validation: ${result.error.message}`,
      );
    }
    return result.data;
  });

  if (units.length === 0) {
    throw new Error("AI returned no work units");
  }

  // Validate DAG
  const dagResult = validateDAG(units);
  if (!dagResult.valid) {
    throw new Error(
      `Invalid dependency graph:\n${dagResult.errors.join("\n")}`,
    );
  }

  const plan: WorkPlan = {
    source: "", // caller fills this
    generatedAt: new Date().toISOString(),
    repo: {
      projectName: repoConfig.projectName,
      buildCmds: repoConfig.buildCmds,
      testCmds: repoConfig.testCmds,
    },
    units,
  };

  // Validate against full schema
  workPlanSchema.parse(plan);

  const layers = computeLayers(units);

  return { plan, layers };
}

/**
 * Call AI via ClaudeCodeAgent (wraps the claude CLI).
 *
 * NOTE: This uses ClaudeCodeAgent directly rather than the createClaude() factory
 * from preset.tsx because decomposition runs during `init` — before any Smithers
 * workflow is configured — so it needs a standalone, short-lived agent with a
 * decomposition-specific system prompt and shorter timeout (5 min vs 60 min).
 */
async function callAI(
  prompt: string,
  config: { model: string; repoRoot: string },
): Promise<string> {
  const agent = new ClaudeCodeAgent({
    model: config.model,
    systemPrompt: DECOMPOSE_SYSTEM_PROMPT,
    cwd: config.repoRoot,
    dangerouslySkipPermissions: true,
    timeoutMs: 5 * 60 * 1000,
  });

  const result = await agent.generate({ prompt });
  if (!result.text.trim()) throw new Error("Empty agent response");
  return result.text;
}
