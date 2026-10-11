import {
  decodeDisco,
  type Endpoint,
  encodeDisco,
  looksLikeDisco,
  newTxid,
  sharedKey,
  txidToHex,
} from "@wave/disco";
import type { RelayClient } from "./relay-client.ts";
import {
  buildBindingRequest,
  classifyMapping,
  looksLikeStun,
  type Mapped,
  parseBindingResponse,
} from "./stun.ts";

/**
 * Owns the one public UDP socket and multiplexes everything that arrives on it.
 *
 * WireGuard itself runs in userspace and listens only on loopback; for every
 * peer we bind a separate loopback socket and hand that address to WireGuard as
 * the peer's endpoint. WireGuard therefore never changes its configuration when
 * a path changes -- it keeps sending to the same loopback address while this
 * class decides how the packet actually travels.
 *
 * That indirection is what makes hole punching possible at all: discovery
 * packets and WireGuard traffic must leave from the same port, which the kernel
 * implementation would not let us share. It is also what makes the relay
 * invisible: a relayed path is just another path, and because paths are ranked
 * by round-trip time, a direct path takes over the moment one exists.
 */

export interface PeerConfig {
  nodeKey: string;
  discoKey: string;
  candidates: Endpoint[];
}

export interface PathState {
  /** "ip:port" for a direct path, "relay" for the relayed one. */
  key: string;
  endpoint?: Endpoint;
  viaRelay: boolean;
  /** Discovered from an inbound packet rather than announced by the peer. */
  learned: boolean;
  /** When the last probe went out; the cadence runs from here (see probeDue). */
  lastPingAt?: number;
  lastPongAt?: number;
  rttMs?: number;
}

export interface PeerStatus {
  nodeKey: string;
  best?: Endpoint;
  viaRelay: boolean;
  rttMs?: number;
  paths: PathState[];
  /**
   * Nothing sent to this peer for ACTIVE_TIMEOUT_MS, so it is not probed and
   * whatever path it had is the last one known, not a measured one.
   */
  idle: boolean;
}

export interface MagicSockOptions {
  listenPort: number;
  discoPrivateKey: string;
  discoPublicKey: string;
  /** Loopback port the userspace WireGuard implementation listens on. */
  wireguardPort: number;
  stunServers?: Endpoint[];
  log?: (message: string) => void;
  /** Logs every probe. Useful when a NAT refuses to cooperate. */
  verbose?: boolean;
  now?: () => number;
}

export const RELAY_PATH = "relay";

/** Bun does not always hand the callback an Error object. */
const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error ?? "unknown");

/** How long a storm of ignored socket errors is collected before it is named. */
export const ERROR_SUMMARY_MS = 60_000;

/**
 * Counts the socket errors that are expected and says so at most once a minute.
 *
 * Probing a peer's candidates means sending to addresses that are unroutable
 * from here -- a pod address inside a cluster, a laptop that is switched off --
 * and each of those comes back as an ICMP rejection on our own socket. Bun
 * hands the callback no error object for them, so the line they used to write
 * said "unknown" and nothing else, once per probe.
 *
 * That was worse than silence: the daemon keeps eight event lines per
 * enrolment, and a message with no content pushed out the ones that have some.
 * So they are counted, and one line a minute says how many -- which is the only
 * thing about them worth knowing, because a storm means something and a trickle
 * is the protocol working.
 */
export class IgnoredErrors {
  private count = 0;
  /** Null until the first error; not 0, which is a time like any other. */
  private since: number | null = null;

  /** The line to log, or null while the window is still collecting. */
  note(now: number, windowMs = ERROR_SUMMARY_MS): string | null {
    if (this.since === null) this.since = now;
    this.count++;
    const elapsed = now - this.since;
    if (elapsed < windowMs) return null;

    const line = `${this.count} socket error(s) ignored in ${Math.round(elapsed / 1000)}s — unreachable candidates answer with ICMP`;
    this.count = 0;
    this.since = now;
    return line;
  }
}

const key = (endpoint: Endpoint): string => `${endpoint.ip}:${endpoint.port}`;

/** A path is usable while a pong arrived recently enough. */
const PATH_TIMEOUT_MS = 15_000;
/** Probe aggressively at first: the window where both NATs are open is short. */
const PROBE_FAST_MS = 250;
const PROBE_SLOW_MS = 3_000;
const PROBE_FAST_DURATION_MS = 5_000;

