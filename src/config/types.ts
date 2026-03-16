import { z } from "zod";

const agentAvailabilitySchema = z.object({
  claude: z.boolean(),
  codex: z.boolean(),
  gh: z.boolean(),
});

const baseConfigSchema = z.object({
  repoRoot: z.string(),
  agents: agentAvailabilitySchema,
  maxConcurrency: z.number(),
  createdAt: z.string(),
});

export const scheduledWorkConfigSchema = baseConfigSchema.extend({
  mode: z.literal("scheduled-work"),
  rfcPath: z.string(),
  baseBranch: z.string().default("main"),
});

export const reviewDiscoveryConfigSchema = baseConfigSchema.extend({
  mode: z.literal("review-discovery"),
  reviewInstruction: z.string(),
  reviewInstructionSource: z.string().nullable(),
  reviewPaths: z.array(z.string()),
});

export const ralphinhoConfigSchema = z.discriminatedUnion("mode", [
  scheduledWorkConfigSchema,
  reviewDiscoveryConfigSchema,
]);

export type AgentAvailability = z.infer<typeof agentAvailabilitySchema>;
export type ScheduledWorkConfig = z.infer<typeof scheduledWorkConfigSchema>;
export type ReviewDiscoveryConfig = z.infer<typeof reviewDiscoveryConfigSchema>;
export type RalphinhoConfig = z.infer<typeof ralphinhoConfigSchema>;
