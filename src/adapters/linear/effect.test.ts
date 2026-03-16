import { describe, expect, test } from "bun:test";
import { fromPromise, fromSync, runPromise } from "./effect";
import { Effect } from "effect";

describe("fromPromise", () => {
  test("wraps a resolved promise into a successful Effect", async () => {
    const result = await runPromise(
      fromPromise("test-success", () => Promise.resolve(42)),
    );
    expect(result).toBe(42);
  });

  test("wraps a rejected promise into a failed Effect with Error", async () => {
    const effect = fromPromise("test-fail", () =>
      Promise.reject(new Error("boom")),
    );

    await expect(runPromise(effect)).rejects.toThrow("boom");
  });

  test("wraps a string rejection into an Error", async () => {
    const effect = fromPromise("test-string-fail", () =>
      Promise.reject("string error"),
    );

    await expect(runPromise(effect)).rejects.toThrow("string error");
  });

  test("wraps an unknown rejection into an Error via String()", async () => {
    const effect = fromPromise("test-unknown-fail", () =>
      Promise.reject(123),
    );

    await expect(runPromise(effect)).rejects.toThrow("123");
  });
});

describe("fromSync", () => {
  test("wraps a sync value into a successful Effect", async () => {
    const result = await runPromise(
      fromSync("test-sync", () => "hello"),
    );
    expect(result).toBe("hello");
  });

  test("wraps a sync throw into a failed Effect", async () => {
    const effect = fromSync("test-sync-fail", () => {
      throw new Error("sync boom");
    });

    await expect(runPromise(effect)).rejects.toThrow("sync boom");
  });
});

describe("runPromise", () => {
  test("chains multiple Effects correctly", async () => {
    const pipeline = Effect.gen(function* () {
      const a = yield* fromPromise("step-1", () => Promise.resolve(10));
      const b = yield* fromSync("step-2", () => a * 2);
      return b + 1;
    });

    const result = await runPromise(pipeline);
    expect(result).toBe(21);
  });
});
