import { afterEach, describe, expect, test } from "bun:test";
import {
  decodeQuery,
  encodeIpv6,
  encodeResponse,
  isWithinZone,
  normalizeName,
  RecordType,
  ResponseCode,
} from "./message.ts";
import {
  addressFromPtrName,
  type ResolverConfig,
  resolve,
  reverseZonesFor,
  startDnsServer,
} from "./resolver.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

/** Builds a wire-format query the way a resolver library would. */
function query(name: string, type: number = RecordType.A, id = 0x1234): Uint8Array {
  const labels = name.split(".").filter(Boolean);
  const body: number[] = [];
  for (const label of labels) {
    body.push(label.length, ...new TextEncoder().encode(label));
  }
  body.push(0);

  const packet = new Uint8Array(12 + body.length + 4);
  const view = new DataView(packet.buffer);
  view.setUint16(0, id);
  view.setUint16(2, 0x0100); // recursion desired
  view.setUint16(4, 1);
  packet.set(body, 12);
  view.setUint16(12 + body.length, type);
  view.setUint16(14 + body.length, 1);
  return packet;
}

const config: ResolverConfig = {
  zone: "rl.wave.example.com",
  records: [
    { name: "laptop.rl.wave.example.com", ipv4: "10.77.0.1", ipv6: "fd7a:1:2::1" },
    { name: "phone.rl.wave.example.com", ipv4: "10.77.0.2" },
  ],
  routes: [{ suffix: "corp.example.com", nameservers: ["10.77.0.9"] }],
  reverse: reverseZonesFor(["10.77.0.1/32", "fd7a:1:2::1/128"]),
};

const answered = (resolution: ReturnType<typeof resolve>) => {
  if (resolution.kind !== "answer") throw new Error(`expected an answer, got ${resolution.kind}`);
  return resolution.packet;
};

/** Reads back what we produced, which is what a client would do. */
function readAnswers(packet: Uint8Array): {
  code: number;
  records: Array<{ type: number; data: Uint8Array }>;
} {
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const code = view.getUint16(2) & 0xf;
  const count = view.getUint16(6);

  let offset = 12;
  const skipName = () => {
    while (packet[offset] !== 0) offset += (packet[offset] ?? 0) + 1;
    offset++;
  };
  skipName();
  offset += 4;

  const records: Array<{ type: number; data: Uint8Array }> = [];
  for (let i = 0; i < count; i++) {
    skipName();
    const type = view.getUint16(offset);
    const length = view.getUint16(offset + 8);
    records.push({ type, data: packet.subarray(offset + 10, offset + 10 + length) });
    offset += 10 + length;
  }
  return { code, records };
}

describe("names", () => {
  test("compare without regard to case or a trailing dot", () => {
    expect(normalizeName("Laptop.Example.COM.")).toBe("laptop.example.com");
    expect(isWithinZone("laptop.rl.wave.example.com", "rl.wave.example.com")).toBe(true);
    expect(isWithinZone("RL.Wave.Example.com.", "rl.wave.example.com")).toBe(true);
  });

  test("a zone does not contain a name that merely ends similarly", () => {
    expect(isWithinZone("evil-rl.wave.example.com", "rl.wave.example.com")).toBe(false);
  });
});

describe("query parsing", () => {
  test("reads the question", () => {
    const parsed = decodeQuery(query("laptop.rl.wave.example.com", RecordType.AAAA, 0xbeef));
    expect(parsed?.id).toBe(0xbeef);
    expect(parsed?.question.name).toBe("laptop.rl.wave.example.com");
    expect(parsed?.question.type).toBe(RecordType.AAAA);
    expect(parsed?.recursionDesired).toBe(true);
  });

  test("rejects a truncated packet instead of throwing", () => {
    expect(decodeQuery(new Uint8Array(4))).toBeNull();
    expect(decodeQuery(query("a.b").subarray(0, 14))).toBeNull();
  });

  test("rejects a response, which is not ours to answer", () => {
    const packet = query("laptop.rl.wave.example.com");
    new DataView(packet.buffer).setUint16(2, 0x8180);
    expect(decodeQuery(packet)).toBeNull();
  });
});

