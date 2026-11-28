import { describe, expect, test } from "bun:test";
import type { CommandResult } from "../src/link.ts";
import {
  detectNetfilter,
  type IptablesTool,
  netfilterMode,
  netfilterSelector,
  restoreDocument,
  syncChains,
} from "../src/netfilter.ts";

/**
 * Choosing between nftables and iptables, and the one document that keeps our
 * chains in a table. Real iptables reads these in test/e2e/iptables.sh.
 */

const answer = (code: number, stderr = "", stdout = ""): CommandResult => ({ code, stdout, stderr });
const tool = (name: string, code = 0, stderr = ""): IptablesTool => ({
  name,
  run: async () => answer(code, stderr),
  restore: async () => answer(0),
});
const noNf = tool("iptables", 1, "iptables v1.8.11: Failed to initialize nft: Protocol not supported");
const probes = (nft: number, ...broken: string[]) => ({
  nft: async () =>
    answer(nft, nft === 0 ? "" : "Unable to initialize Netlink socket: Protocol not supported"),
  iptables: [broken.includes("iptables") ? noNf : tool("iptables"), tool("iptables-legacy")],
  ip6tables: [tool("ip6tables", broken.includes("ip6") ? 127 : 0), tool("ip6tables-legacy", 127)],
});

describe("WAVE_NETFILTER", () => {
  test("auto unless said otherwise", () => {
    expect(netfilterMode({})).toBe("auto");
    expect(netfilterMode({ WAVE_NETFILTER: "" })).toBe("auto");
    expect(netfilterMode({ WAVE_NETFILTER: " IPTables " })).toBe("iptables");
    expect(netfilterMode({ WAVE_NETFILTER: "nft" })).toBe("nft");
  });

  test("a typo is refused, not guessed", () => {
    expect(() => netfilterMode({ WAVE_NETFILTER: "ipables" })).toThrow("auto, nft or iptables");
  });
});

describe("which backend", () => {
  test("nft where the kernel answers it", async () => {
    expect(await detectNetfilter("auto", probes(0))).toEqual({ kind: "nft" });
  });

  // The binary may well be in the image; the kernel is what has to answer.
  test("iptables where nft is installed but the kernel has no nf_tables", async () => {
    const found = await detectNetfilter("auto", probes(1));
    expect(found.kind).toBe("iptables");
  });

  test("the legacy flavour where the default one is nftables underneath", async () => {
    const found = await detectNetfilter("auto", probes(1, "iptables"));
    expect(found.kind === "iptables" && found.v4.name).toBe("iptables-legacy");
  });

  test("says when IPv6 has nothing to filter it with", async () => {
    const found = await detectNetfilter("auto", probes(127, "ip6"));
    expect(found).toMatchObject({ kind: "iptables", v6: null });
    expect(found.kind === "iptables" && found.v6Problem).toBe(
      "ip6tables is not usable (ip6tables: not installed; ip6tables-legacy: not installed)",
    );
  });

  test("neither is an answer with both complaints in it", async () => {
    const found = await detectNetfilter("auto", {
      nft: async () => answer(127),
      iptables: [noNf],
      ip6tables: [],
    });
    expect(found).toEqual({
      kind: "none",
      reason:
        "neither nft nor iptables is usable (nft: not installed; iptables: iptables v1.8.11: Failed to initialize nft: Protocol not supported)",
    });
  });

  test("forced: iptables without asking nft, nft without asking anything", async () => {
    let asked = 0;
    const counting = {
      ...probes(0),
      nft: async () => {
        asked++;
        return answer(0);
      },
    };
    expect((await detectNetfilter("iptables", counting)).kind).toBe("iptables");
    expect(await detectNetfilter("nft", counting)).toEqual({ kind: "nft" });
    expect(asked).toBe(0);
  });

  test("asks again after finding nothing, and only then", async () => {
    let calls = 0;
    const select = netfilterSelector({}, () => ({
      nft: async () => answer(++calls > 1 ? 0 : 127),
      iptables: [],
      ip6tables: [],
    }));
    expect((await select()).kind).toBe("none");
    expect((await select()).kind).toBe("nft");
    expect((await select()).kind).toBe("nft");
    expect(calls).toBe(2);
  });
});

describe("the iptables-restore document", () => {
  const spec = {
    chain: "WAVE-X",
    hooks: [{ from: "PREROUTING", match: "-i wave0" }],
    rules: ["-j DROP"],
  };

  test("fills the chain first and leads into it last", () => {
    expect(restoreDocument("mangle", "-P PREROUTING ACCEPT\n", [spec])).toBe(
      "*mangle\n:WAVE-X - [0:0]\n-A WAVE-X -j DROP\n-I PREROUTING 1 -i wave0 -j WAVE-X\nCOMMIT\n",
    );
  });

  test("replaces every jump it left and touches nobody else's", () => {
    const listing = [
      "-P PREROUTING ACCEPT",
      "-N WAVE-X",
      "-N WAVE-XY",
      "-A PREROUTING -i wave0 -j WAVE-X",
      "-A PREROUTING -i wave1 -j WAVE-X",
      "-A PREROUTING -j WAVE-XY",
      '-A PREROUTING -m comment --comment "theirs" -j ACCEPT',
      "-A WAVE-X -j DROP",
    ].join("\n");
    expect(restoreDocument("mangle", listing, [spec]).split("\n")).toEqual([
      "*mangle",
      ":WAVE-X - [0:0]",
      "-D PREROUTING -i wave0 -j WAVE-X",
      "-D PREROUTING -i wave1 -j WAVE-X",
      "-A WAVE-X -j DROP",
      "-I PREROUTING 1 -i wave0 -j WAVE-X",
      "COMMIT",
      "",
    ]);
  });

  test("removal takes the jumps and the chain", () => {
    const listing = "-N WAVE-X\n-A PREROUTING -i wave0 -j WAVE-X\n";
    expect(restoreDocument("mangle", listing, [{ ...spec, rules: null }])).toBe(
      "*mangle\n:WAVE-X - [0:0]\n-D PREROUTING -i wave0 -j WAVE-X\n-X WAVE-X\nCOMMIT\n",
    );
  });

  test("nothing to remove, nothing to say", () => {
    expect(restoreDocument("mangle", "-P PREROUTING ACCEPT\n", [{ ...spec, rules: null }])).toBe("");
  });

  test("a missing table holds nothing of ours, but cannot take anything either", async () => {
    const missing = tool(
      "iptables-legacy",
      1,
      "iptables v1.8.11 (legacy): can't initialize iptables table `mangle': Table does not exist",
    );
    await syncChains(missing, "mangle", [{ ...spec, rules: null }]);
    expect(syncChains(missing, "mangle", [spec])).rejects.toThrow("cannot read the mangle table");
  });

  test("no permission is not the same as nothing there", async () => {
    const denied = tool(
      "iptables-legacy",
      3,
      "iptables v1.8.11 (legacy): can't initialize iptables table `filter': Permission denied (you must be root)",
    );
    expect(syncChains(denied, "filter", [{ ...spec, rules: null }])).rejects.toThrow("Permission denied");
  });

  test("hands it to restore without flushing what is not ours", async () => {
    const seen: { args: string[]; input: string }[] = [];
    await syncChains(
      {
        name: "iptables",
        run: async () => answer(0),
        restore: async (args, input) => {
          seen.push({ args, input });
          return answer(0);
        },
      },
      "mangle",
      [spec],
    );
    expect(seen[0]?.args).toEqual(["--noflush", "--wait"]);
    expect(seen[0]?.input).toContain(":WAVE-X - [0:0]");
  });
});