/**
 * How long after WireGuard last sent a peer something that peer is still probed.
 *
 * Probing every path of every peer every three seconds, whether anything
 * flowed or not, is what kept the phones awake: on cellular each packet holds
 * the radio in its high-power state for seconds after it, and the mobile core
 * had already stopped probing idle peers itself -- but a desktop pinging the
 * phone wakes the radio just the same, and so does a 25-second WireGuard
 * keepalive. A path is only worth measuring while something is about to use
 * it; the first packet after a quiet spell starts a fast phase like a new peer
 * gets. 45 seconds is the mobile core's activeTimeout, and comfortably longer
 * than the ten seconds WireGuard waits before a passive keepalive.
 *
 * Only what we send counts, not what we receive: a peer of an older version
 * that keeps its tunnel to us alive would otherwise keep us probing for ever.
 */
export const ACTIVE_TIMEOUT_MS = 45_000;

/** Whether WireGuard sent this peer something recently enough to probe it. */
export const isActive = (peer: { lastSendAt?: number }, now: number): boolean =>
  peer.lastSendAt !== undefined && now - peer.lastSendAt < ACTIVE_TIMEOUT_MS;

/**
 * Whether a path is owed a probe.
 *
 * The cadence runs from the last ping, not the last pong. Timed from the pong,
 * a candidate that never answers was due on every tick -- four pings a second
 * for as long as the peer existed, each one an ICMP rejection on our socket and
 * a NAT entry on the router in front of us. 736 of those a minute on
 * 30.09.2026, from a handful of dead candidates. The fast phase is what
 * punching needs, and it still pings everything at 250 ms; after it, an
 * unanswered candidate is asked as often as a live path, which is enough to
 * notice it coming back.
 */
export function probeDue(path: Pick<PathState, "lastPingAt">, now: number, fast: boolean): boolean {
  if (path.lastPingAt === undefined) return true;
  // Half a tick of slack: the timer fires every PROBE_FAST_MS, and one that
  // arrives a millisecond early would otherwise skip a tick and halve the rate
  // of the fast phase.
  return now - path.lastPingAt >= (fast ? PROBE_FAST_MS : PROBE_SLOW_MS) - PROBE_FAST_MS / 2;
}
/** How much better a relay has to be before it beats a direct path. */
const RELAY_PENALTY_MS = 15;
/**
 * Weight of a fresh sample in a path's round-trip time.
 *
 * One probe every three seconds over WiFi swings by an order of magnitude --
 * measured between two of our own nodes: the same direct path reported 14 ms
 * and 110 ms within a minute. Deciding on the last sample meant crossing the
 * relay's latency again and again, and the path changed on nearly every probe.
 * A quarter weight settles in about four samples, which is well inside
 * PATH_TIMEOUT_MS, so a path that genuinely goes bad is still noticed long
 * before it is dropped.
 */
const RTT_ALPHA = 0.25;
/**
 * How much better a challenger has to be before the current path is given up.
 *
 * Separate from RELAY_PENALTY_MS, which says what a relay is worth; this says
 * that changing path is not free. Smoothing alone still leaves two paths
 * trading places whenever their averages sit within a millisecond of each
 * other, and a switch reorders whatever is in flight.
 */
const SWITCH_MARGIN_MS = 10;
/**
 * A challenger at this fraction of the incumbent's time wins regardless.
 *
 * The margin alone is absolute, and on a LAN everything is smaller than it:
 * after a blip had moved traffic from the LAN (5 ms) onto the round trip
 * through the router's public address (13 ms), the LAN could never take it
 * back -- eight milliseconds is not ten -- and every packet kept crossing the
 * router's NAT for as long as the detour lived. Seen on 28.09.2026. Half the
 * time is not noise between two smoothed averages; it is a different path.
 */
const SWITCH_RATIO = 0.5;
/** How many paths a single WireGuard packet may be sprayed to while probing. */
const MAX_SPRAY = 8;
/**
 * How long an address of ours stays a candidate after anything last reported it.
 *
 * Behind a NAT that maps every destination to a fresh port, each STUN round
 * reports a port nobody will ever reach us on again. Kept forever, a connector
 * running two days published 2670 of them, and every peer probed every one --
 * four times a second, each to a new destination port, which is a fresh NAT
 * session apiece on the router in front of that peer. Three STUN rounds is
 * long enough to ride out one lost answer; a stable mapping is re-reported
 * every round and never ages out.
 */
