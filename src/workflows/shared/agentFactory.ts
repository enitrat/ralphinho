import { ClaudeCodeAgent, CodexAgent } from "smithers-orchestrator";

export interface AgentFactoryOptions {
  repoRoot: string;
  workspacePolicy: string;
  executionPolicy: string;
  idleTimeoutMs: number;
}

export interface AgentFactory {
  createClaude: (role: string, model?: string) => ClaudeCodeAgent;
  createCodex: (role: string, model: string, reasoningEffort?: string) => CodexAgent;
}

export function createAgentFactory(options: AgentFactoryOptions): AgentFactory {
  const { repoRoot, workspacePolicy, executionPolicy, idleTimeoutMs } = options;

  function buildSystemPrompt(role: string): string {
    return ["# Role: " + role, workspacePolicy, executionPolicy].join("\n\n");
  }

  function createClaude(role: string, model = "claude-sonnet-4-6"): ClaudeCodeAgent {
    return new ClaudeCodeAgent({
      model,
      systemPrompt: buildSystemPrompt(role),
      cwd: repoRoot,
      dangerouslySkipPermissions: true,
      timeoutMs: 60 * 60 * 1000,
      idleTimeoutMs,
    });
  }

  function createCodex(role: string, model: string, reasoningEffort?: string): CodexAgent {
    return new CodexAgent({
      model,
      systemPrompt: buildSystemPrompt(role),
      cwd: repoRoot,
      yolo: true,
      timeoutMs: 60 * 60 * 1000,
      idleTimeoutMs,
      ...(reasoningEffort && {
        config: {
          model_reasoning_effort: reasoningEffort,
        },
      }),
    });
  }

  return { createClaude, createCodex };
}
