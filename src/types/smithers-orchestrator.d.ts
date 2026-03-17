declare module "smithers-orchestrator" {
  import type React from "react";

  export type AgentLike = unknown;

  export type SmithersCtx<Outputs = Record<string, unknown>> = {
    runId: string;
    iteration: number;
    latest: (table: keyof Outputs | string, nodeId: string) => any;
    fresh?: (table: keyof Outputs | string, nodeId: string, iteration: number) => any;
  };

  export type TaskProps<Row> = {
    key?: string;
    id: string;
    output: any;
    agent?: AgentLike | AgentLike[];
    fallbackAgent?: AgentLike;
    skipIf?: boolean;
    needsApproval?: boolean;
    timeoutMs?: number;
    retries?: number;
    continueOnFail?: boolean;
    label?: string;
    meta?: Record<string, unknown>;
    children: string | Row | (() => Row | Promise<Row>) | React.ReactNode;
  };

  export function Task<Row>(props: TaskProps<Row>): React.ReactElement | null;
  export function Sequence(props: { children?: React.ReactNode }): React.ReactElement | null;
  export function Parallel(props: { children?: React.ReactNode; maxConcurrency?: number }): React.ReactElement | null;
  export function Ralph(props: {
    children?: React.ReactNode;
    until: boolean;
    maxIterations: number;
    onMaxReached?: string;
  }): React.ReactElement | null;
  export function Worktree(props: {
    path: string;
    branch: string;
    children?: React.ReactNode;
  }): React.ReactElement | null;

  export interface ClaudeCodeAgentOptions {
    /** Model identifier, e.g. "claude-sonnet-4-6" or "claude-opus-4-6". */
    model: string;
    /** System prompt prepended to every conversation turn. */
    systemPrompt?: string;
    /** Working directory for the agent. */
    cwd?: string;
    /** Skip interactive permission prompts (for headless/CI use). */
    dangerouslySkipPermissions?: boolean;
    /** Hard timeout for the entire agent run, in milliseconds. */
    timeoutMs?: number;
    /** Timeout for idle periods (no output) within a run, in milliseconds. */
    idleTimeoutMs?: number;
    /** Additional options passed through to the underlying CLI. */
    [key: string]: unknown;
  }

  export class ClaudeCodeAgent {
    constructor(options: ClaudeCodeAgentOptions);
    generate(options: {
      prompt: string;
      [key: string]: unknown;
    }): Promise<{ text: string; [key: string]: unknown }>;
  }

  export class CodexAgent {
    constructor(options: Record<string, unknown>);
  }

  export function createSmithers<Outputs extends Record<string, any>>(
    schemas: Outputs,
    options?: Record<string, unknown>,
  ): {
    smithers: (workflow: (ctx: SmithersCtx<Outputs>) => React.ReactElement) => unknown;
    outputs: Outputs;
    Workflow: (props: { name: string; cache?: boolean; children?: React.ReactNode }) => React.ReactElement;
  };
}
