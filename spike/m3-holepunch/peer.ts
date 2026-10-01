// M3 spike peer: one UDP socket, STUN-derived candidates, simultaneous hole
// punching against every candidate of the other side.
//
// Deliberately NOT in here (see docs/PLAN.md): WireGuard, authenticated disco
// packets, relay fallback, path MTU, portmapping, IPv6.

import { lookup } from "node:dns/promises";
import { networkInterfaces } from "node:os";
import { parseArgs } from "node:util";
import {
  type Candidate,
  type ClientMessage,
  candKey,
  DiscoType,
  decodeDisco,
  encodeDisco,
  newTxid,
  type ServerMessage,
} from "./proto.ts";
import { classifyMapping, DEFAULT_STUN_SERVERS, type Mapped, StunClient } from "./stun.ts";

const { values } = parseArgs({
  options: {
    name: { type: "string" },
    room: { type: "string", default: "spike" },
    rendezvous: { type: "string", default: "ws://127.0.0.1:8787" },
    port: { type: "string", default: "0" },
    duration: { type: "string", default: "25" },
    stun: { type: "string", default: DEFAULT_STUN_SERVERS.join(",") },
    "no-local": { type: "boolean", default: false },
    natcheck: { type: "boolean", default: false },
  },
});

const NAME = values.name ?? `peer-${Math.random().toString(36).slice(2, 6)}`;
const DURATION_MS = Number(values.duration) * 1000;
const t0 = performance.now();
const log = (...a: unknown[]) =>
  console.log(`[${((performance.now() - t0) / 1000).toFixed(2)}s] ${NAME}`, ...a);

// --- path bookkeeping -------------------------------------------------------

interface Path {
  addr: string;
  learned: boolean; // address we only saw because a ping arrived from it
  rtts: number[];
  lastPongAt?: number;
  firstPongAt?: number;
  inboundPings: number;
  sent: number;
  sendErrors: number;
}

const paths = new Map<string, Path>();
const inflight = new Map<string, { addr: string; sentAt: number }>();
let firstInboundAt: number | undefined;
let goAt: number | undefined;

const path = (addr: string, learned = false): Path => {
  let p = paths.get(addr);
  if (!p) {
    p = { addr, learned, rtts: [], inboundPings: 0, sent: 0, sendErrors: 0 };
    paths.set(addr, p);
  }
  return p;
};

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? Number.POSITIVE_INFINITY;
};

const bestPath = (): Path | undefined => {
  const working = [...paths.values()].filter((p) => p.lastPongAt !== undefined);
  working.sort((a, b) => median(a.rtts) - median(b.rtts));
  return working[0];
};

// --- socket -----------------------------------------------------------------

const sock = await Bun.udpSocket({
  port: Number(values.port),
  socket: {
    data(_s, buf: Uint8Array, port: number, addr: string) {
      const from = `${addr}:${port}`;
      if (stun.handle(buf)) return;

      const pkt = decodeDisco(buf);
      if (!pkt) return log(`ignored ${buf.length}B from ${from} (not disco)`);
      // Only peer traffic counts: STUN answers come from a server we contacted
      // first and say nothing about whether the peer got through.
      if (firstInboundAt === undefined) firstInboundAt = performance.now();

      if (pkt.type === DiscoType.Ping) {
        const known = paths.has(from);
        const p = path(from, !known);
        p.inboundPings++;
        if (!known) {
          // Their NAT rewrote the source port, or they have an address they did
          // not advertise. Punching back at exactly this address is what makes
          // one-sided symmetric NAT work.
          log(`learned endpoint ${from} from inbound ping by ${pkt.from}`);
        }
        if (p.inboundPings === 1) log(`inbound ping from ${pkt.from} via ${from}`);
        trySend(encodeDisco({ type: DiscoType.Pong, txid: pkt.txid, from: NAME }), from, p);
        return;
      }

      const sentInfo = inflight.get(pkt.txid);
      if (!sentInfo) return;
      inflight.delete(pkt.txid);
      const p = path(from);
      const rtt = performance.now() - sentInfo.sentAt;
      p.rtts.push(rtt);
      p.lastPongAt = performance.now();
      if (p.firstPongAt === undefined) {
        p.firstPongAt = performance.now();
        const since = goAt ? ((p.firstPongAt - goAt) / 1000).toFixed(2) : "?";
        log(
          `✅ DIRECT PATH via ${from} — first pong ${since}s after GO, rtt ${rtt.toFixed(1)}ms${p.learned ? " (learned address)" : ""}`,
        );
      }
    },
  },
});

function trySend(data: Uint8Array, addr: string, p?: Path) {
  const idx = addr.lastIndexOf(":");
  const ip = addr.slice(0, idx);
  const port = Number(addr.slice(idx + 1));
  const rec = p ?? path(addr);
  try {
    sock.send(data, port, ip);
    rec.sent++;
  } catch (e) {
    rec.sendErrors++;
    if (rec.sendErrors === 1) log(`send to ${addr} failed: ${(e as Error).message}`);
  }
}

const stun = new StunClient((data, port, ip) => {
  try {
    sock.send(data, port, ip);
  } catch (e) {
    log(`STUN send failed: ${(e as Error).message}`);
  }
});

