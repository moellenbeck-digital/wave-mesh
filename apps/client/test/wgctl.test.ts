import { describe, expect, test } from "bun:test";
import { keyToHex } from "@wave/crypto";
import { buildSetRequest, defaultSocketPath, parseDeviceState, parseErrno } from "../src/wgctl.ts";

const KEY = "xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=";
const PRIVATE = "yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=";

describe("parseDeviceState", () => {
  const response = [
    `private_key=${keyToHex(PRIVATE)}`,
    "listen_port=41641",
    `public_key=${keyToHex(KEY)}`,
    "endpoint=192.168.1.20:41641",
    "allowed_ip=100.64.0.2/32",
    "allowed_ip=fd7a:1:2::2/128",
    "persistent_keepalive_interval=25",
    "last_handshake_time_sec=1780000000",
    "rx_bytes=2048",
    "tx_bytes=1024",
    "errno=0",
    "",
    "",
  ].join("\n");

  test("reads the device", () => {
    const device = parseDeviceState(response);
    expect(device.listenPort).toBe(41641);
    expect(device.privateKey).toBe(PRIVATE);
  });

  test("reads the peer, converting keys back to base64", () => {
    const peer = parseDeviceState(response).peers[0];
    expect(peer?.publicKey).toBe(KEY);
    expect(peer?.endpoint).toBe("192.168.1.20:41641");
    expect(peer?.allowedIps).toEqual(["100.64.0.2/32", "fd7a:1:2::2/128"]);
    expect(peer?.persistentKeepalive).toBe(25);
    expect(peer?.rxBytes).toBe(2048);
  });

  test("treats an all-zero private key as unset", () => {
    expect(parseDeviceState(`private_key=${"0".repeat(64)}\nerrno=0\n\n`).privateKey).toBeUndefined();
  });

  test("handles a device without peers", () => {
    expect(parseDeviceState("listen_port=1\nerrno=0\n\n").peers).toEqual([]);
  });
});

describe("buildSetRequest", () => {
  test("writes keys as hex and terminates with a blank line", () => {
    const request = buildSetRequest({
      privateKey: PRIVATE,
      listenPort: 41641,
      upsert: [
        {
          publicKey: KEY,
          endpoint: "192.168.1.20:41641",
          allowedIps: ["100.64.0.2/32"],
          persistentKeepalive: 25,
        },
      ],
      remove: [],
    });
    expect(request).toBe(
      [
        "set=1",
        `private_key=${keyToHex(PRIVATE)}`,
        "listen_port=41641",
        `public_key=${keyToHex(KEY)}`,
        "endpoint=192.168.1.20:41641",
        "persistent_keepalive_interval=25",
        "replace_allowed_ips=true",
        "allowed_ip=100.64.0.2/32",
        "",
        "",
      ].join("\n"),
    );
  });

  test("replaces allowed IPs rather than appending to them", () => {
    const request = buildSetRequest({
      upsert: [{ publicKey: KEY, allowedIps: ["100.64.0.2/32"], persistentKeepalive: 25 }],
      remove: [],
    });
    expect(request).toContain("replace_allowed_ips=true");
  });

  test("emits removals", () => {
    const request = buildSetRequest({ upsert: [], remove: [KEY] });
    expect(request).toContain(`public_key=${keyToHex(KEY)}\nremove=true`);
  });
});

describe("parseErrno", () => {
  test("reads success and failure", () => {
    expect(parseErrno("errno=0\n\n")).toBe(0);
    expect(parseErrno("errno=-22\n\n")).toBe(-22);
  });

  test("reports a missing errno as a failure", () => {
    expect(parseErrno("garbage")).toBe(-1);
  });
});

describe("defaultSocketPath", () => {
  test("is a socket file where there are socket files", () => {
    expect(defaultSocketPath("wave0", "linux")).toBe("/var/run/wireguard/wave0.sock");
    expect(defaultSocketPath("utun7", "darwin")).toBe("/var/run/wireguard/utun7.sock");
  });

  test("is the pipe wireguard-go serves on Windows, under the admin-only prefix", () => {
    // Nothing else has to guard this: the prefix's ACL is what keeps an
    // unprivileged process from reconfiguring the tunnel.
    expect(defaultSocketPath("wave0", "win32")).toBe(
      "\\\\.\\pipe\\ProtectedPrefix\\Administrators\\WireGuard\\wave0",
    );
  });
});
