/**
 * Run by ../iptables.sh inside its container, as root, with iptables-legacy as
 * the only packet filter. Three network namespaces:
 *
 *   peer (10.77.0.2) --- wave0 [ here: the connector ] back0 --- backend (10.43.0.80)
 *
 * The veth named wave0 stands in for the tunnel: the rules only know it by
 * name. `10.77.0.9` is the node's own address on it, `10.77.0.12` a service.
 */
import { LinuxLink } from "../../../apps/client/src/link-linux.ts";
import {
  detectNetfilter,
  type IptablesNetfilter,
  netfilterSelector,
} from "../../../apps/client/src/netfilter.ts";
import { iptablesForwarder } from "../../../apps/connector/src/forward.ts";
import type { ConnectorRules } from "../../../apps/connector/src/rules.ts";

let passed = 0;
const step = (title: string) => console.log(`\n== ${title}`);
function check(what: string, condition: boolean, detail = ""): void {
  if (!condition) {
    console.log(`FAIL: ${what}${detail ? `\n${detail}` : ""}`);
    console.log(save());
    process.exit(1);
  }
  passed++;
  console.log(`  ok ${what}`);
}

function sh(command: string, allowFailure = false): string {
  const result = Bun.spawnSync(["sh", "-c", command], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0 && !allowFailure) {
    console.log(`FAIL: ${command}\n${result.stderr.toString()}`);
    process.exit(1);
  }
  return result.stdout.toString();
}

/**
 * Both families as iptables-save prints them, without dates and counters -- and
 * without empty tables: a table appears the first time anybody looks into it.
 */
function save(): string {
  return ["iptables-legacy-save", "ip6tables-legacy-save"]
    .map((binary) =>
      sh(binary, true)
        .split("\n")
        .filter((line) => !line.startsWith("#"))
        .map((line) => line.replace(/ \[\d+:\d+\]$/, ""))
        .join("\n")
        .split(/(?<=\nCOMMIT\n)/)
        .filter((table) => /\n-A |\n:\S+ - |\n:\S+ -$/m.test(table))
        .join(""),
    )
    .join("---\n");
}
const count = (text: string, part: string) => text.split(part).length - 1;

const SERVER = `
const [hosts, ports] = [process.argv[1].split(","), process.argv[2].split(",")];
for (const hostname of hosts) for (const port of ports) {
  Bun.listen({ hostname, port: Number(port), socket: {
    data() {}, open(socket) { socket.write(port + " " + socket.remoteAddress); socket.end(); } } });
}
const udp = await Bun.udpSocket({ hostname: hosts[0], port: 5353,
  socket: { data(s, _b, port, addr) { s.send("udp", port, addr); } } });
console.log("listening");
`;
const CLIENT = `
const [host, port, proto] = [process.argv[1], Number(process.argv[2]), process.argv[3]];
const done = (word) => { console.log(word); process.exit(0); };
setTimeout(() => done("timeout"), 1200);
if (proto === "udp") {
  const socket = await Bun.udpSocket({ connect: { hostname: host, port },
    socket: { data(_s, data) { done("reply " + data.toString()); }, error() { done("refused"); } } });
  socket.send("ping");
} else {
  try {
    await Bun.connect({ hostname: host, port, socket: {
      data(_s, data) { done("reply " + data.toString()); }, close() { done("closed"); },
      connectError() { done("refused"); }, open() {} } });
  } catch { done("refused"); }
}
`;

