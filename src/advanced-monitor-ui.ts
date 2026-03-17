/**
 * Standalone OpenTUI Monitor UI logic.
 *
 * Layout:
 *  - Top: Phase indicator + global stats bar
 *  - Left: Pipeline kanban (per-unit stage progress)
 *  - Right: 3 stacked panels — Active Jobs | Event Log | Captured Logs
 *    Tab cycles focus between panels for scrolling.
 *
 * Shared between:
 *  - The Smithers <Monitor> component (in-workflow)
 *  - The standalone CLI launcher (for --resume)
 */

import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { DISPLAY_STAGES, TIER_STAGES, stageNodeId } from "./workflows/ralphinho/workflow/contracts";
import { readEventLog } from "./runtime/events";
import { pollEventsFromDb } from "./runtime/event-bridge";
import {
  projectEvents,
  type ActiveJob,
  type MergeQueueActivity,
  type PollData,
  type StageStatus,
  type TicketView,
  type WorkflowPhase,
} from "./runtime/projections";
import { incrementCounter, recordSpan } from "./runtime/observability";

// --- Constants ---

const PRIORITY_ABBR: Record<string, string> = { critical: "!!", high: "hi", medium: "md", low: "lo" };
const TIER_ABBR: Record<string, string> = { small: "sml", large: "lrg" };
const JOB_ABBR: Record<string, string> = {
  "discovery": "discover", "progress-update": "progress",
  "ticket:research": "research", "ticket:plan": "plan", "ticket:implement": "impl",
  "ticket:test": "test", "ticket:prd-review": "prd-rev",
  "ticket:code-review": "code-rev", "ticket:review-fix": "rev-fix", "ticket:final-review": "final",
};

// Stage detail: which column to SELECT for human-readable summary
const STAGE_SUMMARY_COL: Record<string, string> = {
  research: "context_file_path", plan: "plan_file_path", implement: "what_was_done",
  test: "failing_summary",
  prd_review: "severity", code_review: "severity",
  review_fix: "summary", final_review: "reasoning",
};

const PHASE_DISPLAY: Record<WorkflowPhase, { label: string; icon: string }> = {
  starting:     { label: "Starting",          icon: "\u23F3" },  // ⏳
  interpreting: { label: "Interpreting Config", icon: "\u2699" }, // ⚙
  discovering:  { label: "Loading Work Plan", icon: "\uD83D\uDD0D" }, // 🔍
  pipeline:     { label: "Pipeline Active",    icon: "\u25B6" },  // ▶
  merging:      { label: "Merge Queue",        icon: "\uD83D\uDD00" }, // 🔀
  done:         { label: "Complete",           icon: "\u2705" },  // ✅
};

interface TicketDetail {
  id: string;
  title: string;
  tier: string;
  priority: string;
  stages: Array<{ abbr: string; key: string; status: string; summary: string }>;
  landSummary?: string;
  decisionSummary?: string;
}

interface EventLogEntry {
  time: string;
  message: string;
}

// --- Ring Buffer for captured logs ---

class RingBuffer {
  private buf: string[] = [];
  private capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  push(line: string) {
    this.buf.push(line);
    if (this.buf.length > this.capacity) this.buf.shift();
  }

  getAll(): string[] {
    return [...this.buf];
  }

  get length(): number {
    return this.buf.length;
  }
}

// --- Helpers ---

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 2) + ".." : s;
}

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