export const REFLEXIVE_TTL_MS = 180_000;
/** A ceiling on top of the age limit, in case a NAT hands out ports faster. */
export const MAX_REFLEXIVE = 8;

export interface SeenAddress {
  mapped: Mapped;
  seenAt: number;
  /** In how many STUN rounds it was reported. */
  rounds: number;
}

/**
 * The addresses of ours worth publishing: seen recently, newest few only,
 * oldest first -- the order an append-only list had, which the server relies
 * on when it trims an old client's list.
 *
 * A port reported only once is held back while another port on the same
 * address is around, until a second round reports it again. Behind a NAT that forgets its mapping between
 * rounds -- the SNAT in front of a k3s pod, measured 11.10.2026 -- every round
 * names a fresh port, and publishing each one changed the list every minute:
 * a netmap for the whole wave every minute, 24,000 of them in twenty days,
 * each waking every phone in it. None of those ports reached anybody; the
 * mapping was gone before a peer could try. A NAT that keeps its mapping
 * confirms the port a round later, and a first address -- after a start, a
 * rebind or a new network -- stands alone and goes out at once. "Alone", not
 * "first": otherwise, as the oldest port aged out, the next oldest would count
 * as first and the list would turn over every round again.
 */
export function currentReflexive(seen: Iterable<SeenAddress>, now: number): Mapped[] {
  const recent = [...seen].filter((entry) => now - entry.seenAt <= REFLEXIVE_TTL_MS);
  const contested = (entry: SeenAddress) =>
    recent.some((other) => other.mapped.ip === entry.mapped.ip && other.mapped.port !== entry.mapped.port);
  return recent
    .filter((entry) => entry.rounds > 1 || !contested(entry))
    .sort((a, b) => b.seenAt - a.seenAt)
    .slice(0, MAX_REFLEXIVE)
    .reverse()
    .map((entry) => entry.mapped);
}

/**
 * A path's round-trip time, with the new sample folded in.
 *
 * Pure and exported because this is where the flapping was decided, and it is
 * testable without a network -- unlike everything around it.
 */
export const smoothRtt = (previous: number | undefined, sample: number): number =>
  previous === undefined ? sample : previous + RTT_ALPHA * (sample - previous);

/**
 * Which path should carry the traffic.
 *
 * Lowest round-trip time wins, with a handicap for the relay and a margin for
 * whichever path is already carrying the traffic.
 *
 * Without the handicap the choice would come down to noise whenever the two
 * are close, and a relayed path is not equal to a direct one at the same
 * latency: it spends someone else's bandwidth and puts a third party in the
 * path. It has to be clearly better to be worth taking.
 *
 * Without the margin it would come down to noise anyway, one step further
 * along: two paths whose averages sit a millisecond apart would swap on every
 * probe. The incumbent therefore only loses to a clear improvement -- ten
 * milliseconds, or half its time, whichever is reached first -- and a path
 * that has stopped answering is not an incumbent at all, so falling off a
 * dead path stays immediate.
 */
export function choosePath(
  paths: Iterable<PathState>,
  current: string | undefined,
  now: number,
): PathState | undefined {
  const alive = (path: PathState) =>
    path.lastPongAt !== undefined && now - path.lastPongAt <= PATH_TIMEOUT_MS;
  const score = (path: PathState) =>
    (path.rttMs ?? Number.POSITIVE_INFINITY) + (path.viaRelay ? RELAY_PENALTY_MS : 0);

  let best: PathState | undefined;
  let incumbent: PathState | undefined;
  for (const path of paths) {
    if (!alive(path)) continue;
    if (path.key === current) incumbent = path;
    if (!best || score(path) < score(best)) best = path;
  }

  if (incumbent && best && best.key !== incumbent.key) {
    const clearlyBetter =
      score(best) <= score(incumbent) - SWITCH_MARGIN_MS || score(best) <= score(incumbent) * SWITCH_RATIO;
    if (!clearlyBetter) return incumbent;
  }
  return best;
}

type UdpSocket = Bun.udp.Socket<"buffer">;

