import { describe, expect, test } from "bun:test";
import { pickWave } from "../../apps/web/src/lib/wave-select.ts";

const waves = [{ id: "a" }, { id: "b" }, { id: "c" }];

describe("pickWave", () => {
  test("takes the wave named in the link", () => {
    expect(pickWave(waves, "b", "c")?.id).toBe("b");
  });

  test("falls back to the cookie when the link names nothing or a wave that is gone", () => {
    expect(pickWave(waves, undefined, "c")?.id).toBe("c");
    expect(pickWave(waves, "gone", "c")?.id).toBe("c");
  });

  test("falls back to the first wave when neither is usable", () => {
    expect(pickWave(waves, undefined, undefined)?.id).toBe("a");
    expect(pickWave(waves, "gone", "also-gone")?.id).toBe("a");
    expect(pickWave(waves, "", "")?.id).toBe("a");
  });

  test("is undefined without waves", () => {
    expect(pickWave([], "a", "a")).toBeUndefined();
  });
});
