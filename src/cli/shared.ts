/**
 * Shared CLI utilities — environment detection, config building, Smithers launching.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ── Path detection ────────────────────────────────────────────────────

const cliDir = import.meta.dir || dirname(fileURLToPath(import.meta.url));
export const ralphSourceRoot = dirname(dirname(cliDir));
export const runningFromSource = existsSync(
  join(ralphSourceRoot, "src/components/ScheduledWorkflow.tsx"),
);

// ── Arg parsing ───────────────────────────────────────────────────────

export type ParsedArgs = {
  positional: string[];
  flags: Record<string, string | boolean>;
};

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }

    flags[key] = next;
    i += 1;
  }

  return { positional, flags };
}

// ── Prompt input ──────────────────────────────────────────────────────

export async function readPromptInput(
  rawInput: string,
  cwd: string,
): Promise<{ promptText: string; promptSourcePath: string | null }> {
  if (rawInput === "-") {
    const stdin = await Bun.stdin.text();
    return { promptText: stdin.trim(), promptSourcePath: null };
  }

  const maybePath = resolve(cwd, rawInput);
  if (existsSync(maybePath)) {
    const content = await readFile(maybePath, "utf8");
    return { promptText: content.trim(), promptSourcePath: maybePath };
  }

  return { promptText: rawInput.trim(), promptSourcePath: null };
}

// ── Repo scanning ─────────────────────────────────────────────────────

export async function loadPackageScripts(
  repoRoot: string,
): Promise<Record<string, string>> {
  const packageJsonPath = join(repoRoot, "package.json");
  if (!existsSync(packageJsonPath)) return {};

  try {
    const parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      scripts?: Record<string, string>;
    };
    if (!parsed?.scripts || typeof parsed.scripts !== "object") return {};
    return parsed.scripts;
  } catch {
    return {};
  }
}

export function detectScriptRunner(
  repoRoot: string,
): "bun" | "pnpm" | "yarn" | "npm" {
  if (
    existsSync(join(repoRoot, "bun.lock")) ||
    existsSync(join(repoRoot, "bun.lockb"))
  )
    return "bun";
  if (existsSync(join(repoRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(repoRoot, "yarn.lock"))) return "yarn";
  return "npm";
}

export function scriptCommand(
  runner: "bun" | "pnpm" | "yarn" | "npm",
  scriptName: string,
): string {
  if (runner === "bun") return `bun run ${scriptName}`;
  if (runner === "pnpm") return `pnpm run ${scriptName}`;
  if (runner === "yarn") return `yarn ${scriptName}`;
  return `npm run ${scriptName}`;
}

export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project"
  );
}

export async function commandExists(
  command: string,
  cwd: string,
): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", command], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

export async function detectAgents(
  repoRoot: string,
): Promise<{ claude: boolean; codex: boolean; gh: boolean }> {
  const [claude, codex, gh] = await Promise.all([
    commandExists("claude", repoRoot),
    commandExists("codex", repoRoot),
    commandExists("gh", repoRoot),
  ]);
  return { claude, codex, gh };
}

export async function ensureJjAvailable(repoRoot: string) {
  const ok = await commandExists("jj", repoRoot);
  if (ok) return;

  throw new Error(
    [
      "jj is required before ralphinho can run.",
      "Install jj, then rerun this command.",
      "",
      "Install options:",
      "- macOS: brew install jj",
      "- Linux (cargo): cargo install --locked jj-cli",
      "- Verify: jj --version",
      "",
      "If this repo is not jj-colocated yet:",
      "- jj git init --colocate",
    ].join("\n"),
  );
}

// ── Config building ───────────────────────────────────────────────────

export function buildFallbackConfig(
  repoRoot: string,
  promptSpecPath: string,
  packageScripts: Record<string, string>,
) {
  const runner = detectScriptRunner(repoRoot);

  const buildCmds: Record<string, string> = {};
  const testCmds: Record<string, string> = {};

  if (packageScripts.typecheck)
    buildCmds.typecheck = scriptCommand(runner, "typecheck");
  if (packageScripts.build)
    buildCmds.build = scriptCommand(runner, "build");
  if (packageScripts.lint)
    buildCmds.lint = scriptCommand(runner, "lint");

  if (packageScripts.test)
    testCmds.test = scriptCommand(runner, "test");

  if (existsSync(join(repoRoot, "go.mod"))) {
    buildCmds.go = buildCmds.go ?? "go build ./...";
    buildCmds.govet = buildCmds.govet ?? "go vet ./...";
    testCmds.go = testCmds.go ?? "go test ./...";
  }

  if (existsSync(join(repoRoot, "Cargo.toml"))) {
    buildCmds.rust = buildCmds.rust ?? "cargo build";
    buildCmds.clippy = buildCmds.clippy ?? "cargo clippy -- -D warnings";
    testCmds.rust = testCmds.rust ?? "cargo test";
  }

  if (Object.keys(buildCmds).length === 0) {
    buildCmds.verify =
      runner === "bun"
        ? "bun run typecheck"
        : 'echo "Add build/typecheck command"';
  }

  if (Object.keys(testCmds).length === 0) {
    testCmds.tests =
      runner === "bun" ? "bun test" : 'echo "Add test command"';
  }

  const specsPathCandidates = [
    join(repoRoot, "docs/specs/engineering.md"),
    join(repoRoot, "docs/specs"),
    join(repoRoot, "specs"),
    promptSpecPath,
  ];
  const chosenSpecs =
    specsPathCandidates.find((c) => existsSync(c)) ?? promptSpecPath;

  const projectName = basename(repoRoot);
  const maxConcurrency = Math.min(
    Math.max(
      Number(process.env.WORKFLOW_MAX_CONCURRENCY ?? "6") || 6,
      1,
    ),
    32,
  );

  return {
    projectName,
    projectId: slugify(projectName),
    focuses: [
      { id: "core", name: "Core Platform" },
      { id: "api", name: "API and Data" },
      { id: "workflow", name: "Workflow and Automation" },
    ],
    specsPath: chosenSpecs,
    referenceFiles: [
      promptSpecPath,
      existsSync(join(repoRoot, "README.md")) ? "README.md" : "",
      existsSync(join(repoRoot, "docs")) ? "docs" : "",
    ].filter(Boolean),
    buildCmds,
    testCmds,
    preLandChecks: Object.values(buildCmds),
    postLandChecks: Object.values(testCmds),
    codeStyle:
      "Follow existing project conventions and keep changes minimal and test-driven.",
    reviewChecklist: [
      "Spec compliance",
      "Tests cover behavior changes",
      "No regression risk in existing flows",
      "Error handling and observability",
    ],
    maxConcurrency,
  };
}

// ── Repo config scanning (for scheduled-work) ────────────────────────

export interface RepoConfig {
  projectName: string;
  runner: "bun" | "pnpm" | "yarn" | "npm";
  buildCmds: Record<string, string>;
  testCmds: Record<string, string>;
  packageScripts: Record<string, string>;
}

export async function scanRepo(repoRoot: string): Promise<RepoConfig> {
  const packageScripts = await loadPackageScripts(repoRoot);
  const runner = detectScriptRunner(repoRoot);

  const buildCmds: Record<string, string> = {};
  const testCmds: Record<string, string> = {};

  if (packageScripts.typecheck)
    buildCmds.typecheck = scriptCommand(runner, "typecheck");
  if (packageScripts.build)
    buildCmds.build = scriptCommand(runner, "build");
  if (packageScripts.lint)
    buildCmds.lint = scriptCommand(runner, "lint");
  if (packageScripts.test)
    testCmds.test = scriptCommand(runner, "test");

  if (existsSync(join(repoRoot, "go.mod"))) {
    buildCmds.go = buildCmds.go ?? "go build ./...";
    buildCmds.govet = buildCmds.govet ?? "go vet ./...";
    testCmds.go = testCmds.go ?? "go test ./...";
  }
  if (existsSync(join(repoRoot, "Cargo.toml"))) {
    buildCmds.rust = buildCmds.rust ?? "cargo build";
    buildCmds.clippy = buildCmds.clippy ?? "cargo clippy -- -D warnings";
    testCmds.rust = testCmds.rust ?? "cargo test";
  }

  return {
    projectName: basename(repoRoot),
    runner,
    buildCmds,
    testCmds,
    packageScripts,
  };
}

// ── Smithers CLI ──────────────────────────────────────────────────────

export function findSmithersCliPath(repoRoot: string): string | null {
  const candidates = [
    join(
      repoRoot,
      "node_modules/smithers-orchestrator/src/cli/index.ts",
    ),
    resolve(
      dirname(import.meta.path),
      "../../node_modules/smithers-orchestrator/src/cli/index.ts",
    ),
    join(
      process.env.HOME || "",
      "smithers/src/cli/index.ts",
    ),
  ];

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

export async function launchSmithers(opts: {
  mode: "run" | "resume";
  workflowPath: string;
  repoRoot: string;
  runId: string;
  maxConcurrency: number;
  smithersCliPath: string;
}): Promise<number> {
  const {
    mode,
    workflowPath,
    repoRoot,
    runId,
    maxConcurrency,
    smithersCliPath,
  } = opts;

  let execCwd: string;
  if (runningFromSource) {
    execCwd = ralphSourceRoot;
  } else {
    const smithersDir = dirname(dirname(smithersCliPath));
    execCwd = existsSync(join(smithersDir, "node_modules"))
      ? smithersDir
      : repoRoot;
  }

  const superRalphPreload = join(ralphSourceRoot, "preload.ts");
  const useSharedPreload = existsSync(superRalphPreload);
  const preloadPath = join(dirname(workflowPath), "preload.ts");
  const effectivePreload = useSharedPreload
    ? superRalphPreload
    : preloadPath;

  const args = [
    "-r",
    effectivePreload,
    smithersCliPath,
    mode,
    workflowPath,
    "--root",
    repoRoot,
    "--run-id",
    runId,
    "--max-concurrency",
    String(maxConcurrency),
  ];

  const env = {
    ...process.env,
    USE_CLI_AGENTS: "1",
    SMITHERS_DEBUG: "1",
  };
  delete (env as any).CLAUDECODE;

  const proc = Bun.spawn(["bun", "--no-install", ...args], {
    cwd: execCwd,
    env: env as any,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });

  return proc.exited;
}

// ── Interactive prompt ────────────────────────────────────────────────

export async function promptChoice(
  message: string,
  options: string[],
): Promise<number> {
  console.log(message);
  for (let i = 0; i < options.length; i++) {
    console.log(`  ${i + 1}) ${options[i]}`);
  }
  process.stdout.write("\nChoice: ");

  const reader = Bun.stdin.stream().getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  const input = new TextDecoder().decode(value).trim();
  const choice = parseInt(input, 10);
  console.log();

  if (isNaN(choice) || choice < 1 || choice > options.length) {
    console.log(`Invalid choice "${input}", defaulting to 1.\n`);
    return 0;
  }
  return choice - 1;
}

// ── .ralphinho directory ──────────────────────────────────────────────

/** The project directory name for ralphinho artifacts */
export const RALPHINHO_DIR = ".ralphinho";

export function getRalphDir(repoRoot: string): string {
  return join(repoRoot, RALPHINHO_DIR);
}