/** "reply ...", "timeout" (dropped) or "refused" (rejected, or nobody there). */
async function connect(netns: string, host: string, port: number, proto = "tcp"): Promise<string> {
  const prefix = netns ? ["ip", "netns", "exec", netns] : [];
  const child = Bun.spawn([...prefix, "bun", "-e", CLIENT, host, String(port), proto], { stdout: "pipe" });
  return (await new Response(child.stdout).text()).trim();
}
async function listen(netns: string, hosts: string, ports: string) {
  const prefix = netns ? ["ip", "netns", "exec", netns] : [];
  const child = Bun.spawn([...prefix, "bun", "-e", SERVER, hosts, ports], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const first = await child.stdout.getReader().read();
  if (!new TextDecoder().decode(first.value).includes("listening")) process.exit(1);
  return child;
}
const ping = (host: string) =>
  Bun.spawnSync(["ip", "netns", "exec", "peer", "ping", "-c1", "-W1", host]).exitCode === 0;

step("the container: iptables-legacy and no nft");
check("no nft binary", sh("command -v nft || true").trim() === "");
const found = await detectNetfilter("auto");
check(
  `auto picks ${JSON.stringify(found.kind === "iptables" ? [found.v4.name, found.v6?.name] : found)}`,
  found.kind === "iptables" && found.v4.name === "iptables-legacy" && found.v6?.name === "ip6tables-legacy",
);
const netfilter = found as IptablesNetfilter;

step("three namespaces");
sh("ip netns add peer && ip netns add backend");
sh("ip link add wave0 type veth peer name eth0 netns peer");
sh("ip link add back0 type veth peer name eth0 netns backend");
sh("sysctl -qw net.ipv4.ip_forward=1 net.ipv6.conf.all.forwarding=0 net.ipv6.conf.all.disable_ipv6=0");
sh("ip addr add 10.77.0.9/24 dev wave0 && ip addr add 10.77.0.12/32 dev wave0 && ip link set wave0 up");
sh("ip -6 addr add fd7a:1:2::9/64 dev wave0 nodad && ip -6 addr add fd7a:1:2::c/128 dev wave0 nodad");
sh("ip addr add 10.43.0.1/24 dev back0 && ip -6 addr add fd00::1/64 dev back0 nodad && ip link set back0 up");
for (const [netns, v4, v6] of [
  ["peer", "10.77.0.2/24", "fd7a:1:2::2/64"],
  ["backend", "10.43.0.80/24", "fd00::80/64"],
]) {
  const ip = `ip -n ${netns}`;
  sh(`${ip} link set lo up && ${ip} link set eth0 up`);
  sh(`${ip} addr add ${v4} dev eth0 && ${ip} -6 addr add ${v6} dev eth0 nodad`);
}
sh("ip -n peer route add 10.43.0.0/24 via 10.77.0.9");
// Only for the control run: a real cluster has no route back into the wave,
// which is what the masquerade is for -- the source the backend sees proves it.
sh("ip -n backend route add 10.77.0.0/24 via 10.43.0.1");
await listen("backend", "10.43.0.80", "80,443,22");
await listen("backend", "fd00::80", "80,443");
await listen("", "10.77.0.9", "8000");
await listen("", "fd7a:1:2::9", "8001");
await listen("peer", "10.77.0.2", "9000");
await Bun.sleep(500);

step("rules of somebody else, which must survive everything below");
sh("iptables-legacy -A FORWARD -s 192.0.2.1 -j DROP");
sh("iptables-legacy -t nat -A POSTROUTING -s 192.0.2.0/24 -j MASQUERADE");
sh("iptables-legacy -t mangle -A PREROUTING -s 192.0.2.1 -j DROP");
sh("ip6tables-legacy -A INPUT -s 2001:db8::1 -j DROP");
const untouched = save();

step("control: without our rules the way to the cluster is open and the service leads nowhere");
check("peer -> backend:22 directly", (await connect("peer", "10.43.0.80", 22)).startsWith("reply 22"));
check("service:80 answers nobody", (await connect("peer", "10.77.0.12", 80)) === "refused");

const rules: ConnectorRules = {
  interfaceName: "wave0",
  ownAddresses: ["10.77.0.9", "fd7a:1:2::9"],
  backend: { ipv4: "10.43.0.80" },
  ports: [80, 443],
  mtu: 1280,
};
const said: string[] = [];
const forwarder = iptablesForwarder(netfilter, { log: (line) => said.push(line) });

step("connector: apply, and apply again");
await forwarder.apply("", rules);
const once = save();
await forwarder.apply("", rules);
check("applying twice is applying once (iptables-save)", save() === once, `${once}\n=====\n${save()}`);
check("nothing was given up (TCPMSS, REJECT)", said.length === 0, said.join("\n"));
for (const jump of [
  "-A PREROUTING -j WAVE-CONN-PRE",
  "-A POSTROUTING -j WAVE-CONN-POST",
  "-A INPUT -j WAVE-CONN-REJ",
]) {
  check(`exactly one "${jump}"`, count(once, `${jump}\n`) === 1, once);
}
check("one jump into FORWARD per family", count(once, "-A FORWARD -j WAVE-CONN-FWD\n") === 2, once);
check("MSS clamp is in", once.includes("TCPMSS --set-mss 1240"), once);

step("connector: traffic");
for (const port of [80, 443]) {
  const answer = await connect("peer", "10.77.0.12", port);
  check(`service:${port} -> backend, masqueraded (${answer})`, answer === `reply ${port} 10.43.0.1`);
}
check("service:22 is not a service", (await connect("peer", "10.77.0.12", 22)) === "refused");
check("backend:22 directly is dropped", (await connect("peer", "10.43.0.80", 22)) === "timeout");
check("udp to the backend is dropped", (await connect("peer", "10.43.0.80", 5353, "udp")) === "timeout");
check("our own address stays ours", (await connect("peer", "10.77.0.9", 8000)).startsWith("reply 8000"));
check("v6 service port is refused at once", (await connect("peer", "fd7a:1:2::c", 80)) === "refused");
check(
  "REJECT counted that packet",
  /\n\s*[1-9]\d*\s+\d+\s+REJECT/.test(sh("ip6tables-legacy -nvL WAVE-CONN-REJ")),
);
check("v6 own address stays ours", (await connect("peer", "fd7a:1:2::9", 8001)).startsWith("reply 8001"));

const peerRule = {
  src: ["10.77.0.2/32", "fd7a:1:2::2/128"],
  dst: ["10.77.0.12/32"],
  ports: [{ proto: "tcp" as const, from: 80, to: 80 }],
};
const v6Rule = {
  src: ["fd7a:1:2::2/128"],
  dst: ["fd7a:1:2::9/128"],
  ports: [{ proto: "tcp" as const, from: 8001, to: 8001 }],
};

/** The policy through the daemon's own code path, in either table. */
async function policy(table: "mangle" | "filter") {
  const select = netfilterSelector({});
  const link = new LinuxLink(
    undefined,
    undefined,
    undefined,
    undefined,
    table === "mangle"
      ? select
      : async () => {
          // A kernel without the mangle table, as far as the filter can tell.
          const real = (await select()) as IptablesNetfilter;
          const hide = (tool: IptablesNetfilter["v4"]) => ({
            ...tool,
            run: async (args: string[]) =>
              args.join(" ") === "-t mangle -S PREROUTING"
                ? { code: 3, stdout: "", stderr: "Table does not exist" }
                : tool.run(args),
          });
          return { ...real, v4: hide(real.v4), v6: real.v6 && hide(real.v6) };
        },
  );

  step(`policy in the ${table} table, next to the connector: apply, and apply again`);
  let result = await link.syncFilter("wave0", [peerRule, v6Rule]);
  check(`enforced ${result.reason ?? ""}`, result.enforced);
  const first = save();
  result = await link.syncFilter("wave0", [peerRule, v6Rule]);
  check("applying twice is applying once", result.enforced && save() === first, `${first}\n=====\n${save()}`);
  const hooks = table === "mangle" ? ["PREROUTING"] : ["INPUT", "FORWARD"];
  for (const hook of hooks) {
    check(
      `one jump from ${hook} per family`,
      count(first, `-A ${hook} -i wave0 -j WAVE-ACL-wave0\n`) === 2,
      first,
    );
  }
  check("service:80 is granted", (await connect("peer", "10.77.0.12", 80)).startsWith("reply 80"));
  check("service:443 is not", (await connect("peer", "10.77.0.12", 443)) === "timeout");
  check("nor is the device itself", (await connect("peer", "10.77.0.9", 8000)) === "timeout");
  check("ping passes", ping("10.77.0.9"));
  check(
    "what this device opens gets its replies",
    (await connect("", "10.77.0.2", 9000)).startsWith("reply 9000"),
  );
  check("v6 own:8001 is granted", (await connect("peer", "fd7a:1:2::9", 8001)).startsWith("reply 8001"));
  check("v6 service:80 is not", (await connect("peer", "fd7a:1:2::c", 80)) === "timeout");

  step(`an empty policy in the ${table} table`);
  check("enforced", (await link.syncFilter("wave0", [])).enforced);
  check("service:80 is closed", (await connect("peer", "10.77.0.12", 80)) === "timeout");
  check("v6 own:8001 is closed", (await connect("peer", "fd7a:1:2::9", 8001)) === "timeout");
  check("ping still passes", ping("10.77.0.9"));
  check("replies still come back", (await connect("", "10.77.0.2", 9000)).startsWith("reply 9000"));

  step(`removing the policy from the ${table} table`);
  check("enforced", (await link.syncFilter("wave0", null)).enforced);
  check("no policy chain left", !save().includes("WAVE-ACL"), save());
  check("exactly the connector's rules remain", save() === once, `${once}\n=====\n${save()}`);
  check("service:443 again", (await connect("peer", "10.77.0.12", 443)).startsWith("reply 443"));
  check("removing twice is fine", (await link.syncFilter("wave0", null)).enforced);
  return link;
}

const mangled = await policy("mangle");
const filtered = await policy("filter");

step("a policy that moves from one table to the other leaves nothing behind");
await filtered.syncFilter("wave0", [peerRule]);
await mangled.syncFilter("wave0", [peerRule]);
check("only the mangle jumps", !/-A (INPUT|FORWARD) -i wave0 -j WAVE-ACL/.test(save()), save());
check("still enforced", (await connect("peer", "10.77.0.12", 443)) === "timeout");
await mangled.syncFilter("wave0", null);

step("connector with an IPv6 backend, then without again");
sh("sysctl -qw net.ipv6.conf.all.forwarding=1");
await forwarder.apply("", { ...rules, backend: { ipv4: "10.43.0.80", ipv6: "fd00::80" } });
const v6Answer = await connect("peer", "fd7a:1:2::c", 80);
check(`v6 service:80 -> v6 backend (${v6Answer})`, v6Answer === "reply 80 fd00::1");
check("v6 reject chain is gone", !save().includes("WAVE-CONN-REJ"), save());
sh("sysctl -qw net.ipv6.conf.all.forwarding=0");
await forwarder.apply("", rules);
check("back to exactly the first rules", save() === once, `${once}\n=====\n${save()}`);

step("stopping");
await forwarder.clear?.();
check("no wave chain and no jump left", !save().includes("WAVE-"), save());
check("everybody else's rules are as they were", save() === untouched, `${untouched}\n=====\n${save()}`);
await forwarder.apply("", rules);
check("nothing comes back after the stop", !save().includes("WAVE-"), save());

console.log(`\nPASS: ${passed} checks against ${sh("iptables-legacy -V").trim()}`);
process.exit(0);
