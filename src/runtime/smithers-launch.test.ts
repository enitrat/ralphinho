import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildLaunchConfig, resolveSmithersCliPath } from "./smithers-launch";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "smithers-launch-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

describe("resolveSmithersCliPath", () => {
  test("resolves smithers CLI from smithers-orchestrator package bin field", async () => {
    const root = await makeTempDir();
    const pkgDir = join(root, "node_modules", "smithers-orchestrator");
    await mkdir(pkgDir, { recursive: true });

    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ bin: { smithers: "dist/cli.js" } }),
      "utf8",
    );

    const resolved = resolveSmithersCliPath(join(root, "entry.ts"));

    expect(resolved).toEndWith("/node_modules/smithers-orchestrator/dist/cli.js");
  });

  test("returns null when smithers-orchestrator is not installed", async () => {
    const root = await makeTempDir();

    const resolved = resolveSmithersCliPath(join(root, "entry.ts"));

    expect(resolved).toBeNull();
  });

  test("does not return legacy source-tree smithers path", async () => {
    const root = await makeTempDir();
    const pkgDir = join(root, "node_modules", "smithers-orchestrator");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ bin: { smithers: "bin/smithers.js" } }),
      "utf8",
    );

    const resolved = resolveSmithersCliPath(join(root, "entry.ts"));

    expect(resolved).not.toContain("smithers-orchestrator/src/cli/index.ts");
  });
});

describe("buildLaunchConfig", () => {
  test("builds run command and sanitizes env", () => {
    const config = buildLaunchConfig(
      {
        mode: "run",
        workflowPath: "/super-ralph/src/preset.tsx",
        repoRoot: "/repo",
        runId: "run-123",
        maxConcurrency: 7,
        smithersCliPath: "/repo/node_modules/smithers-orchestrator/dist/cli.js",
        envOverrides: {
          RALPHINHO_DIR: "/repo/.ralphinho",
          RALPHINHO_CONFIG_PATH: "/repo/.ralphinho/config.json",
        },
      },
      {
        runningFromSource: false,
        ralphSourceRoot: "/super-ralph",
        env: {
          PATH: "/bin",
          CLAUDECODE: "1",
        },
        hasSharedPreload: true,
        hasSmithersNodeModules: false,
      },
    );

    expect(config.cmd).toEqual([
      "bun",
      "--no-install",
      "-r",
      "/super-ralph/preload.ts",
      "/repo/node_modules/smithers-orchestrator/dist/cli.js",
      "run",
      "/super-ralph/src/preset.tsx",
      "--root",
      "/repo",
      "--run-id",
      "run-123",
      "--max-concurrency",
      "7",
    ]);
    expect(config.cwd).toBe("/repo");
    expect(config.env.USE_CLI_AGENTS).toBe("1");
    expect(config.env.CLAUDECODE).toBeUndefined();
    expect(config.env.RALPHINHO_DIR).toBe("/repo/.ralphinho");
    expect(config.env.RALPHINHO_CONFIG_PATH).toBe("/repo/.ralphinho/config.json");
  });

  test("builds resume command with --force and source-mode cwd", () => {
    const config = buildLaunchConfig(
      {
        mode: "resume",
        workflowPath: "/super-ralph/src/preset.tsx",
        repoRoot: "/repo",
        runId: "run-456",
        maxConcurrency: 3,
        smithersCliPath: "/repo/node_modules/smithers-orchestrator/dist/cli.js",
        force: true,
        envOverrides: {
          RALPHINHO_DIR: "/repo/.ralphinho",
        },
      },
      {
        runningFromSource: true,
        ralphSourceRoot: "/super-ralph",
        env: {
          PATH: "/bin",
        },
        hasSharedPreload: true,
        hasSmithersNodeModules: true,
      },
    );

    expect(config.cmd).toEqual([
      "bun",
      "--no-install",
      "-r",
      "/super-ralph/preload.ts",
      "/repo/node_modules/smithers-orchestrator/dist/cli.js",
      "resume",
      "/super-ralph/src/preset.tsx",
      "--root",
      "/repo",
      "--run-id",
      "run-456",
      "--max-concurrency",
      "3",
      "--force",
    ]);
    expect(config.cwd).toBe("/super-ralph");
  });
});
