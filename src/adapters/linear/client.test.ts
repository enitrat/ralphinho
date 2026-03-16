import { afterEach, describe, expect, test } from "bun:test";
import { resetLinearClient, getLinearClient } from "./client";

describe("getLinearClient", () => {
  const originalKey = process.env.LINEAR_API_KEY;

  afterEach(() => {
    resetLinearClient();
    if (originalKey !== undefined) {
      process.env.LINEAR_API_KEY = originalKey;
    } else {
      delete process.env.LINEAR_API_KEY;
    }
  });

  test("throws when LINEAR_API_KEY is not set", () => {
    delete process.env.LINEAR_API_KEY;
    resetLinearClient();

    expect(() => getLinearClient()).toThrow("LINEAR_API_KEY");
  });

  test("returns a client when LINEAR_API_KEY is set", () => {
    process.env.LINEAR_API_KEY = "lin_test_fake_key";
    resetLinearClient();

    const client = getLinearClient();
    expect(client).toBeDefined();
  });

  test("returns the same cached instance on subsequent calls", () => {
    process.env.LINEAR_API_KEY = "lin_test_fake_key";
    resetLinearClient();

    const client1 = getLinearClient();
    const client2 = getLinearClient();
    expect(client1).toBe(client2);
  });

  test("resetLinearClient clears the cache", () => {
    process.env.LINEAR_API_KEY = "lin_test_fake_key";
    resetLinearClient();

    const client1 = getLinearClient();
    resetLinearClient();
    const client2 = getLinearClient();
    expect(client1).not.toBe(client2);
  });
});