interface Peer {
  config: PeerConfig;
  shared: Uint8Array;
  loopback: UdpSocket;
  paths: Map<string, PathState>;
  best?: string;
  probingSince: number;
  /** When this peer first appeared; a newcomer is still being punched. */
  joinedAt: number;
  /** When WireGuard last sent this peer anything; see ACTIVE_TIMEOUT_MS. */
  lastSendAt?: number;
  /** When it last went from idle to active -- a newcomer again, for wantsRebind. */
  wokeAt?: number;
}

/** How long a new peer may have no path before it says anything about our port. */
export const REBIND_GRACE_MS = 30_000;

/**
 * Whether moving to a fresh UDP port could help.
 *
 * A port collision at a NAT cannot be seen, only inferred: nobody answers. So
 * the rule is about nobody -- not about somebody. As long as one peer is
 * reachable on this port, the port works, and moving away from it breaks every
 * session that uses it while helping nobody: the peers that still have no
 * path are offline, or still being punched. It used to be "some peer has no
 * path", which a device joining the wave satisfied every time -- and the
 * other nodes changed ports under the phones, which have to learn the new
 * one before anything flows again. Seen as a session that carried nothing
 * for ten seconds after a third device joined.
 *
 * A peer younger than REBIND_GRACE_MS does not count either way: being
 * unreachable is what a newcomer is until the punch completes.
 */
export function wantsRebind(peers: Iterable<{ best?: string; joinedAt: number }>, now: number): boolean {
  let settled = false;
  for (const peer of peers) {
    if (peer.best) return false;
    if (now - peer.joinedAt >= REBIND_GRACE_MS) settled = true;
  }
  return settled;
}

export class MagicSock {
  private socket?: UdpSocket;
  private relay?: RelayClient;
  private readonly peers = new Map<string, Peer>();
  private readonly byAddress = new Map<string, Peer>();
  private readonly inflight = new Map<string, { peer: Peer; path: PathState; sentAt: number }>();
  private readonly pendingStun = new Map<string, (mapped: Mapped) => void>();
  private readonly reflexive = new Map<string, SeenAddress>();
  private stunServers: Endpoint[];
  private probingEnabled = false;
  private probeTimer?: ReturnType<typeof setInterval>;
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  private readonly ignored = new IgnoredErrors();

  constructor(private readonly options: MagicSockOptions) {
    this.log = options.log ?? (() => {});
    this.now = options.now ?? (() => Date.now());
    this.stunServers = options.stunServers ?? [];
  }

  get port(): number {
    return this.socket?.port ?? this.options.listenPort;
  }

  async start(): Promise<void> {
    this.socket = await this.bindPublic(this.options.listenPort);
    this.probeTimer = setInterval(() => void this.probe(), PROBE_FAST_MS);
  }

  /**
   * Binds the public socket, falling back to an ephemeral port when the
   * preferred one is taken -- another mesh VPN may well default to it too.
   * Nothing depends on the number: peers learn it from our published
   * candidates, which are derived from the port we actually got.
   */
  /**
   * An error the protocol expects: logged in full only when asked for it,
   * counted otherwise. See IgnoredErrors for why it is not simply printed.
   */
  private noteIgnored(where: string, error: unknown): void {
    if (this.options.verbose) {
      this.log(`${where} error (ignored): ${describeError(error)}`);
      return;
    }
    const line = this.ignored.note(this.now());
    if (line) this.log(line);
  }

  private async bindPublic(port: number): Promise<UdpSocket> {
    try {
      return await this.openSocket(port);
    } catch (error) {
      const inUse = (error as { code?: string }).code === "EADDRINUSE";
      if (port === 0 || !inUse) throw error;
      this.log(`port ${port} is already in use; binding an ephemeral port instead`);
      return this.openSocket(0);
    }
  }

  private openSocket(port: number): Promise<UdpSocket> {
    return Bun.udpSocket({
      port,
      socket: {
        data: (_socket, data, from, address) => this.onWirePacket(data, { ip: address, port: from }),
        // Probing candidates a peer published means regularly sending to
        // addresses that are unroutable from here. The resulting ICMP errors
        // come back on this socket and must not take the process down.
        error: (_socket, error) => this.noteIgnored("socket", error),
      },
    });
  }

