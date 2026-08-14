/**
 * Retrieval bucket resolution tests.
 *
 * The security invariant — a hook can never widen retrieval for a caller the
 * surface could not name, which on the public pipeline means private
 * knowledge stays unreachable — is asserted here rather than per-route,
 * because this is the single place that enforces it.
 */

import { describe, expect, test } from "bun:test";
import { type BucketsFor, defaultBuckets, resolveBuckets } from "./buckets";

describe("defaultBuckets", () => {
  test("pairs base with the mode's own bucket", () => {
    expect(defaultBuckets("public")).toEqual(["base", "public"]);
    expect(defaultBuckets("private")).toEqual(["base", "private"]);
  });
});

describe("resolveBuckets", () => {
  test("returns undefined when no hook is configured, leaving mode defaults", async () => {
    expect(await resolveBuckets({ mode: "private" })).toBeUndefined();
  });

  test("returns undefined when the hook declines to decide", async () => {
    const bucketsFor: BucketsFor = () => undefined;

    expect(await resolveBuckets({ mode: "private", sender: "user-1", bucketsFor })).toBeUndefined();
  });

  test("passes mode and sender to the hook", async () => {
    const seen: Parameters<BucketsFor>[0][] = [];
    const bucketsFor: BucketsFor = (ctx) => {
      seen.push(ctx);
      return undefined;
    };

    await resolveBuckets({ mode: "private", sender: "user-1", bucketsFor });

    expect(seen).toEqual([{ mode: "private", sender: "user-1" }]);
  });

  test("omits sender from the hook context when the surface is anonymous", async () => {
    const seen: Parameters<BucketsFor>[0][] = [];
    const bucketsFor: BucketsFor = (ctx) => {
      seen.push(ctx);
      return undefined;
    };

    await resolveBuckets({ mode: "public", bucketsFor });

    expect(seen).toEqual([{ mode: "public" }]);
    expect(seen[0]).not.toHaveProperty("sender");
  });

  test("honours an identified caller's buckets verbatim", async () => {
    const bucketsFor: BucketsFor = () => ["base", "private", "finance"];

    expect(await resolveBuckets({ mode: "private", sender: "user-1", bucketsFor })).toEqual([
      "base",
      "private",
      "finance",
    ]);
  });

  test("awaits an async hook", async () => {
    const bucketsFor: BucketsFor = async () => ["base", "ops"];

    expect(await resolveBuckets({ mode: "private", sender: "user-1", bucketsFor })).toEqual([
      "base",
      "ops",
    ]);
  });

  test("trims, drops blanks and de-duplicates", async () => {
    const bucketsFor: BucketsFor = () => [" base ", "base", "", "   ", "ops"];

    expect(await resolveBuckets({ mode: "private", sender: "user-1", bucketsFor })).toEqual([
      "base",
      "ops",
    ]);
  });

  test("ignores a hook that returns a non-array", async () => {
    const bucketsFor = (() => "private") as unknown as BucketsFor;

    expect(await resolveBuckets({ mode: "public", bucketsFor })).toBeUndefined();
  });

  test("propagates a rejected hook rather than falling back to defaults", async () => {
    const bucketsFor: BucketsFor = () => Promise.reject(new Error("role service down"));

    await expect(resolveBuckets({ mode: "private", sender: "user-1", bucketsFor })).rejects.toThrow(
      "role service down",
    );
  });

  describe("unidentified-caller ceiling", () => {
    test("drops private from an anonymous public surface", async () => {
      const bucketsFor: BucketsFor = () => ["base", "public", "private"];

      expect(await resolveBuckets({ mode: "public", bucketsFor })).toEqual(["base", "public"]);
    });

    test("drops buckets invented by the hook when anonymous", async () => {
      const bucketsFor: BucketsFor = () => ["base", "finance", "hr"];

      expect(await resolveBuckets({ mode: "public", bucketsFor })).toEqual(["base"]);
    });

    test("treats a blank sender as anonymous", async () => {
      const bucketsFor: BucketsFor = () => ["base", "private"];

      for (const sender of ["", "   ", undefined]) {
        expect(await resolveBuckets({ mode: "public", sender, bucketsFor })).toEqual(["base"]);
      }
    });

    test("clamps a private-mode caller the surface could not name to that mode's defaults", async () => {
      const bucketsFor: BucketsFor = () => ["base", "private", "finance"];

      // The private bucket survives — a subject-less JWT is still an
      // authenticated caller, and the route would have retrieved it anyway —
      // but the hook cannot add anything on top of it.
      expect(await resolveBuckets({ mode: "private", bucketsFor })).toEqual(["base", "private"]);
    });

    test("declining and returning the defaults agree for an unnamed caller", async () => {
      const declines: BucketsFor = () => undefined;
      const returnsDefaults: BucketsFor = ({ mode }) => defaultBuckets(mode);

      // `undefined` means "keep the mode defaults", so both paths must leave
      // the same buckets in play; a ceiling that only bit one of them would
      // punish hooks for how they spelled the same decision.
      expect(await resolveBuckets({ mode: "private", bucketsFor: declines })).toBeUndefined();
      expect(await resolveBuckets({ mode: "private", bucketsFor: returnsDefaults })).toEqual(
        defaultBuckets("private"),
      );
    });

    test("still allows an unnamed caller's hook to narrow", async () => {
      const bucketsFor: BucketsFor = () => [];

      expect(await resolveBuckets({ mode: "public", bucketsFor })).toEqual([]);
      expect(await resolveBuckets({ mode: "private", bucketsFor })).toEqual([]);
    });

    test("drops non-string entries instead of coercing them", async () => {
      const bucketsFor = (() => ["base", null, 7]) as unknown as BucketsFor;

      expect(await resolveBuckets({ mode: "private", sender: "user-1", bucketsFor })).toEqual([
        "base",
      ]);
    });
  });
});
