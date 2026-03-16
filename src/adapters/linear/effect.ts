/**
 * Slim Effect interop for the Linear adapter layer.
 * Mirrors smithers' src/effect/interop.ts + runtime.ts patterns
 * without pulling in the full smithers runtime.
 */

import { Effect } from "effect";

function toError(cause: unknown): Error {
  if (cause instanceof Error) return cause;
  if (typeof cause === "string") return new Error(cause);
  return new Error(String(cause));
}

/** Wrap a promise-returning thunk as an Effect. */
export function fromPromise<A>(
  label: string,
  thunk: () => Promise<A>,
): Effect.Effect<A, Error> {
  return Effect.tryPromise({
    try: thunk,
    catch: (cause) => toError(cause),
  }).pipe(Effect.withLogSpan(label));
}

/** Wrap a sync thunk as an Effect. */
export function fromSync<A>(
  label: string,
  thunk: () => A,
): Effect.Effect<A, Error> {
  return Effect.try({
    try: thunk,
    catch: (cause) => toError(cause),
  }).pipe(Effect.withLogSpan(label));
}

/** Run an Effect to a Promise, normalizing failures. */
export function runPromise<A>(
  effect: Effect.Effect<A, Error>,
): Promise<A> {
  return Effect.runPromise(
    effect.pipe(
      Effect.catchAll((error) => Effect.die(error)),
    ),
  );
}
