import { describe, expect, test } from "bun:test";
import { generateKeyPair } from "@wave/crypto";
import { open, seal, sharedKey } from "./box.ts";
import {
  DISCO_MAGIC,
  type DiscoMessage,
  decodeDisco,
  encodeDisco,
  looksLikeDisco,
  newTxid,
} from "./packet.ts";

const alice = generateKeyPair("x25519");
const bob = generateKeyPair("x25519");
const mallory = generateKeyPair("x25519");

const aliceToBob = sharedKey(alice.privateKey, bob.publicKey);
const bobToAlice = sharedKey(bob.privateKey, alice.publicKey);

describe("box", () => {
  test("both sides derive the same key", () => {
    expect(Buffer.from(aliceToBob)).toEqual(Buffer.from(bobToAlice));
  });

  test("a third party derives a different key", () => {
    expect(Buffer.from(sharedKey(mallory.privateKey, bob.publicKey))).not.toEqual(Buffer.from(aliceToBob));
  });

  test("round-trips a message", () => {
    const { nonce, ciphertext } = seal(aliceToBob, new TextEncoder().encode("hello"));
    expect(open(bobToAlice, nonce, ciphertext)).toEqual(new TextEncoder().encode("hello"));
  });

  test("rejects a tampered ciphertext instead of throwing", () => {
    const { nonce, ciphertext } = seal(aliceToBob, new Uint8Array([1, 2, 3]));
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 0xff;
    expect(open(bobToAlice, nonce, ciphertext)).toBeNull();
  });

  test("uses a fresh nonce for every message", () => {
    const a = seal(aliceToBob, new Uint8Array([1]));
    const b = seal(aliceToBob, new Uint8Array([1]));
    expect(Buffer.from(a.nonce)).not.toEqual(Buffer.from(b.nonce));
  });
});

const roundTrip = (message: DiscoMessage): DiscoMessage | null => {
  const packet = encodeDisco({ senderDiscoKey: alice.publicKey, sharedKey: aliceToBob, message });
  return decodeDisco(packet, (sender) => (sender === alice.publicKey ? bobToAlice : null))?.message ?? null;
};

describe("packet", () => {
  test("never collides with a WireGuard packet", () => {
    for (const type of [1, 2, 3, 4]) {
      expect(looksLikeDisco(new Uint8Array([type, ...new Array(80).fill(0)]))).toBe(false);
    }
    expect(DISCO_MAGIC[0]).not.toBeLessThan(5);
  });

  test("round-trips a ping", () => {
    const txid = newTxid();
    expect(roundTrip({ type: "ping", txid })).toEqual({ type: "ping", txid });
  });

  test("round-trips a pong with the observed IPv4 address", () => {
    const txid = newTxid();
    const message: DiscoMessage = { type: "pong", txid, observed: { ip: "203.0.113.7", port: 41641 } };
    expect(roundTrip(message)).toEqual(message);
  });

  test("round-trips a pong with an observed IPv6 address", () => {
    const message: DiscoMessage = {
      type: "pong",
      txid: newTxid(),
      observed: { ip: "fd7a:1:2::2", port: 1234 },
    };
    expect(roundTrip(message)).toEqual(message);
  });

  test("round-trips a full IPv6 address without a compressed run", () => {
    const message: DiscoMessage = {
      type: "pong",
      txid: newTxid(),
      observed: { ip: "2001:db8:1:2:3:4:5:6", port: 1 },
    };
    expect(roundTrip(message)).toEqual(message);
  });

  test("round-trips a candidate list", () => {
    const message: DiscoMessage = {
      type: "call-me-maybe",
      endpoints: [
        { ip: "192.168.1.20", port: 41641 },
        { ip: "203.0.113.7", port: 5000 },
      ],
    };
    expect(roundTrip(message)).toEqual(message);
  });

  test("reveals only the sender's public key in the clear", () => {
    const packet = encodeDisco({
      senderDiscoKey: alice.publicKey,
      sharedKey: aliceToBob,
      message: { type: "pong", txid: newTxid(), observed: { ip: "203.0.113.7", port: 41641 } },
    });
    // The observed address must not be readable without the key.
    expect(Buffer.from(packet).includes(Buffer.from([203, 0, 113, 7]))).toBe(false);
    expect(Buffer.from(packet.subarray(7, 39)).toString("base64")).toBe(alice.publicKey);
  });

  test("drops a packet from an unknown sender", () => {
    const packet = encodeDisco({
      senderDiscoKey: alice.publicKey,
      sharedKey: aliceToBob,
      message: { type: "ping", txid: newTxid() },
    });
    expect(decodeDisco(packet, () => null)).toBeNull();
  });

  test("drops a packet forged by someone else", () => {
    const forged = encodeDisco({
      senderDiscoKey: alice.publicKey, // claims to be alice
      sharedKey: sharedKey(mallory.privateKey, bob.publicKey), // but sealed by mallory
      message: { type: "ping", txid: newTxid() },
    });
    expect(decodeDisco(forged, () => bobToAlice)).toBeNull();
  });

  test("drops a truncated packet", () => {
    const packet = encodeDisco({
      senderDiscoKey: alice.publicKey,
      sharedKey: aliceToBob,
      message: { type: "ping", txid: newTxid() },
    });
    expect(decodeDisco(packet.subarray(0, 20), () => bobToAlice)).toBeNull();
  });

  test("drops a packet with an unknown version", () => {
    const packet = encodeDisco({
      senderDiscoKey: alice.publicKey,
      sharedKey: aliceToBob,
      message: { type: "ping", txid: newTxid() },
    });
    packet[DISCO_MAGIC.length] = 99;
    expect(decodeDisco(packet, () => bobToAlice)).toBeNull();
  });
});