  /**
   * Moves the public socket to a fresh port, keeping peers and their paths.
   *
   * This is the way out of a NAT port collision: an unsolicited inbound packet
   * from a peer can create a conntrack entry that occupies exactly the tuple we
   * need, after which our NAT translates us to a port nobody knows. On a fresh
   * port we get to send first -- the peer cannot have poisoned a port it has
   * never heard of -- so the outbound mapping is established cleanly.
   */
  async rebind(): Promise<number> {
    const previous = this.socket;
    this.reflexive.clear();
    this.socket = await this.bindPublic(0);
    previous?.close();
    this.log(`rebound to port ${this.socket.port}`);
    void this.probe();
    return this.socket.port;
  }

  /**
   * See wantsRebind. Only active peers count: an idle one is not probed, so
   * having no path says nothing about our port -- and moving it publishes new
   * candidates, which pushes a netmap to the whole wave and wakes every phone
   * in it. One that just woke up is a newcomer again: its old path has expired
   * and the punch takes as long as the first one.
   */
  needsRebind(): boolean {
    const now = this.now();
    const active = [...this.peers.values()]
      .filter((peer) => isActive(peer, now))
      .map((peer) => ({ best: peer.best, joinedAt: Math.max(peer.joinedAt, peer.wokeAt ?? 0) }));
    return wantsRebind(active, now);
  }

  async close(): Promise<void> {
    if (this.probeTimer) clearInterval(this.probeTimer);
    for (const peer of this.peers.values()) peer.loopback.close();
    this.peers.clear();
    this.byAddress.clear();
    this.socket?.close();
  }

  /** Loopback address WireGuard must use as this peer's endpoint. */
  endpointForWireguard(nodeKey: string): Endpoint | undefined {
    const peer = this.peers.get(nodeKey);
    return peer ? { ip: "127.0.0.1", port: peer.loopback.port } : undefined;
  }

  status(): PeerStatus[] {
    const now = this.now();
    return [...this.peers.values()].map((peer) => {
      const best = peer.best ? peer.paths.get(peer.best) : undefined;
      return {
        nodeKey: peer.config.nodeKey,
        best: best?.endpoint,
        viaRelay: best?.viaRelay ?? false,
        rttMs: best?.rttMs,
        paths: [...peer.paths.values()],
        idle: !isActive(peer, now),
      };
    });
  }

  /** Replaces the STUN servers, which normally come from the netmap. */
  setStunServers(servers: Endpoint[]): void {
    this.stunServers = servers;
  }

  /** Attaches a relay, giving every peer a path that works without punching. */
  setRelay(relay: RelayClient | undefined): void {
    this.relay = relay;
    if (!relay) return;
    for (const peer of this.peers.values()) this.ensureRelayPath(peer);
    void this.probe();
  }

  /** Feeds a packet that arrived through the relay. */
  onRelayPacket(senderDiscoKey: string, payload: Uint8Array): void {
    const peer = [...this.peers.values()].find((p) => p.config.discoKey === senderDiscoKey);
    const path = peer && this.ensureRelayPath(peer);
    if (!peer || !path) return;

    if (looksLikeDisco(payload)) {
      this.onDiscoPacket(payload, peer, path);
      return;
    }
    peer.loopback.send(payload, this.options.wireguardPort, "127.0.0.1");
  }

  /** Applies the peer set from a netmap, keeping state for peers that stay. */
  async setPeers(configs: PeerConfig[]): Promise<void> {
    const wanted = new Set(configs.map((c) => c.nodeKey));
    for (const [nodeKey, peer] of this.peers) {
      if (wanted.has(nodeKey)) continue;
      peer.loopback.close();
      this.peers.delete(nodeKey);
      for (const [address, owner] of this.byAddress) if (owner === peer) this.byAddress.delete(address);
    }

    for (const config of configs) {
      const existing = this.peers.get(config.nodeKey);
      if (existing) {
        existing.config = config;
        this.forgetWithdrawn(existing, config.candidates);
        this.mergeCandidates(existing, config.candidates, false);
        this.ensureRelayPath(existing);
        continue;
      }

      const peer: Peer = {
        config,
        shared: sharedKey(this.options.discoPrivateKey, config.discoKey),
        loopback: await this.bindLoopback(config.nodeKey),
        paths: new Map(),
        probingSince: this.now(),
        joinedAt: this.now(),
      };
      this.peers.set(config.nodeKey, peer);
      this.mergeCandidates(peer, config.candidates, false);
      this.ensureRelayPath(peer);
      this.log(
        `peer ${config.nodeKey.slice(0, 8)}: ${config.candidates.length} candidate(s) ` +
          `[${config.candidates.map(key).join(", ") || "none"}]`,
      );
    }
    await this.probe();
  }

