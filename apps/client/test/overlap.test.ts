import { describe, expect, test } from "bun:test";
import { describeConflict, findConflict, toRange } from "../src/overlap.ts";

describe("ranges", () => {
  test("a bare address covers exactly itself", () => {
    const range = toRange("100.64.0.5");
    expect(range?.start).toBe(range?.end);
  });

  test("a prefix is masked down to its network", () => {
    expect(toRange("100.64.1.7/16")).toEqual(toRange("100.64.0.0/16"));
  });

  test("v4 and v6 never meet, whatever the numbers look like", () => {
    // Without the separation, ::1 and 0.0.0.1 would both be 1.
    expect(findConflict(["::1/128"], [{ controlUrl: "other", cidrs: ["0.0.0.1/32"] }])).toBeNull();
  });

  test("nonsense covers nothing rather than throwing", () => {
    expect(toRange("not-an-address")).toBeNull();
    expect(toRange("100.64.0.1/99")).toBeNull();
  });
});

describe("finding a conflict", () => {
  const held = [
    {
      controlUrl: "https://work.example",
      cidrs: ["100.64.0.1/32", "100.64.0.2/32", "fd7a:1:2::1/128"],
    },
  ];

  test("two waves numbering from the bottom collide", () => {
    // Exactly what two servers that both start at .1 would produce.
    const conflict = findConflict(["100.64.0.1/32", "100.64.0.9/32"], held);
    expect(conflict).toEqual({
      cidr: "100.64.0.1/32",
      heldBy: "https://work.example",
      held: "100.64.0.1/32",
    });
  });

  test("disjoint blocks are fine", () => {
    expect(findConflict(["100.65.0.1/32", "100.65.0.2/32"], held)).toBeNull();
  });

  test("a wider route that swallows a held address counts", () => {
    // A subnet router advertising 100.64.0.0/16 would take the peer with it.
    expect(findConflict(["100.64.0.0/16"], held)?.heldBy).toBe("https://work.example");
  });

  test("v6 collides on its own terms", () => {
    expect(findConflict(["fd7a:1:2::1/128"], held)?.held).toBe("fd7a:1:2::1/128");
  });

  test("nothing held means nothing to collide with", () => {
    expect(findConflict(["100.64.0.1/32"], [])).toBeNull();
  });
});

describe("what the user is told", () => {
  test("names both waves and says which one keeps running", () => {
    const conflict = findConflict(["100.64.0.1/32"], [{ controlUrl: "work", cidrs: ["100.64.0.1/32"] }]);
    if (!conflict) throw new Error("expected a conflict");

    const message = describeConflict("home", conflict);
    expect(message).toContain("home wants 100.64.0.1/32");
    expect(message).toContain("work already uses");
    // The running tunnel is not sacrificed for the new one.
    expect(message).toContain("work keeps running");
  });
});
