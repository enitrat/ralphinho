/**
 * Clarifying questions — generate and collect user answers.
 * Extracted from the original CLI for reuse in init-super-ralph.
 */

import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getRalphDir } from "./shared";

export async function runClarifyingQuestions(
  promptText: string,
  repoRoot: string,
  packageScripts: Record<string, string>,
): Promise<any> {
  const scriptsBlock = Object.entries(packageScripts)
    .map(([name, cmd]) => `- ${name}: ${cmd}`)
    .join("\n");

  const questionGenPrompt = `You are a senior product consultant helping a user define exactly what they want before a team of AI agents spends hours or even days building it. This is a long-running, expensive automated workflow — getting the requirements right NOW saves enormous time and cost later.

The user may not fully know what they want yet. That's normal. Your job is to:
- Help them think through what they actually need (not just what they said)
- Surface edge cases and decisions they haven't considered
- Make opinionated suggestions when choices have clear best practices
- Ask about scope, priorities, and tradeoffs — not technical implementation

User's request: "${promptText}"
Repository: ${repoRoot}
Available scripts: ${scriptsBlock || "(none)"}

Generate 10-15 clarifying questions. Be thorough — this is the user's only chance to steer the project before autonomous agents take over for a potentially multi-hour or multi-day build.

Focus areas:
- Core features and behavior (what does the user actually see and do?)
- Scope and MVP boundaries (what's in v1 vs later?)
- User experience details (loading states, error handling, empty states)
- Data and persistence (what gets saved, where, for how long?)
- Edge cases the user hasn't thought about
- Priorities and tradeoffs (speed vs polish, features vs simplicity)
- Success criteria (how do we know it's done?)

GOOD questions (product-focused, opinionated):
- "Should todos persist between browser sessions, or is in-memory fine for a demo?"
- "What happens when the list is empty — blank screen, or a friendly prompt?"
- "Is this a quick prototype or something you'd ship to real users?"

BAD questions (tech decisions — NEVER ask these, the AI agents decide):
- "What state management library should we use?"
- "Should we use TypeScript or JavaScript?"
- "What testing framework do you prefer?"

Each question should have 2-6 choices. Make the choices opinionated — the first choice should be your recommended default.

Return ONLY valid JSON (no markdown fences, no commentary):
{"questions":[{"question":"...","choices":[{"label":"...","description":"...","value":"..."}]}]}`;

  const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let spinIdx = 0;
  const spinInterval = setInterval(() => {
    process.stdout.write(
      `\r${spinner[spinIdx++ % spinner.length]} Generating clarifying questions...`,
    );
  }, 80);

  let claudeResult: string;
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("no-api-key");

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: 4096,
        messages: [{ role: "user", content: questionGenPrompt }],
      }),
    });

    clearInterval(spinInterval);
    process.stdout.write("\r\x1b[K");

    if (!resp.ok)
      throw new Error(`API ${resp.status}: ${await resp.text()}`);
    const data = (await resp.json()) as any;
    claudeResult = data.content?.[0]?.text ?? "";
    if (!claudeResult.trim()) throw new Error("Empty API response");
  } catch {
    clearInterval(spinInterval);
    process.stdout.write("\r\x1b[K");

    console.log(
      "  (API call failed, falling back to claude CLI...)\n",
    );
    const claudeEnv = { ...process.env, ANTHROPIC_API_KEY: "" };
    delete (claudeEnv as any).CLAUDECODE;
    const fallbackProc = Bun.spawn(
      [
        "claude",
        "--print",
        "--output-format",
        "text",
        "--model",
        "claude-opus-4-6",
        questionGenPrompt,
      ],
      {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
        env: claudeEnv,
      },
    );
    const fallbackOut = await new Response(fallbackProc.stdout).text();
    const fallbackErr = await new Response(fallbackProc.stderr).text();
    const fallbackCode = await fallbackProc.exited;
    if (fallbackCode !== 0 || !fallbackOut.trim()) {
      throw new Error(
        `claude --print failed (code ${fallbackCode}): ${fallbackErr}`,
      );
    }
    claudeResult = fallbackOut.trim();
  }

  // Parse JSON response
  let questions: any[];
  try {
    let jsonStr = claudeResult;
    const fenceMatch = jsonStr.match(
      /```(?:json)?\s*\n?([\s\S]*?)\n?```/,
    );
    if (fenceMatch) jsonStr = fenceMatch[1];
    const parsed = JSON.parse(jsonStr.trim());
    questions = parsed.questions;
    if (!Array.isArray(questions) || questions.length === 0) {
      throw new Error("No questions in response");
    }
  } catch {
    console.error(
      "  Failed to parse questions, using fallback.",
    );
    const { getClarificationQuestions } = await import(
      "./clarifications"
    );
    questions = getClarificationQuestions();
  }

  console.log(`  Generated ${questions.length} questions\n`);

  // Write questions to temp file and launch interactive UI
  const tempDir = join(getRalphDir(repoRoot), "temp");
  await mkdir(tempDir, { recursive: true });

  const sessionId = randomUUID();
  const questionsPath = join(
    tempDir,
    `questions-${sessionId}.json`,
  );
  const answersPath = join(tempDir, `answers-${sessionId}.json`);

  await writeFile(
    questionsPath,
    JSON.stringify({ questions }, null, 2),
  );

  const cliDir = import.meta.dir;
  const interactiveScript = join(cliDir, "interactive-questions.ts");
  const uiProc = Bun.spawn(
    ["bun", interactiveScript, questionsPath, answersPath],
    {
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
      cwd: repoRoot,
    },
  );
  const uiCode = await uiProc.exited;
  if (uiCode !== 0) {
    throw new Error(`Interactive UI exited with code ${uiCode}`);
  }

  const answersJson = await readFile(answersPath, "utf8");
  const { answers } = JSON.parse(answersJson);

  const summary = answers
    .map(
      (a: any, i: number) => `${i + 1}. ${a.question}\n   → ${a.answer}`,
    )
    .join("\n\n");

  // Cleanup
  try {
    await Promise.all([unlink(questionsPath), unlink(answersPath)]);
  } catch {
    // ignore
  }

  return { answers, summary };
}
