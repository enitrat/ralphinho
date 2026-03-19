import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  workPlanSchema,
  type WorkPlan,
} from "./workflows/ralphinho/types";
import {
  ralphinhoConfigSchema,
  reviewDiscoveryConfigSchema,
  scheduledWorkConfigSchema,
  type RalphinhoConfig,
  type ReviewDiscoveryConfig,
  type ScheduledWorkConfig,
} from "./config/types";
import { reviewPlanSchema, type ReviewPlan } from "./workflows/improvinho/types";

export type ScheduledPresetPaths = {
  ralphDir: string;
  configPath: string;
  planPath: string;
  dbPath: string;
};

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) {
    throw new Error(
      `Missing ${key}. Launch the scheduled-work preset through \`ralphinho run\`.`,
    );
  }
  return value;
}

export function resolveScheduledPresetPaths(
  env: NodeJS.ProcessEnv = process.env,
): ScheduledPresetPaths {
  const ralphDir = resolve(requireEnv(env, "RALPHINHO_DIR"));

  return {
    ralphDir,
    configPath: resolve(env.RALPHINHO_CONFIG_PATH ?? join(ralphDir, "config.json")),
    planPath: resolve(env.RALPHINHO_PLAN_PATH ?? join(ralphDir, "work-plan.json")),
    dbPath: resolve(env.RALPHINHO_DB_PATH ?? join(ralphDir, "workflow.db")),
  };
}

function loadJsonFile<T>(path: string, label: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load ${label} at ${path}: ${message}`);
  }
}

export function loadScheduledPreset(env: NodeJS.ProcessEnv = process.env): {
  paths: ScheduledPresetPaths;
  config: ScheduledWorkConfig;
  workPlan: WorkPlan;
} {
  const paths = resolveScheduledPresetPaths(env);
  const config = scheduledWorkConfigSchema.parse(
    loadJsonFile<RalphinhoConfig>(paths.configPath, "ralphinho config"),
  );
  const workPlan = workPlanSchema.parse(
    loadJsonFile<WorkPlan>(paths.planPath, "work plan"),
  );

  // Inject baseBranch from config into the work plan so that Worktree
  // components receive it without every consumer having to merge manually.
  workPlan.baseBranch = config.baseBranch;

  return {
    paths,
    config,
    workPlan,
  };
}

export function loadReviewPreset(env: NodeJS.ProcessEnv = process.env): {
  paths: ScheduledPresetPaths;
  config: ReviewDiscoveryConfig;
  reviewPlan: ReviewPlan;
} {
  const paths = resolveScheduledPresetPaths(env);
  const config = reviewDiscoveryConfigSchema.parse(
    loadJsonFile<RalphinhoConfig>(paths.configPath, "ralphinho config"),
  );
  const reviewPlan = reviewPlanSchema.parse(
    loadJsonFile<ReviewPlan>(paths.planPath, "review plan"),
  );

  return {
    paths,
    config,
    reviewPlan,
  };
}
