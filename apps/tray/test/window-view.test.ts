import { describe, expect, test } from "bun:test";
import { profileStatusFromSnapshot, type Status } from "@wave/ipc";
import { hostOf, windowView } from "../src/window-view.ts";

type Peer = {
  hostname: string;
  ipv4: string;
  via?: string;
  rttMs?: number;
  lastHandshakeSecondsAgo?: number;
  services?: Array<{ name: string; dnsName: string; ipv4: string; url: string }>;
};

const profile = (
  controlUrl: string,
  state: "up" | "stopped" | "starting" | "failed" | "waiting-for-approval",
  peers: Peer[] = [],
  message?: string,
) =>
  profileStatusFromSnapshot(
    state === "up"
      ? {
          controlUrl,
          interfaceName: "wave0",
          addresses: ["10.77.0.1/32"],
          self: { hostname: "laptop", dnsName: "laptop.rl.wave.internal", ipv4: "10.77.0.1" },
          peers: peers.map((peer) => ({
            hostname: peer.hostname,
            dnsName: `${peer.hostname}.rl.wave.internal`,
            ipv4: peer.ipv4,
            ipv6: "fd7a::2",
            via: peer.via,
            rttMs: peer.rttMs,
            lastHandshakeSecondsAgo: peer.lastHandshakeSecondsAgo,
            services: peer.services,
          })),
        }
      : undefined,
    { controlUrl, state, message },
  );

const status = (...profiles: ReturnType<typeof profile>[]): Status => ({ profiles, events: [] });

describe("connections", () => {
  test("one row per wave, named by its server", () => {
    const view = windowView(status(profile("http://control.example:8080", "up")), "laptop");
    expect(view.connections).toEqual([
      {
        controlUrl: "http://control.example:8080",
        label: "control.example:8080",
        connected: true,
        busy: false,
        detail: "10.77.0.1",
      },
    ]);
  });

  test("the switch is off and the reason is on the row when a wave failed", () => {
    const view = windowView(status(profile("http://c.example", "failed", [], "no route")), "laptop");
    expect(view.connections[0]?.connected).toBe(false);
    expect(view.connections[0]?.detail).toBe("no route");
  });

  test("a wave on its way up is busy, so the switch does not fight the user", () => {
    const view = windowView(status(profile("http://c.example", "starting")), "laptop");
    expect(view.connections[0]).toMatchObject({ connected: false, busy: true });
  });

  test("waiting for the browser says so rather than looking stuck", () => {
    const view = windowView(status(profile("http://c.example", "waiting-for-approval")), "laptop");
    expect(view.connections[0]?.detail).toContain("approval");
    expect(view.connections[0]?.busy).toBe(true);
  });
});

describe("machines", () => {
  const two = () =>
    status(
      profile("http://a.example", "up", [{ hostname: "phone", ipv4: "10.77.0.2", via: "relay", rttMs: 41 }]),
      profile("http://b.example", "up", [{ hostname: "nas", ipv4: "10.96.0.2" }]),
    );

  test("carries what the copy button needs", () => {
    const view = windowView(
      status(profile("http://a.example", "up", [{ hostname: "phone", ipv4: "10.77.0.2" }])),
      "laptop",
    );
    expect(view.machines[0]).toMatchObject({
      hostname: "phone",
      address: "10.77.0.2",
      dnsName: "phone.rl.wave.internal",
    });
    // What the button carries away is the name, not the address: the address is
    // handed out by the wave and can change, the name keeps meaning the machine.
    expect(view.machines[0]?.dnsName).toBe("phone.rl.wave.internal");
    expect(view.machines[0]?.dnsName).not.toBe(view.machines[0]?.address);
  });

  test("says how a machine is reached, with the round trip when there is one", () => {
    const view = windowView(two(), "laptop");
    expect(view.machines[0]?.path).toBe("via relay · 41 ms");
    // No path yet: saying "connecting" beats an empty column.
    expect(view.machines[1]?.path).toBe("connecting…");
    expect(view.machines[1]?.online).toBe(false);
  });

  test("peers of every wave land in one list, keyed so rows survive an update", () => {
    const view = windowView(two(), "laptop");
    expect(view.machines.map((m) => m.key)).toEqual([
      "http://a.example/phone.rl.wave.internal",
      "http://b.example/nas.rl.wave.internal",
    ]);
    // With two waves the same short name could mean two machines.
    expect(view.labelMachines).toBe(true);
  });

  test("one wave needs no label on every row", () => {
    expect(windowView(status(profile("http://a.example", "up")), "laptop").labelMachines).toBe(false);
  });

  test("explains an empty list rather than showing nothing", () => {
    expect(windowView(null, "laptop").emptyMachines).toContain("Join a wave");
    expect(windowView(status(profile("http://a.example", "stopped")), "laptop").emptyMachines).toContain(
      "Connect to see",
    );
    expect(windowView(status(profile("http://a.example", "up")), "laptop").emptyMachines).toContain(
      "No other machines",
    );
  });
});