  /**
   * Probing before our own candidates have been published is actively harmful:
   * our packets arrive at the peer's NAT as an unsolicited inbound flow, which
   * creates a conntrack entry occupying exactly the tuple the peer needs for
   * its own outbound mapping. The peer is then translated to a different port
   * than the one STUN reported, and neither side can ever reach the other.
   */
  enableProbing(): void {
    if (this.probingEnabled) return;
    this.probingEnabled = true;
    void this.probe();
  }

  /**
   * Restarts aggressive probing, e.g. after the control server said to punch.
   * An idle peer only takes the candidates: the punch happens when something
   * is sent to it, and probing it now would wake it for nothing.
   */
  punchNow(nodeKey: string, candidates: Endpoint[] = []): void {
    const peer = this.peers.get(nodeKey);
    if (!peer || !this.probingEnabled) return;
    this.mergeCandidates(peer, candidates, false);
    peer.probingSince = this.now();
    void this.probePeer(peer);
  }

  private async bindLoopback(nodeKey: string): Promise<UdpSocket> {
    return Bun.udpSocket({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        // Anything WireGuard sends to this socket belongs to exactly one peer.
        data: (_socket, data) => this.onWireguardPacket(nodeKey, data),
        error: (_socket, error) => this.noteIgnored("loopback socket", error),
      },
    });
  }

  private mergeCandidates(peer: Peer, candidates: Endpoint[], learned: boolean): void {
    for (const endpoint of candidates) {
      const address = key(endpoint);
      if (!peer.paths.has(address)) {
        peer.paths.set(address, { key: address, endpoint, viaRelay: false, learned });
      }
      this.byAddress.set(address, peer);
    }
  }

  /**
   * Drops the paths a peer no longer announces, unless one is still answering.
   *
   * Merging alone only ever adds, so every address a peer had published since
   * this process started stayed a path -- and a path that never answers is due
   * for a probe on every tick. A live one is kept: the netmap may lag behind
   * the traffic, and dropping the path that carries it would be a stall for
   * nothing; it goes with the next netmap once it has stopped answering.
   * Learned paths are left alone, they come from authenticated traffic only.
   */
  private forgetWithdrawn(peer: Peer, announced: Endpoint[]): void {
    const wanted = new Set(announced.map(key));
    const now = this.now();
    for (const [address, path] of peer.paths) {
      if (path.viaRelay || path.learned || wanted.has(address)) continue;
      if (path.lastPongAt !== undefined && now - path.lastPongAt <= PATH_TIMEOUT_MS) continue;
      peer.paths.delete(address);
      if (peer.best === address) peer.best = undefined;
      if (this.byAddress.get(address) === peer) this.byAddress.delete(address);
    }
  }

  /** Peers only get a relay path once a relay is actually configured. */
  private ensureRelayPath(peer: Peer): PathState | undefined {
    if (!this.relay) return undefined;
    const existing = peer.paths.get(RELAY_PATH);
    if (existing) return existing;
    const path: PathState = { key: RELAY_PATH, viaRelay: true, learned: false };
    peer.paths.set(RELAY_PATH, path);
    return path;
  }

  // --- sending --------------------------------------------------------------

  private sendVia(peer: Peer, path: PathState, data: Uint8Array): boolean {
    if (path.viaRelay) return this.relay?.send(peer.config.discoKey, data) ?? false;
    const endpoint = path.endpoint;
    if (!endpoint) return false;

    // Sending to a candidate that is unreachable is routine -- a peer's LAN
    // address usually is. What is not obvious is that the resulting ICMP error
    // is delivered to the *next* send on this socket, which would otherwise
    // make one dead candidate swallow the probe of a good one. Retrying once
    // gets past the queued error.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const accepted = this.socket?.send(data, endpoint.port, endpoint.ip);
        if (accepted === false && this.options.verbose)
          this.log(`send to ${path.key} was refused (backpressure)`);
        return accepted !== false;
      } catch (error) {
        if (this.options.verbose) this.log(`send to ${path.key} threw: ${describeError(error)}`);
      }
    }
    return false;
  }

  private sendDisco(
    peer: Peer,
    path: PathState,
    message: Parameters<typeof encodeDisco>[0]["message"],
  ): void {
    this.sendVia(
      peer,
      path,
      encodeDisco({ senderDiscoKey: this.options.discoPublicKey, sharedKey: peer.shared, message }),
    );
  }

  // --- wire side ------------------------------------------------------------

  private onWirePacket(data: Uint8Array, from: Endpoint): void {
    if (looksLikeStun(data)) {
      const response = parseBindingResponse(data);
      const waiting = response && this.pendingStun.get(response.txid);
      if (response && waiting) {
        this.pendingStun.delete(response.txid);
        waiting(response.mapped);
      }
      return;
    }

    if (looksLikeDisco(data)) {
      const peer = this.peerForDisco(data);
      if (!peer) return;

      // A packet that decrypts proves the sender holds the peer's disco key, so
      // the address it came from is a usable path even if never announced.
      const address = key(from);
      let path = peer.paths.get(address);
      if (!path) {
        path = { key: address, endpoint: from, viaRelay: false, learned: true };
        peer.paths.set(address, path);
        this.log(`learned ${address} for ${peer.config.nodeKey.slice(0, 8)} from an inbound packet`);
      }
      this.byAddress.set(address, peer);
      this.onDiscoPacket(data, peer, path);
      return;
    }

    // Everything else is WireGuard traffic; it can only be attributed by the
    // address it came from, which is why discovery has to happen first.
    const peer = this.byAddress.get(key(from));
    if (!peer) {
      this.log(`dropped ${data.length}B from unknown ${key(from)}`);
      return;
    }
    peer.loopback.send(data, this.options.wireguardPort, "127.0.0.1");
  }

  private peerForDisco(data: Uint8Array): Peer | undefined {
    const decoded = decodeDisco(data, (senderDiscoKey) => {
      for (const peer of this.peers.values()) {
        if (peer.config.discoKey === senderDiscoKey) return peer.shared;
      }
      return null;
    });
    if (!decoded) return undefined;
    return [...this.peers.values()].find((p) => p.config.discoKey === decoded.senderDiscoKey);
  }

  private onDiscoPacket(data: Uint8Array, peer: Peer, path: PathState): void {
    const decoded = decodeDisco(data, () => peer.shared);
    if (!decoded) return;
    const message = decoded.message;

    if (message.type === "ping") {
      if (this.options.verbose) this.log(`ping <- ${path.key}`);
      this.sendDisco(peer, path, {
        type: "pong",
        txid: message.txid,
        observed: path.endpoint ?? { ip: "0.0.0.0", port: 0 },
      });
      return;
    }
    if (message.type === "pong") {
      const pending = this.inflight.get(txidToHex(message.txid));
      if (!pending || pending.peer !== peer) return;
      this.inflight.delete(txidToHex(message.txid));

      // Smoothed, not replaced: a single sample is far noisier than the
      // difference between two paths (see RTT_ALPHA).
      const sample = this.now() - pending.sentAt;
      pending.path.rttMs = smoothRtt(pending.path.rttMs, sample);
      pending.path.lastPongAt = this.now();
      this.selectBest(peer);
      // The peer tells us how it saw us; that is a candidate for our own list.
      if (message.observed.port !== 0) this.rememberReflexive(message.observed);
      return;
    }
    this.mergeCandidates(peer, message.endpoints, false);
  }

  private onWireguardPacket(nodeKey: string, data: Uint8Array): void {
    const peer = this.peers.get(nodeKey);
    if (!peer) return;

    // The first packet after a quiet spell wakes the peer: its paths are a
    // guess by now, so it gets the fast phase a new peer gets. The stale best
    // path is expired first, so this packet is sprayed -- relay included --
    // instead of going down a path that nobody has measured for a minute.
    const now = this.now();
    if (!isActive(peer, now)) {
      peer.probingSince = now;
      peer.wokeAt = now;
      peer.lastSendAt = now;
      void this.probePeer(peer);
    }
    peer.lastSendAt = now;

    const best = peer.best ? peer.paths.get(peer.best) : undefined;
    if (best) {
      this.sendVia(peer, best, data);
      return;
    }
    // No confirmed path yet: spray, so the handshake itself helps punch holes.
    let sent = 0;
    for (const path of peer.paths.values()) {
      if (sent++ >= MAX_SPRAY) break;
      this.sendVia(peer, path, data);
    }
  }

  // --- probing --------------------------------------------------------------

  private async probe(): Promise<void> {
    if (!this.probingEnabled) return;
    for (const peer of this.peers.values()) await this.probePeer(peer);
  }

  private async probePeer(peer: Peer): Promise<void> {
    // Waking a peer must not punch before our own candidates are published
    // (see enableProbing); it stays active and the next tick probes it.
    if (!this.probingEnabled) return;
    const now = this.now();
    // Left as it was, best path included: nothing is about to use it, and the
    // first packet that is wakes it up (onWireguardPacket).
    if (!isActive(peer, now)) return;
    const fast = now - peer.probingSince < PROBE_FAST_DURATION_MS;

    for (const path of peer.paths.values()) {
      if (!probeDue(path, now, fast)) continue;
      if (path.viaRelay && !this.relay?.connected) continue;
      path.lastPingAt = now;
      const txid = newTxid();
      this.inflight.set(txidToHex(txid), { peer, path, sentAt: now });
      this.sendDisco(peer, path, { type: "ping", txid });
      if (this.options.verbose) this.log(`ping -> ${path.key} (${peer.config.nodeKey.slice(0, 8)})`);
    }
    this.expire(peer, now);
    this.selectBest(peer);
  }

  private expire(peer: Peer, now: number): void {
    for (const path of peer.paths.values()) {
      if (path.lastPongAt && now - path.lastPongAt > PATH_TIMEOUT_MS) {
        path.rttMs = undefined;
        path.lastPongAt = undefined;
        if (peer.best === path.key) peer.best = undefined;
      }
    }
    for (const [txid, pending] of this.inflight) {
      if (now - pending.sentAt > PATH_TIMEOUT_MS) this.inflight.delete(txid);
    }
  }

  private selectBest(peer: Peer): void {
    const bestPath = choosePath(peer.paths.values(), peer.best, this.now());
    if (bestPath?.key !== peer.best) {
      peer.best = bestPath?.key;
      this.log(
        bestPath
          ? `path to ${peer.config.nodeKey.slice(0, 8)} is ${bestPath.key} (${(bestPath.rttMs ?? 0).toFixed(1)}ms)`
          : `no working path to ${peer.config.nodeKey.slice(0, 8)}`,
      );
    }
  }

  // --- local addresses ------------------------------------------------------

  private rememberReflexive(mapped: Mapped): void {
    const now = this.now();
    const known = this.reflexive.get(key(mapped));
    this.reflexive.set(key(mapped), {
      mapped,
      seenAt: now,
      rounds: (known?.rounds ?? 0) + 1,
    });
    // Pruned here as well, not only when read: the map would otherwise grow
    // by one entry a minute for as long as the process runs.
    for (const [address, entry] of this.reflexive) {
      if (now - entry.seenAt > REFLEXIVE_TTL_MS) this.reflexive.delete(address);
    }
  }

  /** Asks every configured STUN server how this socket looks from outside. */
  async discoverReflexive(
    timeoutMs = 2500,
  ): Promise<{ mapped: Mapped[]; mapping: ReturnType<typeof classifyMapping> }> {
    const results = await Promise.all(this.stunServers.map((server) => this.stunQuery(server, timeoutMs)));
    const mapped = results.filter((m): m is Mapped => m !== null);
    for (const entry of mapped) this.rememberReflexive(entry);
    return { mapped, mapping: classifyMapping(mapped) };
  }

  private stunQuery(server: Endpoint, timeoutMs: number): Promise<Mapped | null> {
    const { packet, txid } = buildBindingRequest();
    const send = () => {
      try {
        this.socket?.send(packet, server.port, server.ip);
      } catch {
        // A STUN server we cannot reach is not fatal.
      }
    };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingStun.delete(txid);
        resolve(null);
      }, timeoutMs);
      this.pendingStun.set(txid, (mapped) => {
        clearTimeout(timer);
        resolve(mapped);
      });
      send();
      // One retransmit: the first packet also has to open the NAT.
      setTimeout(() => this.pendingStun.has(txid) && send(), 400);
    });
  }

  reflexiveCandidates(): Mapped[] {
    return currentReflexive(this.reflexive.values(), this.now());
  }
}