function fmtTime(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function stageIcon(s: StageStatus): string {
  switch (s) {
    case "completed": return "\x1b[32m\u2713\x1b[0m";  // green ✓
    case "running":   return "\x1b[36m\u25D0\x1b[0m";  // cyan ◐
    case "failed":    return "\x1b[31m\u2717\x1b[0m";  // red ✗
    default:          return "\x1b[90m\u00B7\x1b[0m";  // gray ·
  }
}

type MonitorFocus = "pipeline" | "jobs" | "events" | "logs";

export function renderMonitorSnapshot(
  data: PollData,
  opts: {
    selectedIdx: number;
    hasError: boolean;
    focus: MonitorFocus;
  },
): {
  phaseLine: string;
  statsLine: string;
  pipelineText: string;
} {
  const phaseInfo = PHASE_DISPLAY[data.phase];
  let phaseExtra = "";
  if (data.phase === "discovering") {
    phaseExtra = data.discoveryCount > 0
      ? ` (plan loaded, ${data.discovered} units found)`
      : " (initial discovery...)";
  } else if (data.phase === "merging") {
    const mq = data.mergeQueueActivity;
    if (mq) {
      const parts: string[] = [];
      if (mq.ticketsLanded.length > 0) parts.push(`${mq.ticketsLanded.length} landed`);
      if (mq.ticketsEvicted.length > 0) parts.push(`${mq.ticketsEvicted.length} evicted`);
      if (parts.length > 0) phaseExtra = ` (${parts.join(", ")})`;
    }
  } else if (data.phase === "pipeline") {
    phaseExtra = ` (${data.inPipeline} in flight, ${data.landed} landed, ${data.semanticallyComplete} semantically complete)`;
  }

  const slots = data.maxConcurrency ? `${data.activeJobs.length}/${data.maxConcurrency}` : `${data.activeJobs.length}`;
  const errorIndicator = opts.hasError ? ` | \x1b[31mERR\x1b[0m` : "";
  const statsLine = `Units: ${data.discovered} | In Pipeline: ${data.inPipeline} | Landed: ${data.landed} | Semantic: ${data.semanticallyComplete} | Evicted: ${data.evicted} | Jobs: ${slots}${errorIndicator}`;

  if (data.phase === "starting" || data.phase === "interpreting") {
    return {
      phaseLine: `${phaseInfo.icon} ${phaseInfo.label}${phaseExtra}`,
      statsLine,
      pipelineText: [
        data.phase === "starting"
          ? "Workflow starting up..."
          : "AI is interpreting your prompt and configuring the pipeline...",
        "",
        "This usually takes 1-2 minutes.",
      ].join("\n"),
    };
  }

  if (data.phase === "discovering" && data.tickets.length === 0) {
    const lines = [
      "Loading units from work plan...",
      "",
      `Plan loads completed: ${data.discoveryCount}`,
    ];
    const discoverJob = data.activeJobs.find((job) => job.jobType === "discovery");
    if (discoverJob) lines.push("", `Running for ${fmtElapsed(discoverJob.elapsedMs)}`);

    return {
      phaseLine: `${phaseInfo.icon} ${phaseInfo.label}${phaseExtra}`,
      statsLine,
      pipelineText: lines.join("\n"),
    };
  }

  if (data.tickets.length === 0) {
    return {
      phaseLine: `${phaseInfo.icon} ${phaseInfo.label}${phaseExtra}`,
      statsLine,
      pipelineText: "Waiting for discovery...",
    };
  }

  const pipelineText = data.tickets.map((ticket, index) => {
    const sel = (index === opts.selectedIdx && opts.focus === "pipeline") ? "> " : "  ";
    const name = truncate(ticket.title || ticket.id, 20).padEnd(20);
    const stages = ticket.stages.map((stage) => stageIcon(stage.status)).join("");
    const tier = (TIER_ABBR[ticket.tier] || ticket.tier.slice(0, 3)).padEnd(3);
    const pri = PRIORITY_ABBR[ticket.priority] || ticket.priority.slice(0, 2);
    const land = ticket.landStatus === "landed" ? " \x1b[32m\u2714\x1b[0m" : ticket.landStatus === "evicted" ? " \x1b[31m\u2718\x1b[0m" : "";
    const decision = ticket.decisionStatus === "approved"
      ? " A"
      : ticket.decisionStatus === "rejected"
        ? " R"
        : ticket.decisionStatus === "invalidated"
          ? " !"
          : " -";
    const semantic = ticket.semanticallyComplete ? " S" : "";
    return `${sel}${name} [${stages}] ${tier} ${pri}${land}${decision}${semantic}`;
  }).join("\n");

  return {
    phaseLine: `${phaseInfo.icon} ${phaseInfo.label}${phaseExtra}`,
    statsLine,
    pipelineText,
  };
}

// --- Exports ---

export interface MonitorUIOptions {
  dbPath: string;
  runId: string;
  projectName: string;
  prompt: string;
  logFile?: string;
  eventLogPath?: string;
}

export async function runMonitorUI(opts: MonitorUIOptions): Promise<{ started: boolean; status: string }> {
  const { dbPath, runId, projectName, prompt } = opts;

  const ot = await import("@opentui/core");
  const { createCliRenderer, BoxRenderable, TextRenderable, ScrollBoxRenderable } = ot;
  const RGBA = ot.RGBA;
  const { Database } = await import("bun:sqlite");

  const workPlanPath = join(dirname(dbPath), "work-plan.json");
  const eventLogPath = opts.eventLogPath || join(dirname(dbPath), "events.ndjson");

  // ── Console capture ──
  const capturedLogs = new RingBuffer(200);
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  let logFileHandle: any = null;

  const logFilePath = opts.logFile || join(dirname(dbPath), "..", "monitor.log");
  try {
    logFileHandle = Bun.file(logFilePath).writer();
  } catch {
    // Can't open log file — captured logs still go to ring buffer
  }

  const captureWrite: typeof process.stdout.write = (chunk, _encodingOrCb?, _cb?) => {
    const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk as Uint8Array);
    for (const line of text.split("\n")) {
      const trimmed = line.trimEnd();
      if (trimmed) capturedLogs.push(`${fmtTime()} ${trimmed}`);
    }
    if (logFileHandle) {
      try { logFileHandle.write(text); } catch {}
    }
    return true;
  };

  process.stdout.write = captureWrite;
  process.stderr.write = captureWrite;

  function restoreConsole() {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    if (logFileHandle) {
      try { logFileHandle.flush(); logFileHandle.end(); } catch {}
    }
  }

  const renderer = await createCliRenderer({
    useAlternateScreen: true,
    useMouse: false,
    exitOnCtrlC: false,
  });

  // ── State ──
  let data: PollData = {
    tickets: [], activeJobs: [], discovered: 0, landed: 0, semanticallyComplete: 0, evicted: 0,
    inPipeline: 0, maxConcurrency: 0, phase: "starting",
    mergeQueueActivity: null, schedulerReasoning: null, discoveryCount: 0,
  };
  let selectedIdx = 0;
  // focus: pipeline = left panel; jobs/events/logs = right panels
  let focus: "pipeline" | "jobs" | "events" | "logs" = "pipeline";
  let detail: TicketDetail | null = null;
  let isRunning = true;
  let lastError: string | null = null;
  const eventLog: EventLogEntry[] = [];
  let prevPhase: WorkflowPhase = "starting";

  function addEvent(message: string) {
    eventLog.push({ time: fmtTime(), message });
    if (eventLog.length > 100) eventLog.shift();
  }

  addEvent("Monitor started");
  if (existsSync(workPlanPath)) {
    addEvent(`Work plan detected: ${workPlanPath}`);
  }

  // ── Colors ──
  const c = {
    border:   RGBA.fromInts(75, 85, 99),
    selected: RGBA.fromInts(6, 182, 212),
    phase:    RGBA.fromInts(168, 85, 247),
  };

  // ── Layout ──
const root = new BoxRenderable(renderer, {
    id: "root", border: true, title: ` Scheduled Work: ${projectName} `,
    width: "100%", height: "100%", flexDirection: "column",
  });
  renderer.root.add(root);

  // Phase + header
  const phaseText = new TextRenderable(renderer, {
    id: "phase", height: 1,
    content: `${PHASE_DISPLAY.starting.icon} ${PHASE_DISPLAY.starting.label}`,
  });
  root.add(phaseText);

  const header = new TextRenderable(renderer, {
    id: "header", height: 1,
    content: `Run: ${runId.slice(0, 20)}... | ${truncate(prompt, 50)}`,
  });
  root.add(header);

  const statsText = new TextRenderable(renderer, { id: "stats", height: 1, content: "Loading..." });
  root.add(statsText);

  const content = new BoxRenderable(renderer, {
    id: "content", border: false, flexDirection: "row", flexGrow: 1, gap: 1,
  });
  root.add(content);

  // ── Left: Pipeline ──
  const pipeBox = new BoxRenderable(renderer, {
    id: "pipeBox", border: true, title: " Pipeline ", width: "55%",
    flexDirection: "column", borderColor: c.selected,
  });
  content.add(pipeBox);

  const pipeScroll = new ScrollBoxRenderable(renderer, { id: "pipeScroll", flexGrow: 1, scrollY: true });
  pipeBox.add(pipeScroll);

  const pipeText = new TextRenderable(renderer, { id: "pipeText", content: "Waiting for discovery..." });
  pipeScroll.add(pipeText);

  // ── Right: 3 stacked panels ──
  // Use flexGrow only (no fixed height) so OpenTUI's flex column distributes
  // space correctly — mixing integer height with flexGrow siblings collapses them.
  const rightCol = new BoxRenderable(renderer, {
    id: "rightCol", border: false, flexGrow: 1, flexDirection: "column",
  });
  content.add(rightCol);

  // Panel 1: Active Jobs (1 share)
  const jobsBox = new BoxRenderable(renderer, {
    id: "jobsBox", border: true, title: " Active Jobs ", flexGrow: 1,
    flexDirection: "column", borderColor: c.border,
  });
  rightCol.add(jobsBox);

  const jobsScroll = new ScrollBoxRenderable(renderer, { id: "jobsScroll", flexGrow: 1, scrollY: true });
  jobsBox.add(jobsScroll);
  const jobsText = new TextRenderable(renderer, { id: "jobsText", content: "No active jobs" });
  jobsScroll.add(jobsText);

  // Panel 2: Event Log (flexible, bigger)
  const eventsBox = new BoxRenderable(renderer, {
    id: "eventsBox", border: true, title: " Event Log ", flexGrow: 2,
    flexDirection: "column", borderColor: c.border,
  });
  rightCol.add(eventsBox);

  const eventsScroll = new ScrollBoxRenderable(renderer, { id: "eventsScroll", flexGrow: 1, scrollY: true });
  eventsBox.add(eventsScroll);
  const eventsText = new TextRenderable(renderer, { id: "eventsText", content: "No events yet" });
  eventsScroll.add(eventsText);

  // Panel 3: Captured Logs (flexible)
  const logsBox = new BoxRenderable(renderer, {
    id: "logsBox", border: true, title: " Logs ", flexGrow: 1,
    flexDirection: "column", borderColor: c.border,
  });
  rightCol.add(logsBox);

  const logsScroll = new ScrollBoxRenderable(renderer, { id: "logsScroll", flexGrow: 1, scrollY: true });
  logsBox.add(logsScroll);
  const logsText = new TextRenderable(renderer, { id: "logsText", content: "No output captured" });
  logsScroll.add(logsText);

  const footer = new TextRenderable(renderer, {
    id: "footer", height: 1,
    content: "\u2191\u2193:Nav | Enter:Detail | Tab:Focus | Esc:Back | Q:Quit",
  });
  root.add(footer);

  // ── Update display ──
  function update() {
    // Focus borders
    pipeBox.borderColor = focus === "pipeline" ? c.selected : c.border;
    jobsBox.borderColor = (focus === "jobs" || focus === "detail" as any) ? c.selected : c.border;
    eventsBox.borderColor = focus === "events" ? c.selected : c.border;
    logsBox.borderColor = focus === "logs" ? c.selected : c.border;

    const rendered = renderMonitorSnapshot(data, {
      selectedIdx,
      hasError: Boolean(lastError),
      focus,
    });
    phaseText.content = rendered.phaseLine;
    statsText.content = rendered.statsLine;
    pipeText.content = rendered.pipelineText;

    // ── Jobs panel (or detail view) ──
    if (detail) {
      jobsBox.title = ` ${detail.id} `;
      const lines = [
        detail.title,
        `${detail.tier} | ${detail.priority}`,
        "",
        ...detail.stages.map(s => {
          const icon = stageIcon(s.status as StageStatus);
          const summary = s.summary ? `: ${truncate(s.summary, 35)}` : "";
          return `${s.abbr} ${icon} ${s.status}${summary}`;
        }),
      ];
      if (detail.landSummary) lines.push("", detail.landSummary);
      if (detail.decisionSummary) lines.push("", detail.decisionSummary);
      jobsText.content = lines.join("\n");
    } else {
      jobsBox.title = ` Active Jobs (${data.activeJobs.length}) `;
      if (data.activeJobs.length === 0) {
        if (data.phase === "starting" || data.phase === "interpreting") {
          jobsText.content = "Waiting for pipeline to start...";
        } else if (data.phase === "done") {
          jobsText.content = "\x1b[32mAll work complete!\x1b[0m";
        } else {
          jobsText.content = "No active jobs";
        }
      } else {
        const lines = data.activeJobs.map(j => {
          const type = JOB_ABBR[j.jobType] || j.jobType.replace("ticket:", "");
          const label = j.ticketId ? `${j.ticketId}:${type}` : type;
          const icon = j.jobType === "discovery" ? "\uD83D\uDD0D"
                     : j.jobType.startsWith("ticket:") ? "\u25D0"
                     : "\u2699";
          return `${icon} ${truncate(label, 22).padEnd(22)} ${fmtElapsed(j.elapsedMs)}`;
        });

        if (data.mergeQueueActivity) {
          const mq = data.mergeQueueActivity;
          lines.push("", "\x1b[1mMerge Queue:\x1b[0m");
          for (const t of mq.ticketsLanded) lines.push(`  \x1b[32m\u2714\x1b[0m ${t.ticketId}: ${truncate(t.summary, 35)}`);
          for (const t of mq.ticketsEvicted) lines.push(`  \x1b[31m\u2718\x1b[0m ${t.ticketId}: ${truncate(t.reason, 35)}`);
          for (const t of mq.ticketsSkipped) lines.push(`  \x1b[90m\u2014\x1b[0m ${t.ticketId}: ${truncate(t.reason, 35)}`);
        }

        jobsText.content = lines.join("\n");
      }
    }

    // ── Event Log panel ──
    eventsBox.title = ` Event Log (${eventLog.length}) `;
    eventsText.content = eventLog.length === 0
      ? "No events yet"
      : eventLog.slice(-40).reverse().map(e => `${e.time} ${e.message}`).join("\n");

    // ── Logs panel ──
    logsBox.title = ` Logs (${capturedLogs.length}) `;
    const logLines = capturedLogs.getAll();
    logsText.content = logLines.length === 0
      ? "No output captured"
      : logLines.slice(-40).join("\n");

    renderer.requestRender();
  }

  // ── Fetch ticket detail (on-demand) ──
  async function fetchDetail(ticketId: string) {
    try {
      const db = new Database(dbPath, { readonly: true });
      const ticket = data.tickets.find(t => t.id === ticketId);
      if (!ticket) { db.close(); return; }

      const tierStages = TIER_STAGES[ticket.tier] || TIER_STAGES.large;
      const stages: TicketDetail["stages"] = [];

      for (const sd of DISPLAY_STAGES) {
        if (!tierStages.includes(sd.key)) continue;
        const stageView = ticket.stages.find(s => s.key === sd.key);
        let summary = "";
        if (stageView?.status === "completed" || stageView?.status === "failed") {
          const col = STAGE_SUMMARY_COL[sd.table] || "summary";
          try {
            const row = db.query(`SELECT ${col} FROM ${sd.table} WHERE run_id = ? AND node_id = ? ORDER BY iteration DESC LIMIT 1`)
              .get(runId, stageNodeId(ticketId, sd.key)) as any;
            if (row) summary = String(row[col] ?? "");
          } catch (err) {
            summary = `(query failed: ${err instanceof Error ? err.message : "unknown"})`;
          }
        }
        stages.push({ abbr: sd.abbr, key: sd.key, status: stageView?.status || "pending", summary });
      }

      const landSummary = ticket.landStatus === "landed"
        ? "Landed on base branch"
        : ticket.landStatus === "evicted"
          ? "Evicted from merge queue"
          : undefined;
      const decisionSummary = [
        `Decision: ${ticket.decisionStatus}`,
        ticket.decisionReasoning ? truncate(ticket.decisionReasoning, 120) : null,
        ticket.approvalOnlyCorrectedFormatting ? "Approval only repaired formatting after a rejection." : null,
        ticket.approvalSupersededRejection ? "Approval superseded a real earlier rejection." : null,
        ticket.semanticallyComplete ? "Semantically complete." : "Not yet semantically complete.",
      ].filter(Boolean).join(" ");

      db.close();
      detail = { id: ticket.id, title: ticket.title, tier: ticket.tier, priority: ticket.priority, stages, landSummary, decisionSummary };
    } catch (err) {
      lastError = `Detail fetch failed: ${err instanceof Error ? err.message : "unknown"}`;
    }
  }

  // ── Poll projection source ──
  async function poll() {
    const now = Date.now();
    lastError = null;

    if (!existsSync(dbPath) && !existsSync(eventLogPath)) {
      data = { ...data, phase: "starting" };
      return;
    }

    try {
      const events = existsSync(eventLogPath)
        ? await readEventLog(eventLogPath)
        : await pollEventsFromDb(dbPath, runId, workPlanPath);
      const nextData = projectEvents(events, now);
      incrementCounter("monitor.poll");

      // Log phase transitions
      if (nextData.phase !== prevPhase) {
        addEvent(`Phase: ${PHASE_DISPLAY[nextData.phase].label}`);
        if (nextData.phase === "discovering" && prevPhase === "interpreting") addEvent("Initialization complete — loading work plan");
        else if (nextData.phase === "pipeline" && prevPhase === "discovering") addEvent(`Units loaded (${nextData.tickets.length}) — pipeline starting`);
        else if (nextData.phase === "merging") addEvent("Merge queue activated — landing completed units");
        else if (nextData.phase === "done") addEvent(`All ${nextData.tickets.length} units landed — workflow complete`);
        prevPhase = nextData.phase;
      }

      if (data.landed < nextData.landed) addEvent(`${nextData.landed - data.landed} unit(s) landed (total: ${nextData.landed}/${nextData.tickets.length})`);
      if (data.evicted < nextData.evicted) addEvent(`${nextData.evicted - data.evicted} unit(s) evicted`);
      if (data.discovered < nextData.tickets.length) addEvent(`${nextData.tickets.length - data.discovered} new unit(s) loaded (total: ${nextData.tickets.length})`);

      data = nextData;

      if (selectedIdx >= data.tickets.length) selectedIdx = Math.max(0, data.tickets.length - 1);
    } catch (err) {
      lastError = `Poll failed: ${err instanceof Error ? err.message : "unknown"}`;
      recordSpan("monitor.poll.error", {
        run_id: runId,
        message: lastError,
      });
    }
  }

  // ── Shutdown ──
  function shutdown() {
    isRunning = false;
    restoreConsole();
    renderer.destroy();
  }

  // ── Input handler ──
  renderer.prependInputHandler((seq: string) => {
    if (!isRunning) return false;

    if (seq === "\x03" || seq === "q" || seq === "Q") {
      shutdown();
      return true;
    }

    // Tab — cycle focus: pipeline → jobs → events → logs → pipeline
    if (seq === "\t") {
      const modes: Array<typeof focus> = ["pipeline", "jobs", "events", "logs"];
      const base = focus;
      const idx = modes.indexOf(base);
      focus = modes[(idx + 1) % modes.length];
      // Clear detail when leaving jobs panel
      if (focus !== "jobs") detail = null;
      update();
      return true;
    }

    // Esc — back to pipeline, clear detail
    if (seq === "\x1b") {
      focus = "pipeline";
      detail = null;
      update();
      return true;
    }

    // Pipeline navigation
    if (focus === "pipeline") {
      if (seq === "\x1b[A") { selectedIdx = Math.max(0, selectedIdx - 1); update(); return true; }
      if (seq === "\x1b[B") { selectedIdx = Math.min(data.tickets.length - 1, selectedIdx + 1); update(); return true; }
      if (seq === "\r" || seq === "\n") {
        const t = data.tickets[selectedIdx];
        if (t) {
          focus = "jobs";
          fetchDetail(t.id).then(update);
        }
        return true;
      }
    }

    // Scroll in focused right panel
    const scrollMap: Record<string, any> = { jobs: jobsScroll, events: eventsScroll, logs: logsScroll };
    const activeScroll = scrollMap[focus];
    if (activeScroll) {
      if (seq === "\x1b[A") { activeScroll.scrollBy(-3, "step"); return true; }
      if (seq === "\x1b[B") { activeScroll.scrollBy(3, "step"); return true; }
    }

    return false;
  });

  // ── Main loop ──
  await poll();
  update();
  renderer.start();

  while (isRunning) {
    const interval = data.activeJobs.length > 0 ? 1500 : 3000;
    await new Promise(r => setTimeout(r, interval));
    if (!isRunning) break;
    await poll();
    update();
  }

  restoreConsole();
  return { started: true, status: "stopped" };
}
