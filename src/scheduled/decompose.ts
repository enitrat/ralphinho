/**
 * RFC Decomposition — AI-powered RFC → work units + dependency DAG.
 *
 * Takes an RFC file content and repo context, calls the Anthropic API
 * to produce a structured WorkPlan with parallelizable work units.
 */

import type { RepoConfig } from "../cli/shared";
import { workPlanSchema, type WorkPlan, type WorkUnit, validateDAG, computeLayers } from "./types";

const DECOMPOSE_SYSTEM_PROMPT = `You are a senior software architect decomposing an RFC/PRD into executable work units for an automated AI development pipeline.

Your job is to:
1. Read the RFC carefully and identify all discrete deliverables
2. Break them into work units that can be implemented independently
3. Determine dependency relationships between units
4. Assign complexity tiers based on scope
5. Write concrete acceptance criteria for each unit

## Rules

- Each work unit should be a single, cohesive piece of work
- Work units should be as independent as possible to maximize parallelism
- Dependencies should only exist where there's a real code dependency (shared types, imports, etc.)
- Don't create artificial sequential ordering — if two units can be done in parallel, they should have no deps between them
- Acceptance criteria must be verifiable (not vague like "works correctly")

## Complexity Tiers

- **trivial**: Config changes, metadata updates, file deletions, re-exports. No logic changes.
- **small**: Single-file changes with clear scope. Adding exports, simple refactors, thin wrappers.
- **medium**: Multi-file features, API changes, refactors touching 3-5 files. Needs research and review.
- **large**: Architectural changes, new subsystems, security-sensitive work. Needs full pipeline.

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

Decompose this RFC into work units. Maximize parallelism — only add dependencies where there's a real code dependency. Return ONLY the JSON object.`;
}

/**
 * Decompose an RFC into work units using the Anthropic API.
 */
export async function decomposeRFC(
  rfcContent: string,
  repoConfig: RepoConfig,
): Promise<{ plan: WorkPlan; layers: WorkUnit[][] }> {
  const prompt = buildDecomposePrompt(rfcContent, repoConfig);

  const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let spinIdx = 0;
  const spinInterval = setInterval(() => {
    process.stdout.write(
      `\r${spinner[spinIdx++ % spinner.length]} Decomposing RFC into work units...`,
    );
  }, 80);

  let rawResult: string;
  try {
    rawResult = await callAI(prompt);
  } finally {
    clearInterval(spinInterval);
    process.stdout.write("\r\x1b[K");
  }

  // Parse the JSON response
  let jsonStr = rawResult;
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) jsonStr = fenceMatch[1];

  let parsed: any;
  try {
    parsed = JSON.parse(jsonStr.trim());
  } catch (e: any) {
    throw new Error(
      `Failed to parse AI response as JSON: ${e.message}\n\nRaw response:\n${rawResult.slice(0, 500)}`,
    );
  }

  // Validate units
  const units: WorkUnit[] = parsed.units;
  if (!Array.isArray(units) || units.length === 0) {
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

  // Validate against schema
  workPlanSchema.parse(plan);

  const layers = computeLayers(units);

  return { plan, layers };
}

/**
 * Call the Anthropic API (or fall back to claude CLI).
 */
async function callAI(prompt: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (apiKey) {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 8192,
        system: DECOMPOSE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!resp.ok) {
      throw new Error(`Anthropic API ${resp.status}: ${await resp.text()}`);
    }

    const data = (await resp.json()) as any;
    const text = data.content?.[0]?.text ?? "";
    if (!text.trim()) throw new Error("Empty API response");
    return text;
  }

  // Fallback to claude CLI
  console.log("  (no API key, falling back to claude CLI...)\n");
  const claudeEnv = { ...process.env, ANTHROPIC_API_KEY: "" };
  delete (claudeEnv as any).CLAUDECODE;

  const fullPrompt = `${DECOMPOSE_SYSTEM_PROMPT}\n\n${prompt}`;
  const proc = Bun.spawn(
    [
      "claude",
      "--print",
      "--output-format",
      "text",
      "--model",
      "claude-sonnet-4-6",
      fullPrompt,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: claudeEnv,
    },
  );

  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;

  if (code !== 0 || !out.trim()) {
    throw new Error(`claude CLI failed (code ${code}): ${err}`);
  }

  return out.trim();
}

/**
 * Pretty-print a work plan summary to the console.
 */
export function printPlanSummary(
  plan: WorkPlan,
  layers: WorkUnit[][],
): void {
  const tierCounts = { trivial: 0, small: 0, medium: 0, large: 0 };
  for (const u of plan.units) {
    tierCounts[u.tier]++;
  }

  console.log(
    `\n  Generated ${plan.units.length} work units in ${layers.length} parallelizable layers\n`,
  );

  console.log("  Tiers:");
  for (const [tier, count] of Object.entries(tierCounts)) {
    if (count > 0) console.log(`    ${tier}: ${count}`);
  }

  console.log("\n  Execution layers (units in same layer run in parallel):");
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    const names = layer.map((u) => u.id).join(", ");
    console.log(`    Layer ${i}: [${names}]`);
  }

  console.log();
}
