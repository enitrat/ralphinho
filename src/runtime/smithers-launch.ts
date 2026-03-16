import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

import { ralphSourceRoot, runningFromSource } from "../cli/shared";

export type LaunchMode = "run" | "resume";

export type LaunchOptions = {
  mode: LaunchMode;
  workflowPath: string;
  repoRoot: string;
  maxConcurrency: number;
  smithersCliPath: string;
  envOverrides?: Record<string, string>;
  force?: boolean;
  runId?: string;
};

export type LaunchConfig = {
  cmd: string[];
  cwd: string;
  env: Record<string, string>;
};

type BuildLaunchRuntime = {
  runningFromSource: boolean;
  ralphSourceRoot: string;
  env: NodeJS.ProcessEnv;
  hasSharedPreload?: boolean;
  hasSmithersNodeModules?: boolean;
};

function normalizeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") normalized[key] = value;
  }
  return normalized;
}

function resolveSmithersBinFromPackage(pkgPath: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      bin?: string | Record<string, string>;
    };

    const smithersBin =
      typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.smithers;
    if (!smithersBin) return null;

    return join(dirname(pkgPath), smithersBin);
  } catch {
    return null;
  }
}

export function findSmithersEntrypoint(fromDir?: string): string | null {
  // 1. Check SMITHERS_SOURCE_ROOT env var (local checkout, no install needed)
  const sourceRoot = process.env.SMITHERS_SOURCE_ROOT;
  if (sourceRoot) {
    const pkgPath = join(resolve(sourceRoot), "package.json");
    if (existsSync(pkgPath)) {
      const result = resolveSmithersBinFromPackage(pkgPath);
      if (result) return result;
    }
  }

  // 2. Standard module resolution from the target repo
  const require = createRequire(fromDir ?? import.meta.url);
  try {
    const pkgPath = require.resolve("smithers-orchestrator/package.json");
    return resolveSmithersBinFromPackage(pkgPath);
  } catch {
    return null;
  }
}

export const resolveSmithersCliPath = findSmithersEntrypoint;

export function buildLaunchConfig(
  opts: LaunchOptions,
  runtime?: Partial<BuildLaunchRuntime>,
): LaunchConfig {
  const env = runtime?.env ?? process.env;
  const sourceRoot = runtime?.ralphSourceRoot ?? ralphSourceRoot;
  const sourceMode = runtime?.runningFromSource ?? runningFromSource;

  const smithersDir = dirname(dirname(opts.smithersCliPath));
  const hasSmithersNodeModules =
    runtime?.hasSmithersNodeModules ?? existsSync(join(smithersDir, "node_modules"));

  const cwd = sourceMode
    ? sourceRoot
    : hasSmithersNodeModules
      ? smithersDir
      : opts.repoRoot;

  const sharedPreload = join(sourceRoot, "preload.ts");
  const hasSharedPreload = runtime?.hasSharedPreload ?? existsSync(sharedPreload);
  const workflowPreload = join(dirname(opts.workflowPath), "preload.ts");

  const cmd = [
    "bun",
    "--no-install",
    "-r",
    hasSharedPreload ? sharedPreload : workflowPreload,
    opts.smithersCliPath,
    opts.mode,
    opts.workflowPath,
    "--root",
    opts.repoRoot,
    ...(opts.runId ? ["--run-id", opts.runId] : []),
    "--max-concurrency",
    String(opts.maxConcurrency),
    ...(opts.force ? ["--force"] : []),
  ];

  const launchEnv: Record<string, string> = {
    ...normalizeEnv(env),
    ...opts.envOverrides,
    USE_CLI_AGENTS: "1",
  };
  delete launchEnv.CLAUDECODE;

  return {
    cmd,
    cwd,
    env: launchEnv,
  };
}

export async function launchSmithers(opts: LaunchOptions): Promise<number> {
  const config = buildLaunchConfig(opts);
  const proc = Bun.spawn(config.cmd, {
    cwd: config.cwd,
    env: config.env,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  return proc.exited;
}
