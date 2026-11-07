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
  /**
   * The private key of the certificate issued last. A real CA certifies the
   * key in the request; this one makes its own, so a test that needs the two
   * to match (a TLS handshake) writes this one next to the chain.
   */
  issuedKey?: string;
  /** The names put out through the pier, label to port: what `GET /v1/piers` lists. */
  piers: Map<string, number>;
  /** The operator's lock: while false, `POST /v1/piers` answers 403 like the server does. */
  pierAllowed: boolean;
  /** Every pier request, as `METHOD /path`, so a test can see that none was made. */
  pierCalls: string[];
}

/** It signs only the netmap: what is being tested here is always the node. */
export function fakeControl(
  options: { netmapKey?: ReturnType<typeof generateKeyPair>; dnsName?: string } = {},
) {
  const ordered: string[][] = [];
  const orders = new Map<string, string[]>();
  const issuer = { privateKeyPem: "" };
  const control: Partial<FakeControl> = { ordered, piers: new Map(), pierAllowed: true, pierCalls: [] };

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
        control.issuedKey = key.privateKeyPem;
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
      if (url.pathname.startsWith("/v1/piers")) {
        control.pierCalls?.push(`${request.method} ${url.pathname}`);
        const piers = control.piers as Map<string, number>;
        const dnsName = (label: string) => `${label}.pier.wave.example.com`;
        if (request.method === "GET") {
          return Response.json({
            allowed: control.pierAllowed,
            zone: "pier.wave.example.com",
            pier: { publicIpv4: "203.0.113.10", publicIpv6: null },
            piers: [...piers].map(([name, port]) => ({ name, dnsName: dnsName(name), port })),
          });
        }
        if (request.method === "POST") {
          if (!control.pierAllowed) {
            return Response.json(
              {
                error: "the pier is not allowed for laptop; an operator grants it with `admin.ts allow-pier`",
              },
              { status: 403 },
            );
          }
          const body = (await request.json()) as { name: string; port: number };
          const label = body.name.replace(/\.pier\.wave\.example\.com$/, "");
          piers.set(label, body.port);
          return Response.json({ name: label, dnsName: dnsName(label), port: body.port });
        }
        if (request.method === "DELETE") {
          const label = decodeURIComponent(url.pathname.slice("/v1/piers/".length));
          const port = piers.get(label);
          if (port === undefined) {
            return Response.json({ error: "this device has not put that name out" }, { status: 404 });
          }
          piers.delete(label);
          return Response.json({ name: label, dnsName: dnsName(label), port });
        }
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