describe("resolving", () => {
  test("answers an A record from the wave", () => {
    const { code, records } = readAnswers(answered(resolve(query("laptop.rl.wave.example.com"), config)));
    expect(code).toBe(ResponseCode.NoError);
    expect(records).toHaveLength(1);
    expect([...(records[0]?.data ?? [])]).toEqual([10, 77, 0, 1]);
  });

  test("answers AAAA", () => {
    const packet = answered(resolve(query("laptop.rl.wave.example.com", RecordType.AAAA), config));
    const { records } = readAnswers(packet);
    expect(records[0]?.type).toBe(RecordType.AAAA);
    expect([...(records[0]?.data ?? [])]).toEqual([...encodeIpv6("fd7a:1:2::1")]);
  });

  test("is case-insensitive", () => {
    const { records } = readAnswers(answered(resolve(query("LAPTOP.RL.Wave.Example.com"), config)));
    expect(records).toHaveLength(1);
  });

  test("says the name does not exist when it really does not", () => {
    const { code } = readAnswers(answered(resolve(query("nothere.rl.wave.example.com"), config)));
    expect(code).toBe(ResponseCode.NameError);
  });

  test("a known name without the asked-for type answers empty, not NXDOMAIN", () => {
    // Saying the name does not exist would be a lie the client caches.
    const { code, records } = readAnswers(
      answered(resolve(query("phone.rl.wave.example.com", RecordType.AAAA), config)),
    );
    expect(code).toBe(ResponseCode.NoError);
    expect(records).toHaveLength(0);
  });

  test("forwards a delegated suffix", () => {
    expect(resolve(query("db.corp.example.com"), config)).toEqual({
      kind: "forward",
      nameservers: ["10.77.0.9"],
    });
  });

  test("ignores everything outside its business", () => {
    // With split DNS these never arrive; answering them anyway would make the
    // resolver an open forwarder.
    expect(resolve(query("www.google.com"), config).kind).toBe("drop");
  });

  test("ignores a packet that is not a query at all", () => {
    expect(resolve(new Uint8Array([1, 2, 3]), config).kind).toBe("drop");
  });
});

describe("server", () => {
  const ask = async (server: { address: string; port: number }, packet: Uint8Array, timeoutMs = 2000) => {
    const reply = Promise.withResolvers<Uint8Array | null>();
    const socket = await Bun.udpSocket({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data: (_s, data) => reply.resolve(new Uint8Array(data)) },
    });
    cleanup.push(() => socket.close());
    const timer = setTimeout(() => reply.resolve(null), timeoutMs);
    socket.send(packet, server.port, server.address);
    const answer = await reply.promise;
    clearTimeout(timer);
    return answer;
  };

  test("answers over the wire", async () => {
    const server = await startDnsServer({ address: "127.0.0.1", port: 0, config });
    cleanup.push(() => server.close());

    const answer = await ask(server, query("laptop.rl.wave.example.com"));
    expect(answer).not.toBeNull();
    expect(readAnswers(answer as Uint8Array).records).toHaveLength(1);
    expect(server.queries()).toBe(1);
  });

  test("picks up a changed netmap without restarting", async () => {
    const server = await startDnsServer({ address: "127.0.0.1", port: 0, config });
    cleanup.push(() => server.close());
    expect(readAnswers((await ask(server, query("new.rl.wave.example.com"))) as Uint8Array).code).toBe(
      ResponseCode.NameError,
    );

    server.update({
      ...config,
      records: [...config.records, { name: "new.rl.wave.example.com", ipv4: "10.77.0.3" }],
    });
    const answer = await ask(server, query("new.rl.wave.example.com"));
    expect([...(readAnswers(answer as Uint8Array).records[0]?.data ?? [])]).toEqual([10, 77, 0, 3]);
  });

  test("hands a delegated suffix to the upstream nameserver", async () => {
    const asked: string[] = [];
    const server = await startDnsServer({
      address: "127.0.0.1",
      port: 0,
      config,
      forward: async (packet, nameserver) => {
        asked.push(nameserver);
        return encodeResponse({
          query: decodeQuery(packet) as NonNullable<ReturnType<typeof decodeQuery>>,
          answers: [{ name: "db.corp.example.com", type: RecordType.A, ttl: 30, address: "10.9.9.9" }],
        });
      },
    });
    cleanup.push(() => server.close());

    const answer = await ask(server, query("db.corp.example.com"));
    expect(asked).toEqual(["10.77.0.9"]);
    expect([...(readAnswers(answer as Uint8Array).records[0]?.data ?? [])]).toEqual([10, 9, 9, 9]);
  });

  test("stays silent for a name it does not serve", async () => {
    const server = await startDnsServer({ address: "127.0.0.1", port: 0, config });
    cleanup.push(() => server.close());
    expect(await ask(server, query("www.google.com"), 400)).toBeNull();
  });
});