describe("the header", () => {
  test("names the device and sums up what is going on", () => {
    expect(windowView(null, "laptop")).toMatchObject({
      title: "laptop",
      subtitle: "waiting for the daemon",
    });
    expect(windowView(status(), "laptop").subtitle).toContain("no wave yet");
    expect(windowView(status(profile("http://a.example", "up")), "laptop").subtitle).toBe("10.77.0.1");

    const both = status(profile("http://a.example", "up"), profile("http://b.example", "stopped"));
    expect(windowView(both, "laptop").subtitle).toBe("1/2 waves connected");
  });

  test("says an update is there, on the line that speaks for the device", () => {
    const withUpdate: Status = {
      ...status(profile("http://a.example", "up")),
      daemon: {
        version: "0.1.0",
        platform: "linux-amd64",
        update: {
          autoUpdate: true,
          wish: null,
          channels: [],
          available: "0.2.0",
          state: "idle",
          message: null,
          scheduledAt: null,
        },
      },
    };
    expect(windowView(withUpdate, "laptop").subtitle).toBe("10.77.0.1 · Update to 0.2.0 available");
  });
});

describe("hostOf", () => {
  test("drops the scheme and keeps the port", () => {
    expect(hostOf("http://195.201.38.20:8080")).toBe("195.201.38.20:8080");
    expect(hostOf("https://control.example")).toBe("control.example");
  });

  test("passes nonsense through rather than throwing", () => {
    expect(hostOf("not a url")).toBe("not a url");
  });
});

describe("a peer without a confirmed path", () => {
  test("counts as online and says so, when the handshake is fresh", () => {
    // The magic socket sprays to every candidate until a path is confirmed, so
    // traffic flows. Calling the row offline would hide a working tunnel.
    const view = windowView(
      status(
        profile("http://a.example", "up", [
          { hostname: "phone", ipv4: "10.77.0.2", lastHandshakeSecondsAgo: 20 },
        ]),
      ),
      "laptop",
    );
    expect(view.machines[0]?.path).toBe("no fixed path");
    expect(view.machines[0]?.online).toBe(true);
  });

  test("and is offline once the handshake proves nothing", () => {
    const view = windowView(
      status(
        profile("http://a.example", "up", [
          { hostname: "phone", ipv4: "10.77.0.2", lastHandshakeSecondsAgo: 600 },
        ]),
      ),
      "laptop",
    );
    expect(view.machines[0]?.path).toBe("connecting…");
    expect(view.machines[0]?.online).toBe(false);
  });
});

describe("the services a machine fronts", () => {
  const connector = (services: Array<{ name: string; dnsName: string; ipv4: string; url: string }>) =>
    windowView(
      status(profile("https://one.example", "up", [{ hostname: "connector", ipv4: "10.77.0.5", services }])),
      "laptop",
    ).machines[0];

  test("hang under it, with the address the server wrote out", () => {
    const machine = connector([
      {
        name: "grafana",
        dnsName: "grafana.rl.wave.internal",
        ipv4: "10.77.0.4",
        url: "https://grafana.rl.wave.internal",
      },
      // Taken as it comes, never rebuilt: a name served in plain text would
      // otherwise be offered as https, and that link goes nowhere.
      { name: "git", dnsName: "git.rl.wave.internal", ipv4: "10.77.0.6", url: "http://git.rl.wave.internal" },
    ]);
    expect(machine?.services.map((service) => service.url)).toEqual([
      "https://grafana.rl.wave.internal",
      "http://git.rl.wave.internal",
    ]);
    expect(machine?.services[0]?.address).toBe("10.77.0.4");
  });

  test("a machine with none carries an empty list, not a missing one", () => {
    const view = windowView(
      status(profile("https://one.example", "up", [{ hostname: "desktop", ipv4: "10.77.0.2" }])),
      "laptop",
    );
    expect(view.machines[0]?.services).toEqual([]);
  });

  test("their keys name the wave, so two waves cannot collide on one name", () => {
    const view = windowView(
      status(
        profile("https://one.example", "up", [
          {
            hostname: "connector",
            ipv4: "10.77.0.5",
            services: [
              {
                name: "grafana",
                dnsName: "grafana.rl.wave.internal",
                ipv4: "10.77.0.4",
                url: "https://grafana.rl.wave.internal",
              },
            ],
          },
        ]),
        profile("https://two.example", "up", [
          {
            hostname: "connector",
            ipv4: "10.88.0.5",
            services: [
              {
                name: "grafana",
                dnsName: "grafana.rl.wave.internal",
                ipv4: "10.88.0.4",
                url: "https://grafana.rl.wave.internal",
              },
            ],
          },
        ]),
      ),
      "laptop",
    );
    const keys = view.machines.flatMap((machine) => machine.services.map((service) => service.key));
    expect(new Set(keys).size).toBe(2);
  });
});
