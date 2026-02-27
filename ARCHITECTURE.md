# Super-Ralph-Lite Architecture

Complete technical documentation of the pipeline. No secrets.

---

## Documentation Structure

The architecture documentation is split into three files:

| Document | Scope |
|----------|-------|
| **[CONCEPTS.md](CONCEPTS.md)** | Common infrastructure shared by all workflows: Smithers engine, agent system, jj VCS, worktree isolation, complexity tiers, quality pipeline stages, merge queue, two-database architecture, CLI. |
| **[SUPER_RALPH.md](SUPER_RALPH.md)** | The intent-driven, AI-scheduled workflow. Takes a free-form prompt, dynamically discovers tickets, uses an AI scheduler to drive execution through a tier-dependent quality pipeline. |
| **[SCHEDULED_WORK.md](SCHEDULED_WORK.md)** | The RFC-driven, deterministic workflow. Takes an RFC/PRD document, decomposes it into work units with a dependency DAG, and executes them in topological order. |

## Quick Comparison

| Aspect | Super-Ralph | Scheduled Work |
|--------|------------|----------------|
| Input | Free-form prompt | RFC/PRD document |
| Work discovery | AI discovers tickets at runtime | AI decomposes RFC upfront |
| Scheduling | AI scheduler (dynamic) | DAG layers (deterministic) |
| Human control | Clarifying questions pre-run | Edit work-plan.json pre-run |
| Init command | `ralphinho init super-ralph "prompt"` | `ralphinho init scheduled-work ./rfc.md` |
