import { describe, expect, test } from "bun:test";
import type { Candidate } from "@wave/proto";
import { boundCandidates, MAX_CANDIDATES_PER_KIND } from "../src/netmap/candidates.ts";

const stun = (port: number): Candidate => ({ kind: "stun", ip: "77.42.39.172", port });
const local = (ip: string): Candidate => ({ kind: "local", ip, port: 41641 });

describe("boundCandidates", () => {
  test("keeps the newest of a kind an old client never stopped appending", () => {
    // The shape a connector behind a port-randomising NAT published: one
    // local address and a new reflexive port for every minute it ran.
    const published = [
      local("10.42.1.16"),
      ...Array.from({ length: 2670 }, (_, index) => stun(1000 + index)),
    ];
    const bounded = boundCandidates(published);

    expect(bounded).toHaveLength(1 + MAX_CANDIDATES_PER_KIND);
    expect(bounded[0]).toEqual(local("10.42.1.16"));
    expect(bounded.at(-1)).toEqual(stun(1000 + 2669));
  });

  test("bounds each kind on its own", () => {
    const locals = Array.from({ length: 3 }, (_, index) => local(`192.168.1.${index}`));
    const reflexive = Array.from({ length: 20 }, (_, index) => stun(index));
    const bounded = boundCandidates([...locals, ...reflexive]);
    expect(bounded.filter((c) => c.kind === "local")).toHaveLength(3);
    expect(bounded.filter((c) => c.kind === "stun")).toHaveLength(MAX_CANDIDATES_PER_KIND);
  });

  test("drops duplicates and leaves a short list as it was", () => {
    const list = [local("192.168.1.2"), stun(5), stun(5), stun(6)];
    expect(boundCandidates(list)).toEqual([local("192.168.1.2"), stun(5), stun(6)]);
  });
});
