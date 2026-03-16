/**
 * Core Linear operations hook — mirrors smithers' src/linear/useLinear.ts.
 * Uses Effect for structured concurrency and logging.
 * All lazy SDK relations are resolved into plain serializable objects.
 */

import { Effect } from "effect";
import { getLinearClient } from "./client";
import type { LinearIssue, LinearTeam, LinearLabel } from "./types";
import { fromPromise, runPromise } from "./effect";

/** Safely resolve a lazy Linear SDK relation that may be undefined. */
function resolveMaybe(label: string, thunk: () => any) {
  return Effect.gen(function* () {
    const val = thunk();
    if (val == null) return null;
    if (typeof val === "object" && typeof val.then === "function") {
      return yield* fromPromise(label, () => val);
    }
    return val;
  });
}

function resolveIssueEffect(node: any) {
  return Effect.gen(function* () {
    const [state, assignee, labels, project] = yield* Effect.all([
      resolveMaybe("resolve linear issue state", () => node.state),
      resolveMaybe("resolve linear issue assignee", () => node.assignee),
      fromPromise("resolve linear issue labels", () => node.labels()),
      resolveMaybe("resolve linear issue project", () => node.project),
    ], { concurrency: "unbounded" });
    return {
      id: node.id,
      identifier: node.identifier,
      title: node.title,
      description: node.description ?? null,
      priority: node.priority,
      priorityLabel: node.priorityLabel,
      state: state ? { id: state.id, name: state.name, type: state.type } : null,
      assignee: assignee
        ? { id: assignee.id, name: assignee.name, email: assignee.email }
        : null,
      labels: (labels?.nodes ?? []).map((l: any) => ({ id: l.id, name: l.name })),
      project: project ? { id: project.id, name: project.name } : null,
      url: node.url,
    } satisfies LinearIssue;
  }).pipe(
    Effect.annotateLogs({
      issueId: node.id,
      identifier: node.identifier,
    }),
    Effect.withLogSpan("linear:resolve-issue"),
  );
}

export type ListIssuesParams = {
  teamId?: string;
  stateType?: string;
  limit?: number;
  labels?: string[];
};

export function useLinear() {
  const client = getLinearClient();

  return {
    listIssues(params: ListIssuesParams = {}): Promise<LinearIssue[]> {
      const filter: any = {};
      if (params.teamId) filter.team = { id: { eq: params.teamId } };
      if (params.stateType) filter.state = { type: { eq: params.stateType } };
      if (params.labels?.length)
        filter.labels = { name: { in: params.labels } };

      return runPromise(
        Effect.gen(function* () {
          const result = yield* fromPromise("list linear issues", () =>
            client.issues({
              filter,
              first: params.limit ?? 50,
            }),
          );
          return yield* Effect.all(
            result.nodes.map((node: any) => resolveIssueEffect(node)),
            { concurrency: "unbounded" },
          );
        }).pipe(
          Effect.annotateLogs({
            teamId: params.teamId ?? "",
            stateType: params.stateType ?? "",
            limit: params.limit ?? 50,
          }),
          Effect.withLogSpan("linear:list-issues"),
        ),
      );
    },

    getIssue(idOrIdentifier: string): Promise<LinearIssue> {
      return runPromise(
        Effect.gen(function* () {
          const node = yield* fromPromise("get linear issue", () =>
            client.issue(idOrIdentifier),
          );
          return yield* resolveIssueEffect(node);
        }).pipe(
          Effect.annotateLogs({ idOrIdentifier }),
          Effect.withLogSpan("linear:get-issue"),
        ),
      );
    },

    updateIssueState(issueId: string, stateId: string): Promise<boolean> {
      return runPromise(
        fromPromise("update linear issue state", () =>
          client.updateIssue(issueId, { stateId }),
        ).pipe(
          Effect.map((result) => result.success),
          Effect.annotateLogs({ issueId, stateId }),
          Effect.withLogSpan("linear:update-issue-state"),
        ),
      );
    },

    addComment(issueId: string, body: string): Promise<string> {
      return runPromise(
        Effect.gen(function* () {
          const result = yield* fromPromise("create linear comment", () =>
            client.createComment({ issueId, body }),
          );
          const commentRef = result.comment;
          const comment = commentRef
            ? yield* fromPromise("resolve created linear comment", () => commentRef)
            : undefined;
          return comment?.id ?? "";
        }).pipe(
          Effect.annotateLogs({ issueId, bodyLength: body.length }),
          Effect.withLogSpan("linear:add-comment"),
        ),
      );
    },

    createIssue(opts: {
      teamId: string;
      title: string;
      description: string;
      priority?: number;
      labelIds?: string[];
    }): Promise<LinearIssue> {
      return runPromise(
        Effect.gen(function* () {
          const result = yield* fromPromise("create linear issue", () =>
            client.createIssue({
              teamId: opts.teamId,
              title: opts.title,
              description: opts.description,
              priority: opts.priority,
              labelIds: opts.labelIds,
            }),
          );
          const issueRef = result.issue;
          if (!issueRef) {
            return yield* Effect.fail(new Error("Failed to create issue — no issue returned"));
          }
          const issue = yield* fromPromise("resolve created issue", () => issueRef);
          return yield* resolveIssueEffect(issue);
        }).pipe(
          Effect.annotateLogs({ teamId: opts.teamId, title: opts.title }),
          Effect.withLogSpan("linear:create-issue"),
        ),
      );
    },

    listTeams(): Promise<LinearTeam[]> {
      return runPromise(
        fromPromise("list linear teams", () => client.teams()).pipe(
          Effect.map((result) =>
            result.nodes.map((t: any) => ({
              id: t.id,
              name: t.name,
              key: t.key,
            })),
          ),
          Effect.withLogSpan("linear:list-teams"),
        ),
      );
    },

    listLabels(teamId?: string): Promise<LinearLabel[]> {
      return runPromise(
        fromPromise("list linear labels", () =>
          client.issueLabels({ first: 100 }),
        ).pipe(
          Effect.map((result) =>
            result.nodes.map((l: any) => ({
              id: l.id,
              name: l.name,
            })),
          ),
          Effect.withLogSpan("linear:list-labels"),
        ),
      );
    },
  };
}
