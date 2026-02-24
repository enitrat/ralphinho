import React from "react";
import { Task } from "smithers-orchestrator";
import { z } from "zod";
import type { ClarificationSession } from "../cli/clarifications";

export const monitorOutputSchema = z.object({
  started: z.boolean(),
  status: z.string(),
});

export type MonitorOutput = z.infer<typeof monitorOutputSchema>;

export type MonitorProps = {
  dbPath: string;
  runId: string;
  config: any;
  clarificationSession: ClarificationSession | null;
  prompt: string;
  repoRoot: string;
};

type TaskStatus = "pending" | "running" | "completed" | "failed" | "blocked";

interface TaskInfo {
  id: string;
  nodeId: string;
  status: TaskStatus;
  iteration: number;
  output?: string;
}

/**
 * Monitor Smithers Component - OpenTUI Dashboard
 * 
 * Features:
 * - Real-time task list with status indicators  
 * - Navigate tasks with arrow keys
 * - View task details
 * - Overall workflow progress
 */
export function Monitor({
  dbPath,
  runId,
  config,
  prompt,
}: MonitorProps) {
  return (
    <Task
      id="monitor"
      output={monitorOutputSchema}
      continueOnFail={true}
    >
      {async () => {
        // Import OpenTUI
        const ot = await import("@opentui/core");
        const { createCliRenderer, BoxRenderable, TextRenderable, ScrollBoxRenderable } = ot;
        const RGBA = ot.RGBA;
        const { Database } = await import("bun:sqlite");

        // Create renderer
        const renderer = await createCliRenderer({
          useAlternateScreen: true,
          useMouse: false,
          exitOnCtrlC: false,
        });

        // State
        let tasks: TaskInfo[] = [];
        let selectedIndex = 0;
        let focus: "list" | "detail" = "list";
        let isRunning = true;

        // Colors
        const c = {
          running: RGBA.fromInts(59, 130, 246),
          completed: RGBA.fromInts(34, 197, 94),
          failed: RGBA.fromInts(239, 68, 68),
          blocked: RGBA.fromInts(234, 179, 8),
          pending: RGBA.fromInts(128, 128, 128),
          border: RGBA.fromInts(75, 85, 99),
          selected: RGBA.fromInts(6, 182, 212),
        };

        // Root
        const root = new BoxRenderable(renderer, {
          id: "root",
          border: true,
          title: ` Super Ralph: ${config.projectName || "Workflow"} `,
          width: "100%",
          height: "100%",
          flexDirection: "column",
        });
        renderer.root.add(root);

        // Header
        const header = new TextRenderable(renderer, {
          id: "header",
          content: `Run: ${runId.slice(0, 20)}... | ${prompt.slice(0, 40)}${prompt.length > 40 ? "..." : ""}`,
          height: 1,
        });
        root.add(header);

        // Stats line
        const statsText = new TextRenderable(renderer, {
          id: "stats",
          content: "Loading...",
          height: 1,
        });
        root.add(statsText);

        // Main content
        const content = new BoxRenderable(renderer, {
          id: "content",
          border: false,
          flexDirection: "row",
          flexGrow: 1,
          gap: 1,
        });
        root.add(content);

        // Task list
        const listBox = new BoxRenderable(renderer, {
          id: "listBox",
          border: true,
          title: " Tasks ",
          width: "45%",
          flexDirection: "column",
          borderColor: c.border,
        });
        content.add(listBox);

        const listScroll = new ScrollBoxRenderable(renderer, {
          id: "listScroll",
          flexGrow: 1,
          scrollY: true,
        });
        listBox.add(listScroll);

        const listContent = new TextRenderable(renderer, {
          id: "listContent",
          content: "Loading...",
        });
        listScroll.add(listContent);

        // Detail panel
        const detailBox = new BoxRenderable(renderer, {
          id: "detailBox",
          border: true,
          title: " Details ",
          flexGrow: 1,
          flexDirection: "column",
          borderColor: c.border,
        });
        content.add(detailBox);

        const detailScroll = new ScrollBoxRenderable(renderer, {
          id: "detailScroll",
          flexGrow: 1,
          scrollY: true,
        });
        detailBox.add(detailScroll);

        const detailContent = new TextRenderable(renderer, {
          id: "detailContent",
          content: "Select a task",
        });
        detailScroll.add(detailContent);

        // Footer
        const footer = new TextRenderable(renderer, {
          id: "footer",
          content: "↑↓: Navigate | Tab: Switch | Q: Quit",
          height: 1,
        });
        root.add(footer);

        // Status icons
        const icon = (s: TaskStatus) => {
          switch (s) {
            case "pending": return "○";
            case "running": return "◐";
            case "completed": return "✓";
            case "failed": return "✗";
            case "blocked": return "⊘";
          }
        };

        // Update display
        function update() {
          listBox.borderColor = focus === "list" ? c.selected : c.border;
          detailBox.borderColor = focus === "detail" ? c.selected : c.border;

          // Task list
          listContent.content = tasks.length 
            ? tasks.map((t, i) => {
                const sel = i === selectedIndex ? "> " : "  ";
                const name = t.nodeId.length > 30 ? t.nodeId.slice(0, 27) + "..." : t.nodeId;
                return `${sel}${icon(t.status)} ${name}`;
              }).join("\n")
            : "No tasks yet...";

          // Detail
          const task = tasks[selectedIndex];
          detailContent.content = task
            ? `Task: ${task.nodeId}\nStatus: ${task.status.toUpperCase()}\n\n${task.output || "No output"}`
            : "Select a task";

          // Stats
          const total = tasks.length;
          const running = tasks.filter(t => t.status === "running").length;
          const completed = tasks.filter(t => t.status === "completed").length;
          const failed = tasks.filter(t => t.status === "failed").length;
          statsText.content = `Total: ${total} | Running: ${running} | Completed: ${completed} | Failed: ${failed}`;

          renderer.requestRender();
        }

        // Poll database
        async function poll() {
          try {
            const db = new Database(dbPath, { readonly: true });
            const taskMap = new Map<string, TaskInfo>();

            // Query reports
            try {
              const rows = db.query(`SELECT node_id, status, summary FROM report WHERE run_id = ?`).all(runId) as any[];
              for (const row of rows) {
                const status: TaskStatus = row.status === "complete" ? "completed" : 
                                          row.status === "blocked" ? "blocked" : "running";
                taskMap.set(row.node_id, {
                  id: row.node_id,
                  nodeId: row.node_id,
                  status,
                  iteration: 0,
                  output: row.summary,
                });
              }
            } catch {}

            // Query land
            try {
              const rows = db.query(`SELECT node_id, merged, evicted, summary FROM land WHERE run_id = ?`).all(runId) as any[];
              for (const row of rows) {
                const status: TaskStatus = row.merged ? "completed" : row.evicted ? "failed" : "running";
                taskMap.set(row.node_id, {
                  id: row.node_id,
                  nodeId: row.node_id,
                  status,
                  iteration: 0,
                  output: row.summary,
                });
              }
            } catch {}

            db.close();

            tasks = Array.from(taskMap.values()).sort((a, b) => {
              if (a.status === "running" && b.status !== "running") return -1;
              if (a.status !== "running" && b.status === "running") return 1;
              return a.nodeId.localeCompare(b.nodeId);
            });

            if (selectedIndex >= tasks.length) selectedIndex = Math.max(0, tasks.length - 1);
          } catch {}
        }

        // Input handler
        renderer.prependInputHandler((seq: string) => {
          if (!isRunning) return false;

          if (seq === "q" || seq === "Q") {
            isRunning = false;
            renderer.destroy();
            return true;
          }

          if (seq === "\t") {
            focus = focus === "list" ? "detail" : "list";
            update();
            return true;
          }

          if (focus === "list") {
            switch (seq) {
              case "\x1b[A": // Up
                selectedIndex = Math.max(0, selectedIndex - 1);
                update();
                return true;
              case "\x1b[B": // Down
                selectedIndex = Math.min(tasks.length - 1, selectedIndex + 1);
                update();
                return true;
              case "\r":
              case "\n":
                focus = "detail";
                update();
                return true;
            }
          } else {
            switch (seq) {
              case "\x1b[A":
                detailScroll.scrollBy(-3, "step");
                return true;
              case "\x1b[B":
                detailScroll.scrollBy(3, "step");
                return true;
              case "\x1b":
                focus = "list";
                update();
                return true;
            }
          }
          return false;
        });

        // Initial render
        await poll();
        update();
        renderer.start();

        // Keep alive with polling
        while (isRunning) {
          await new Promise(r => setTimeout(r, 2000));
          if (!isRunning) break;
          await poll();
          update();
        }

        return { started: true, status: "stopped" };
      }}
    </Task>
  );
}