/** Reads the name out of a PTR answer, the way a client would. */
function readPtrTarget(packet: Uint8Array): string {
  const { records } = readAnswers(packet);
  const data = records[0]?.data as Uint8Array;
  const labels: string[] = [];
  let offset = 0;
  while (offset < data.length && data[offset] !== 0) {
    const length = data[offset] as number;
    labels.push(new TextDecoder().decode(data.subarray(offset + 1, offset + 1 + length)));
    offset += length + 1;
  }
  return labels.join(".");
}

describe("names for addresses", () => {
  test("answers what an IPv4 address is called", () => {
    const packet = answered(resolve(query("1.0.77.10.in-addr.arpa", RecordType.PTR), config));
    expect(readPtrTarget(packet)).toBe("laptop.rl.wave.example.com");
  });

  test("answers for IPv6 too, however the address is spelled", () => {
    // The record says fd7a:1:2::1; the question spells out all 32 nibbles.
    const name = `${[...Array(19).fill("0"), "2", ...Array(3).fill("0"), "1", ...Array(3).fill("0"), "a", "7", "d", "f"].join(".")}`;
    const packet = answered(resolve(query(`1.${name}.ip6.arpa`, RecordType.PTR), config));
    expect(readPtrTarget(packet)).toBe("laptop.rl.wave.example.com");
  });

  test("an address in our range that nobody holds is NXDOMAIN, not silence", () => {
    // Dropping it leaves whatever asked -- ping, ssh, traceroute -- waiting on
    // a resolver that will never answer.
    const packet = answered(resolve(query("99.0.77.10.in-addr.arpa", RecordType.PTR), config));
    expect(readAnswers(packet).code).toBe(ResponseCode.NameError);
  });

  test("an address outside our range is not ours to answer", () => {
    expect(resolve(query("1.1.168.192.in-addr.arpa", RecordType.PTR), config).kind).toBe("drop");
  });
});

describe("which reverse zones a wave covers", () => {
  test("a /16 of IPv4 and a /48 of IPv6, as the address plan hands them out", () => {
    expect(reverseZonesFor(["10.77.0.1/32"])).toEqual(["77.10.in-addr.arpa"]);
    expect(reverseZonesFor(["fd7a:8b47:c285::1/128"])).toEqual(["5.8.2.c.7.4.b.8.a.7.d.f.ip6.arpa"]);
  });

  test("reads an address back out of a question", () => {
    expect([...(addressFromPtrName("2.0.77.10.in-addr.arpa") ?? [])]).toEqual([10, 77, 0, 2]);
    expect(addressFromPtrName("laptop.rl.wave.example.com")).toBeNull();
    expect(addressFromPtrName("10.in-addr.arpa")).toBeNull();
  });
});
