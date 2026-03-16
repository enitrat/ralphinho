import type { ReviewLens } from "./types";

export type ReviewLensDefinition = {
  id: ReviewLens;
  title: string;
  mission: string;
  checklist: string[];
};

export const REVIEW_LENSES: readonly ReviewLensDefinition[] = [
  {
    id: "refactor-hunter",
    title: "Refactor Hunter",
    mission:
      "Find code that should be deleted, collapsed, unified, or simplified. Prefer removing duplication and needless abstraction over introducing new layers.",
    checklist: [
      "Search for existing utilities, helpers, selectors, mappers, guards, and factories before recommending any new abstraction",
      "Duplicate helpers, mappers, guards, or utility logic that should reuse an existing implementation",
      "Needless wrapper functions, pass-through adapters, one-off abstractions, or configuration objects with a single real use",
      "Dead branches, unused options, redundant state, or helper files that exist only to move obvious logic around",
      "Parameter sprawl, copy-paste with slight variation, or duplicated transformations that should collapse into one implementation",
      "Unnecessary work, repeated reads/computation, or overly broad operations when a narrower or reused path already exists",
      "Overly defensive code that increases complexity without protecting a real runtime boundary",
    ],
  },
  {
    id: "type-system-purist",
    title: "Type System Purist",
    mission:
      "Find code that distrusts the type system or duplicates guarantees that types, schemas, or validated boundaries already enforce.",
    checklist: [
      "Runtime guards for impossible states already ruled out by discriminated unions, branded types, validated schemas, or function contracts",
      "Repeated parsing, narrowing, null handling, or fallback branches after the data shape is already guaranteed",
      "Stringly-typed logic where an existing union, enum-like constant set, or branded value should drive the branch",
      "Runtime code that exists only because the implementation distrusts its own declared contracts",
      "Tests that verify types, type narrowing, re-exports, or file/module organization instead of observable runtime behavior",
      "Defensive branches that silently swallow invariant violations instead of relying on the typed boundary and failing loudly where appropriate",
    ],
  },
  {
    id: "app-logic-architecture",
    title: "App / Logic Architecture",
    mission:
      "Find logic layering problems, poor ownership boundaries, and tangled data flow. Keep this generic: focus on application logic, state flow, orchestration, and module boundaries rather than framework-specific UI rules.",
    checklist: [
      "How do similar features or modules in this codebase already solve this problem, and is this scope diverging without a good reason",
      "Application logic mixed with presentation concerns, transport concerns, or persistence concerns when a cleaner boundary should exist",
      "State ownership confusion, duplicated derived state, or orchestration split across too many layers",
      "Async or data-fetching logic leaked into places that should consume a cleaner contract from shared logic",
      "Cross-module coupling, leaky abstractions, or inconsistent boundaries that make logic harder to evolve",
      "Repeated shaping, mapping, or orchestration logic that should live behind one boundary instead of being spread across consumers",
    ],
  },
] as const;

export function getReviewLensDefinition(lens: ReviewLens): ReviewLensDefinition {
  const match = REVIEW_LENSES.find((entry) => entry.id === lens);
  if (!match) {
    throw new Error(`Unknown review lens: ${lens}`);
  }
  return match;
}
