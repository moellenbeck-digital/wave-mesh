import { startRelayServer } from "./relay-server.ts";
import { startStunServer } from "./stun-server.ts";

/**
 * One process, two jobs: tell nodes how they look from outside (STUN, UDP) and
 * forward packets for those that cannot reach each other directly (relay, WS).
 * Both are pure infrastructure -- neither can read what it carries.
 */
const stunPort = Number(process.env.WAVE_STUN_PORT ?? 3478);
const relayPort = Number(process.env.WAVE_RELAY_PORT ?? 3479);
const hostname = process.env.WAVE_RELAY_HOST ?? "0.0.0.0";

const stun = await startStunServer({ port: stunPort, hostname, log: console.log });
const relay = await startRelayServer({ port: relayPort, hostname, log: console.log });

console.log(`relay ${relay.publicKey} ready (stun ${stun.port}/udp, relay ${relay.port}/tcp)`);
