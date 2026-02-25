/**
 * ralphinho init super-ralph — Initialize an intent-driven autonomous workflow.
 *
 * Wraps the existing super-ralph flow:
 * 1. Read prompt (inline text or file)
 * 2. Optional clarifying questions
 * 3. Generate Smithers workflow file
 * 4. Write .ralphinho/config.json
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  buildFallbackConfig,
  detectAgents,
  ensureJjAvailable,
  findSmithersCliPath,
  getRalphDir,
  loadPackageScripts,
  ralphSourceRoot,
  readPromptInput,
  runningFromSource,
  type ParsedArgs,
} from "./shared";
import type { RalphinhoConfig } from "../scheduled/types";

export async function initSuperRalph(opts: {
  positional: string[];
  flags: ParsedArgs["flags"];
  repoRoot: string;
}): Promise<void> {
  const { positional, flags, repoRoot } = opts;

  console.log("🚀 ralphinho — Super Ralph Mode\n");

  // ── Read prompt ─────────────────────────────────────────────────────
  const rawInput = positional.join(" ").trim();
  if (!rawInput) {
    console.error("Error: Prompt text or file path is required.");
    console.error(
      'Usage: ralphinho init super-ralph "Build a monitoring dashboard"',
    );
    process.exit(1);
  }

  const { promptText, promptSourcePath } = await readPromptInput(
    rawInput,
    repoRoot,
  );
  if (!promptText) {
    console.error("Error: Prompt input is empty.");
    process.exit(1);
  }

  // ── Check prerequisites ─────────────────────────────────────────────
  await ensureJjAvailable(repoRoot);

  const smithersCliPath = findSmithersCliPath(repoRoot);
  if (!smithersCliPath) {
    console.error(
      "Error: Could not find smithers CLI. Install smithers-orchestrator:\n  bun add smithers-orchestrator",
    );
    process.exit(1);
  }

  // ── Detect agents ───────────────────────────────────────────────────
  const agents = await detectAgents(repoRoot);
  if (!agents.claude && !agents.codex) {
    console.error(
      "Error: No supported agent CLI detected. Install claude and/or codex.",
    );
    process.exit(1);
  }

  console.log(`  Repo: ${repoRoot}`);
  console.log(`  Prompt: ${promptSourcePath || "inline"}`);
  console.log(
    `  Agents: claude=${agents.claude} codex=${agents.codex}`,
  );

  // ── Set up directories ──────────────────────────────────────────────
  const ralphDir = getRalphDir(repoRoot);
  const generatedDir = join(ralphDir, "generated");
  await mkdir(generatedDir, { recursive: true });

  const promptSpecPath = join(generatedDir, "PROMPT.md");
  const packageScripts = await loadPackageScripts(repoRoot);
  const fallbackConfig = buildFallbackConfig(
    repoRoot,
    promptSpecPath,
    packageScripts,
  );

  // Write prompt to file
  await writeFile(promptSpecPath, `${promptText.trim()}\n`, "utf8");

  // ── Clarifying questions ────────────────────────────────────────────
  let clarificationSession: any = null;
  if (!flags["skip-questions"]) {
    try {
      const { runClarifyingQuestions } = await import(
        "./clarifying-questions"
      );
      clarificationSession = await runClarifyingQuestions(
        promptText,
        repoRoot,
        packageScripts,
      );
    } catch (e: any) {
      console.log(
        `  Skipping questions (${e.message}). Proceeding without clarifications.\n`,
      );
    }
  }

  // ── Generate workflow file ──────────────────────────────────────────
  const workflowPath = join(generatedDir, "workflow.tsx");
  const dbPath = join(ralphDir, "workflow.db");

  const workflowSource = renderSuperRalphWorkflow({
    promptText,
    promptSpecPath,
    repoRoot,
    dbPath,
    packageScripts,
    detectedAgents: { claude: agents.claude, codex: agents.codex },
    fallbackConfig,
    clarificationSession,
  });

  await writeFile(workflowPath, workflowSource, "utf8");

  // Ensure node_modules symlink
  const generatedNodeModules = join(generatedDir, "node_modules");
  const sourceNodeModules = join(ralphSourceRoot, "node_modules");
  if (
    !existsSync(generatedNodeModules) &&
    existsSync(sourceNodeModules)
  ) {
    try {
      const { symlinkSync } = await import("fs");
      symlinkSync(sourceNodeModules, generatedNodeModules, "dir");
    } catch {
      // ignore
    }
  }

  // Create preload
  const preloadPath = join(generatedDir, "preload.ts");
  const bunfigPath = join(generatedDir, "bunfig.toml");
  const superRalphPreload = join(ralphSourceRoot, "preload.ts");
  if (!existsSync(superRalphPreload)) {
    await writeFile(
      preloadPath,
      `import { mdxPlugin } from "smithers-orchestrator/mdx-plugin";\n\nmdxPlugin();\n`,
      "utf8",
    );
  }
  await writeFile(
    bunfigPath,
    `preload = ["./preload.ts"]\n`,
    "utf8",
  );

  // ── Write config ────────────────────────────────────────────────────
  const maxConcurrency =
    typeof flags["max-concurrency"] === "string"
      ? Math.max(1, Number(flags["max-concurrency"]) || 6)
      : 6;

  const config: RalphinhoConfig = {
    mode: "super-ralph",
    repoRoot,
    promptText,
    agents,
    maxConcurrency,
    createdAt: new Date().toISOString(),
  };

  const configPath = join(ralphDir, "config.json");
  await writeFile(
    configPath,
    JSON.stringify(config, null, 2) + "\n",
    "utf8",
  );

  console.log(`\n  Written:`);
  console.log(`    ${configPath}`);
  console.log(`    ${workflowPath}`);
  console.log();

  if (flags["dry-run"]) {
    console.log("  (dry-run: workflow not executed)\n");
    return;
  }

  console.log(`  Run: ralphinho run\n`);
}

// ── Workflow renderer (preserved from original CLI) ───────────────────

function renderSuperRalphWorkflow(params: {
  promptText: string;
  promptSpecPath: string;
  repoRoot: string;
  dbPath: string;
  packageScripts: Record<string, string>;
  detectedAgents: { claude: boolean; codex: boolean };
  fallbackConfig: any;
  clarificationSession: any | null;
}): string {
  const {
    promptText,
    promptSpecPath,
    repoRoot,
    dbPath,
    packageScripts,
    detectedAgents,
    fallbackConfig,
    clarificationSession,
  } = params;

  const isSuperRalphRepo =
    existsSync(join(repoRoot, "src/components/SuperRalph.tsx")) &&
    existsSync(join(repoRoot, "src/schemas.ts"));

  let importPrefix: string;
  if (isSuperRalphRepo) {
    importPrefix = "../../src";
  } else if (runningFromSource) {
    importPrefix = ralphSourceRoot + "/src";
  } else {
    importPrefix = "super-ralph";
  }

  return `import React from "react";
import { createSmithers, ClaudeCodeAgent, CodexAgent, Sequence, Parallel } from "smithers-orchestrator";
import { SuperRalph } from "${importPrefix}";
import { InterpretConfig, Monitor } from "${importPrefix}/components";
import { ralphOutputSchemas } from "${importPrefix}";

const REPO_ROOT = ${JSON.stringify(repoRoot)};
const DB_PATH = ${JSON.stringify(dbPath)};
const HAS_CLAUDE = ${detectedAgents.claude};
const HAS_CODEX = ${detectedAgents.codex};
const PROMPT_TEXT = ${JSON.stringify(promptText)};
const PROMPT_SPEC_PATH = ${JSON.stringify(promptSpecPath)};
const PACKAGE_SCRIPTS = ${JSON.stringify(packageScripts, null, 2)};
const FALLBACK_CONFIG = ${JSON.stringify(fallbackConfig, null, 2)};
const CLARIFICATION_SESSION = ${JSON.stringify(clarificationSession)};

const { smithers, outputs, Workflow } = createSmithers(
  ralphOutputSchemas,
  { dbPath: DB_PATH }
);

function createClaude(systemPrompt: string) {
  return new ClaudeCodeAgent({
    model: "claude-sonnet-4-6",
    systemPrompt,
    cwd: REPO_ROOT,
    dangerouslySkipPermissions: true,
    timeoutMs: 60 * 60 * 1000,
  });
}

function createCodex(systemPrompt: string) {
  return new CodexAgent({
    model: "gpt-5.3-codex",
    systemPrompt,
    cwd: REPO_ROOT,
    yolo: true,
    timeoutMs: 60 * 60 * 1000,
  });
}

function choose(primary: "claude" | "codex", systemPrompt: string) {
  if (primary === "claude" && HAS_CLAUDE) return createClaude(systemPrompt);
  if (primary === "codex" && HAS_CODEX) return createCodex(systemPrompt);
  if (HAS_CLAUDE) return createClaude(systemPrompt);
  return createCodex(systemPrompt);
}

const planningAgent = choose("claude", "Plan and research next tickets.");
const implementationAgent = choose("claude", "Implement with test-driven development and jj workflows.");
const testingAgent = choose("claude", "Run tests and validate behavior changes.");
const reviewingAgent = choose("codex", "Review for regressions, spec drift, and correctness.");
const reportingAgent = choose("claude", "Write concise, accurate ticket status reports.");

export default smithers((ctx) => {
  const interpretedConfig = ctx.outputMaybe("interpret_config", { nodeId: "interpret-config" }) ?? FALLBACK_CONFIG;

  return (
    <Workflow name="super-ralph-full">
      <Sequence>
        <InterpretConfig
          prompt={PROMPT_TEXT}
          clarificationSession={CLARIFICATION_SESSION}
          repoRoot={REPO_ROOT}
          fallbackConfig={FALLBACK_CONFIG}
          packageScripts={PACKAGE_SCRIPTS}
          detectedAgents={{
            claude: HAS_CLAUDE,
            codex: HAS_CODEX,
            gh: false,
          }}
          agent={planningAgent}
        />

        <Parallel>
          <SuperRalph
            ctx={ctx}
            outputs={outputs}
            repoRoot={REPO_ROOT}
            {...interpretedConfig}
            agents={{
              planning: { agent: planningAgent, description: "Plan and research next tickets." },
              implementation: { agent: implementationAgent, description: "Implement with test-driven development and jj workflows." },
              testing: { agent: testingAgent, description: "Run tests and validate behavior changes." },
              reviewing: { agent: reviewingAgent, description: "Review for regressions, spec drift, and correctness." },
              reporting: { agent: reportingAgent, description: "Write concise, accurate ticket status reports." },
            }}
          />

          <Monitor
            dbPath={DB_PATH}
            runId={ctx.runId}
            config={interpretedConfig}
            clarificationSession={CLARIFICATION_SESSION}
            prompt={PROMPT_TEXT}
            repoRoot={REPO_ROOT}
          />
        </Parallel>
      </Sequence>
    </Workflow>
  );
});
`;
}
