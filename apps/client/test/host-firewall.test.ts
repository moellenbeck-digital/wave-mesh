import { describe, expect, test } from "bun:test";
import { firewalldCommand, linuxHostFirewall, ufwAllows, ufwCommand } from "../src/host-firewall.ts";
import type { CommandResult, CommandRunner } from "../src/link.ts";

// What `ufw status verbose` prints on a desktop with a deny policy, including
// a comment column and the (v6) twins of every rule.
const status = (rules: string, policy = "deny") =>
  [
    "Status: active",
    "Logging: on (low)",
    `Default: ${policy} (incoming), allow (outgoing), disabled (routed)`,
    "New profiles: skip",
    "",
    "To                         Action      From",
    "--                         ------      ----",
    "53317/udp                  ALLOW IN    Anywhere",
    "172.17.0.1 53/udp          ALLOW IN    172.16.0.0/12              # allow-docker-dns",
    rules,
    "53317/udp (v6)             ALLOW IN    Anywhere (v6)",
  ].join("\n");

describe("ufwAllows", () => {
  test("a deny policy without a rule for the port keeps the pier out", () => {
    expect(ufwAllows(status(""), "wave1", 443)).toBe(false);
  });

  test("an allow policy lets everything in", () => {
    expect(ufwAllows(status("", "allow"), "wave1", 443)).toBe(true);
  });

  test("a rule on the interface, with or without a port, lets it in", () => {
    expect(ufwAllows(status("443/tcp on wave1           ALLOW IN    Anywhere"), "wave1", 443)).toBe(true);
    expect(ufwAllows(status("Anywhere on wave1          ALLOW IN    Anywhere"), "wave1", 443)).toBe(true);
    expect(ufwAllows(status("443/tcp (v6) on wave1      ALLOW IN    Anywhere (v6)"), "wave1", 443)).toBe(
      true,
    );
    expect(ufwAllows(status("400:500/tcp on wave1       ALLOW IN    10.195.0.1"), "wave1", 443)).toBe(true);
  });

  test("a rule on another interface, for another port or for UDP does not", () => {
    expect(ufwAllows(status("443/tcp on wave0           ALLOW IN    Anywhere"), "wave1", 443)).toBe(false);
    expect(ufwAllows(status("8443/tcp on wave1          ALLOW IN    Anywhere"), "wave1", 443)).toBe(false);
    expect(ufwAllows(status("443/udp on wave1           ALLOW IN    Anywhere"), "wave1", 443)).toBe(false);
    expect(ufwAllows(status("443/tcp on wave1           DENY IN     Anywhere"), "wave1", 443)).toBe(false);
  });

  test("a rule on every interface counts from anywhere, not from one network", () => {
    expect(ufwAllows(status("80,443/tcp                 ALLOW IN    Anywhere"), "wave1", 443)).toBe(true);
    expect(ufwAllows(status("443                        ALLOW IN    192.168.0.0/16"), "wave1", 443)).toBe(
      false,
    );
  });
});

const runner =
  (answers: Record<string, Partial<CommandResult>>) =>
  (binary: string): CommandRunner =>
  async (args) => {
    const answer = answers[`${binary} ${args.join(" ")}`] ?? { code: 127 };
    return { code: 0, stdout: "", stderr: "", ...answer };
  };

describe("linuxHostFirewall", () => {
  test("an active ufw that drops the port gives its rule", async () => {
    const tool = runner({ "ufw status verbose": { stdout: status("") } });
    expect(await linuxHostFirewall(tool, "wave1", 443)).toEqual({
      tool: "ufw",
      command: ufwCommand("wave1", 443),
    });
    expect(ufwCommand("wave1", 443)).toBe("sudo ufw allow in on wave1 to any port 443 proto tcp");
  });

  test("an inactive ufw and no firewalld is no hint", async () => {
    const tool = runner({
      "ufw status verbose": { stdout: "Status: inactive\n" },
      "firewall-cmd --state": { code: 252, stdout: "not running\n" },
    });
    expect(await linuxHostFirewall(tool, "wave1", 443)).toBeNull();
  });

  test("ufw that cannot be asked (not root) is no hint", async () => {
    const tool = runner({ "ufw status verbose": { code: 1, stderr: "ERROR: You need to be root" } });
    expect(await linuxHostFirewall(tool, "wave1", 443)).toBeNull();
  });

  test("firewalld: the interface's zone gets the port, unless it is open or trusted", async () => {
    const base = {
      "firewall-cmd --state": { stdout: "running\n" },
      "firewall-cmd --get-zone-of-interface=wave1": { stdout: "public\n" },
    };
    expect(await linuxHostFirewall(runner(base), "wave1", 443)).toEqual({
      tool: "firewalld",
      command: firewalldCommand("public", 443, "wave1"),
    });
    const open = { ...base, "firewall-cmd --zone=public --query-port=443/tcp": { stdout: "yes\n" } };
    expect(await linuxHostFirewall(runner(open), "wave1", 443)).toBeNull();
    const trusted = { ...base, "firewall-cmd --get-zone-of-interface=wave1": { stdout: "trusted\n" } };
    expect(await linuxHostFirewall(runner(trusted), "wave1", 443)).toBeNull();
  });

  test("firewalld: an interface without a zone gets one of its own, not the default zone's port", async () => {
    const tool = runner({
      "firewall-cmd --state": { stdout: "running\n" },
      "firewall-cmd --get-zone-of-interface=wave1": { code: 2, stdout: "no zone\n" },
      "firewall-cmd --get-default-zone": { stdout: "public\n" },
    });
    const block = await linuxHostFirewall(tool, "wave1", 443);
    expect(block?.command).toContain("--new-zone=wave");
    expect(block?.command).toContain("--zone=wave --add-interface=wave1");
  });
});
