import {
  canonicalJson,
  generateCertificateKey,
  generateKeyPair,
  selfSignedCertificate,
  sign,
  toPem,
} from "@wave/crypto";

/**
 * A control server that issues -- enough of one to see what a node does with
 * the answer. Shared by the certificate tests and the daemon's renewal test,
 * because both need the same thing: something that says yes.
 */
const DAY = 24 * 60 * 60 * 1000;

export interface FakeControl {
  url: string;
  stop: () => void;
  /** The names each order asked for, in order. */
  ordered: string[][];
  /** Set to make the next order fail the way a refused one does. */
  failWith?: string;
  /**
   * Set to answer "waiting" with this record, the way a wave that writes its
   * zone by hand does. Clearing it is what standing up and creating the record
   * looks like from here.
   */
  waitingFor?: { name: string; value: string };
}

/** It signs only the netmap: what is being tested here is always the node. */
export function fakeControl(
  options: { netmapKey?: ReturnType<typeof generateKeyPair>; dnsName?: string } = {},
) {
  const ordered: string[][] = [];
  const orders = new Map<string, string[]>();
  const issuer = { privateKeyPem: "" };
  const control: Partial<FakeControl> = { ordered };

  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/v1/cert/order" && request.method === "POST") {
        const body = (await request.json()) as { names: string[] };
        ordered.push(body.names);
        if (control.failWith) return Response.json({ error: control.failWith }, { status: 403 });
        const id = `cert_${orders.size + 1}`;
        orders.set(id, body.names);
        return Response.json({ orderId: id }, { status: 202 });
      }
      if (url.pathname.startsWith("/v1/cert/order/")) {
        const names = orders.get(url.pathname.slice("/v1/cert/order/".length));
        if (!names) return Response.json({ error: "unknown order" }, { status: 404 });
        if (control.waitingFor) {
          return Response.json({ status: "waiting", records: [control.waitingFor] });
        }
        const key = generateCertificateKey();
        issuer.privateKeyPem = key.privateKeyPem;
        const notAfter = new Date(Date.now() + 90 * DAY);
        const chainPem = toPem(
          "CERTIFICATE",
          selfSignedCertificate({
            privateKeyPem: key.privateKeyPem,
            names,
            notBefore: new Date(),
            notAfter,
          }),
        );
        return Response.json({
          status: "issued",
          chainPem,
          notAfter: notAfter.toISOString(),
          renewAt: new Date(Date.now() + 60 * DAY).toISOString(),
        });
      }
      if (url.pathname === "/v1/netmap" && options.netmapKey) {
        return Response.json(signedNetmap(options.netmapKey, options.dnsName));
      }
      return new Response("not found", { status: 404 });
    },
  });

  control.url = `http://127.0.0.1:${server.port}`;
  control.stop = () => server.stop(true);
  return control as FakeControl;
}

/**
 * A netmap for one device, signed the way the control server signs it. Shared
 * with the enrolment tests, which need an answer that verifies.
 */
export function signedNetmap(netmapKey: ReturnType<typeof generateKeyPair>, dnsName?: string) {
  const netmap = {
    version: 1,
    waveId: "w_1",
    self: {
      id: "n_1",
      nodeKey: generateKeyPair("x25519").publicKey,
      discoKey: generateKeyPair("x25519").publicKey,
      hostname: "laptop",
      dnsName: dnsName ?? "laptop.wave.example.com",
      ipv4: "10.77.0.2",
      ipv6: "fd7a:1:2::2",
      allowedIps: ["10.77.0.2/32"],
      candidates: [],
      online: true,
      keyExpiresAt: null,
      addresses: ["10.77.0.2/32"],
    },
    peers: [],
    dns: { suffix: "wave.example.com", resolverAddress: "10.77.0.2", routes: [], upstream: [] },
    relays: [],
    issuedAt: new Date().toISOString(),
  };
  return {
    netmap,
    signature: sign(netmapKey.privateKey, canonicalJson(netmap)),
    keyId: netmapKey.publicKey,
  };
}
