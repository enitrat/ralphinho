/**
 * MRE: Nested <Ralph>/<Loop> — reproduces "Nested <Ralph> is not supported."
 *
 * This is the exact pattern the smithers author said should work:
 *   <Ralph id="outer" until={...}>
 *     <Sequence>
 *       <Ralph id="inner" until={...}>
 *         <Task .../>
 *       </Ralph>
 *     </Sequence>
 *   </Ralph>
 *
 * Run:  bun run src/mre-nested-ralph.tsx
 */
import React from "react";
import { z } from "zod";
import {
  createSmithers,
  Sequence,
  Loop,
  Task,
  runWorkflow,
  type AgentLike,
} from "smithers-orchestrator";

// ── Minimal output schema ───────────────────────────────────────────
const outputA = z.object({ value: z.number() });
const schemas = { outputA };

// ── Stub agent that just echoes back ────────────────────────────────
const stubAgent: AgentLike = {
  id: "stub",
  generate: async ({ outputSchema }) => {
    // Return a value matching the schema
    return { value: 1 };
  },
};

// ── Create smithers API ─────────────────────────────────────────────
const { smithers, outputs, Workflow } = createSmithers(schemas, {
  dbPath: "/tmp/mre-nested-ralph.db",
});

// ── Workflow: exact pattern from the author's example ───────────────
const workflow = smithers((ctx) => {
  const innerResult = ctx.latest("outputA", "innerTask");
  const innerFinished = innerResult != null;

  return (
    <Workflow name="nested-ralph-mre">
      <Loop id="outer" until={false} maxIterations={2} onMaxReached="return-last">
        <Sequence>
          <Loop id="inner" until={innerFinished} maxIterations={2} onMaxReached="return-last">
            <Task id="innerTask" output={outputs.outputA} agent={stubAgent}>
              Return a JSON object with a "value" field set to 1.
            </Task>
          </Loop>
        </Sequence>
      </Loop>
    </Workflow>
  );
});

// ── Run it ───────────────────────────────────────────────────────────
console.log("Running MRE: nested <Loop> inside <Sequence> inside <Loop>...\n");

try {
  const result = await runWorkflow(workflow, {
    input: {},
    onProgress: (e) => {
      if (e.type === "task:complete" || e.type === "error") {
        console.log(`  [${e.type}]`, JSON.stringify(e).slice(0, 120));
      }
    },
  });
  console.log("\n✅ Workflow completed:", result.status);
} catch (err: any) {
  console.error("\n❌ Workflow failed:", err.message);
  if (err.message.includes("Nested")) {
    console.error(
      "\n→ This confirms that even with <Sequence> between the two <Loop>s,\n" +
      "  smithers still rejects nested <Ralph>/<Loop>.\n" +
      "  The author's example does NOT work on the current version.",
    );
  }
  process.exit(1);
}