// --- candidate gathering ----------------------------------------------------

const candidates: Candidate[] = [];
const mappings: Mapped[] = [];

if (!values["no-local"]) {
  for (const [iface, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      candidates.push({ kind: "local", ip: a.address, port: sock.port });
      log(`local candidate ${a.address}:${sock.port} (${iface})`);
    }
  }
}

for (const server of values.stun
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)) {
  const [host, portStr] = server.split(":");
  if (!host) continue;
  try {
    const { address } = await lookup(host, 4);
    const mapped = await stun.query(address, Number(portStr ?? 3478));
    mappings.push(mapped);
    log(`stun ${server} -> ${mapped.ip}:${mapped.port}`);
    if (!candidates.some((c) => candKey(c) === candKey(mapped))) {
      candidates.push({ kind: "stun", ...mapped });
    }
  } catch (e) {
    log(`stun ${server} failed: ${(e as Error).message}`);
  }
}

const mapping = classifyMapping(mappings);
log(`local port ${sock.port} | NAT mapping: ${mapping}`);

if (values.natcheck) {
  console.log("\nnatcheck only — exiting.");
  process.exit(mappings.length >= 2 ? 0 : 1);
}
if (candidates.length === 0) {
  console.error("no candidates at all — no usable interface and no STUN answer");
  process.exit(1);
}

// --- rendezvous -------------------------------------------------------------

const ws = new WebSocket(values.rendezvous);
const wsSend = (m: ClientMessage) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
let remoteName: string | undefined;
let punching = false;

ws.addEventListener("open", () => {
  log(`rendezvous connected, waiting for peer in room "${values.room}"`);
  wsSend({ type: "hello", room: values.room, name: NAME, candidates, mapping });
});
ws.addEventListener("error", () => log(`rendezvous error (${values.rendezvous})`));
ws.addEventListener("close", () => log("rendezvous closed"));

ws.addEventListener("message", (ev) => {
  const msg: ServerMessage = JSON.parse(String(ev.data));
  if (msg.type === "peer") {
    remoteName = msg.name;
    log(`peer ${msg.name} | mapping: ${msg.mapping}`);
    for (const c of msg.candidates) {
      path(candKey(c));
      log(`  remote candidate ${c.kind} ${c.ip}:${c.port}`);
    }
    if (mapping.includes("symmetric") && msg.mapping.includes("symmetric")) {
      log("⚠️  both sides symmetric — expect direct punching to fail (this is the M4/relay case)");
    }
  } else if (msg.type === "go") {
    if (punching) return;
    punching = true;
    goAt = performance.now();
    log("GO — punching");
    punch();
  } else if (msg.type === "gone") {
    log(`peer ${msg.name} disconnected`);
  } else if (msg.type === "error") {
    log(`rendezvous error: ${msg.message}`);
  }
});

// --- punching ---------------------------------------------------------------

function punch() {
  const started = performance.now();
  const tick = () => {
    const elapsed = performance.now() - started;
    if (elapsed > DURATION_MS) return finish();
    for (const p of paths.values()) {
      const txid = newTxid();
      inflight.set(txid, { addr: p.addr, sentAt: performance.now() });
      trySend(encodeDisco({ type: DiscoType.Ping, txid, from: NAME }), p.addr, p);
    }
    // Fast burst first: the window in which both NATs have state open is short.
    setTimeout(tick, elapsed < 5000 ? 100 : 500);
  };
  tick();
}

function finish() {
  const best = bestPath();
  const working = [...paths.values()].filter((p) => p.lastPongAt !== undefined);
  const lines: string[] = [];

  lines.push(`self mapping: ${mapping}`);
  lines.push(`peer: ${remoteName ?? "(none)"}`);
  lines.push(
    `first inbound packet: ${firstInboundAt && goAt ? `${((firstInboundAt - goAt) / 1000).toFixed(2)}s after GO` : "never"}`,
  );
  if (best) {
    const ttf = best.firstPongAt && goAt ? ((best.firstPongAt - goAt) / 1000).toFixed(2) : "?";
    lines.push(
      `VERDICT: DIRECT CONNECTION ESTABLISHED via ${best.addr}${best.learned ? " (learned address)" : ""}`,
    );
    lines.push(
      `  time to first pong: ${ttf}s | rtt median ${median(best.rtts).toFixed(1)}ms over ${best.rtts.length} samples`,
    );
    lines.push(`  working paths: ${working.map((p) => p.addr).join(", ")}`);
  } else {
    lines.push("VERDICT: NO DIRECT PATH — relay required (M4)");
  }
  for (const p of paths.values()) {
    lines.push(
      `  path ${p.addr}: sent=${p.sent} sendErr=${p.sendErrors} inPing=${p.inboundPings} pongs=${p.rtts.length}`,
    );
  }

  const summary = lines.join("\n           ");
  console.log(`\n===== ${NAME} =====\n${lines.join("\n")}\n`);
  wsSend({ type: "result", name: NAME, summary });
  setTimeout(() => {
    ws.close();
    sock.close();
    process.exit(best ? 0 : 2);
  }, 250);
}

process.on("SIGINT", () => finish());
