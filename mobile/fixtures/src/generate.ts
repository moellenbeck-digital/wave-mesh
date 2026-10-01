/**
 * Writes the fixtures the Go core is checked against.
 *
 * The contract between the two implementations is bytes, not prose: a canonical
 * encoding that differs in one character is a signature that does not verify,
 * and on a phone that reads as "netmap signature does not verify" -- like an
 * attack, when it is a spelling mistake. So the expectations come from the
 * TypeScript side that is already in production, and the Go tests read them.
 *
 *   cd mobile/fixtures && bun run generate
 *
 * Two fields cannot be constants and are not meant to be: a sealed disco packet
 * carries a random nonce, and a STUN request a random transaction id. So a
 * regeneration changes those lines and nothing else -- and the release workflow
 * regenerates rather than comparing, which is the stronger check anyway: it
 * proves the code that runs today agrees, not that a file somebody committed
 * once still matches itself.
 */
import { canonicalJson, publicKeyFromPrivate, sign, signatureMessage } from "@wave/crypto";
import { encodeDisco, sharedKey } from "@wave/disco";
import { encodeResponse, RecordType } from "@wave/dns";
import { buildBindingRequest, buildBindingResponse, encodeFrame } from "@wave/magicsock";

// Fixed keys, so the signatures and the derived public keys below are the same
// bytes on every run. A fixture that changed everywhere on every regeneration
// would say nothing when one of them broke.
//
// They are keys and nothing else: they belong to no wave, no server and no
// device, and the private halves are here on purpose so the Go side can derive
// the same shared secret from the other end of the pair.
const machine = {
  publicKey: "3GFmNQ908SQrKQK1LhFsyZ4DjCmxKMCl4jgn4RjQ+sg=",
  privateKey: "gczd+qPpT6qLBLJNvo0U0lCfRIenudOQVj7RaID8P7o=",
};
const discoA = {
  publicKey: "n54eG6QS4dtWhX8q2H8wBBSo/ANq7Vz2zlDeqh5F1BU=",
  privateKey: "jyDiRuYcvKWqF73L9I8kp/IAUjEs/F4Q7as7CuSIxYI=",
};
const discoB = {
  publicKey: "L8mlGhbjSNFSXWU3EaIYIvEgn2Z8nIMipk/CCOlCc3A=",
  privateKey: "D6t6KTfZXP0/bNnRRTSmIB3XEIsSNOFBW1b6ZKaThIM=",
};

const netmap = {
  version: 7,
  waveId: "w_1",
  self: {
    id: "n_0",
    nodeKey: `${"A".repeat(43)}=`,
    discoKey: `${"B".repeat(43)}=`,
    hostname: "phone",
    dnsName: "phone.wave.example.com",
    ipv4: "10.77.0.1",
    ipv6: "fd7a:1::1",
    allowedIps: ["10.77.0.1/32", "fd7a:1::1/128"],
    addresses: ["10.77.0.1/32", "fd7a:1::1/128"],
    candidates: [{ kind: "stun", ip: "203.0.113.7", port: 41641 }],
    online: true,
    keyExpiresAt: null,
  },
  peers: [],
  dns: { suffix: "wave.example.com", resolverAddress: "100.100.100.100", routes: [], upstream: [] },
  relays: [{ id: "r_fsn", region: "fsn", url: "https://relay.example.com" }],
  issuedAt: "2026-09-22T12:00:00.000Z",
  // A field no schema knows: it must survive canonicalisation untouched, which
  // is the property the whole netmap signature rests on.
  futureField: { b: 2, a: [1, "x", null, true] },
};

// The control server's netmap signing key, likewise fixed: Ed25519 signs
// deterministically, so the signature in the fixture is a constant the Go side
// can be held to.
const signingKey = {
  publicKey: "Z1Fy4vUxPwYmhMbrhfnfb+iDgBpitwQ3l57QIc0MN9w=",
  privateKey: "5yB4G7J9TpEGZ9D8gHM94gKrCBEtK6T8gC2lArxTBEY=",
};
const canonical = canonicalJson(netmap);

const awkward = { s: 'quote " backslash \\ newline \n tab \t unit  accent é emoji \u{1f600}' };
const numbers = [1, -2, 1.5, 0, 1e21, 1e-7, null, true];

const dnsQuery = {
  id: 0x1234,
  recursionDesired: true,
  question: { name: "laptop.wave.example.com", type: RecordType.A, class: 1 },
};

const stunRequest = buildBindingRequest();
const stunMapped = { ip: "203.0.113.7", port: 41641 };

const sigMessage = signatureMessage({
  method: "POST",
  path: "/v1/machine/register",
  timestamp: 1_790_000_000,
  nonce: "Zm9vYmFyYmF6cXV4",
  bodyHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
});

console.log(
  JSON.stringify(
    {
      keys: { machine, discoA, discoB },
      canonical: [
        { value: netmap, encoded: canonical },
        { value: { b: 1, a: 2 }, encoded: canonicalJson({ b: 1, a: 2 }) },
        { value: awkward, encoded: canonicalJson(awkward) },
        { value: numbers, encoded: canonicalJson(numbers) },
        { value: {}, encoded: canonicalJson({}) },
      ],
      netmap: {
        signingPublicKey: signingKey.publicKey,
        signature: sign(signingKey.privateKey, canonical),
        document: netmap,
      },
      httpsig: {
        message: sigMessage,
        signature: sign(machine.privateKey, sigMessage),
      },
      disco: {
        // Both sides derive the same symmetric key from opposite halves.
        sharedKey: Buffer.from(sharedKey(discoA.privateKey, discoB.publicKey)).toString("base64"),
        // Sealed here, opened by the Go test: the nonce is random, so only the
        // decrypt direction can be pinned -- which is the one that matters.
        sealedPing: Buffer.from(
          encodeDisco({
            senderDiscoKey: discoA.publicKey,
            sharedKey: sharedKey(discoA.privateKey, discoB.publicKey),
            message: { type: "ping", txid: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) },
          }),
        ).toString("base64"),
        sealedCallMeMaybe: Buffer.from(
          encodeDisco({
            senderDiscoKey: discoA.publicKey,
            sharedKey: sharedKey(discoA.privateKey, discoB.publicKey),
            message: {
              type: "call-me-maybe",
              endpoints: [
                { ip: "203.0.113.7", port: 41641 },
                { ip: "fd7a:1::2", port: 1024 },
              ],
            },
          }),
        ).toString("base64"),
      },
      stun: {
        // Built by the STUN server this project runs, so the phone is parsing
        // the same bytes it will meet in production.
        request: Buffer.from(stunRequest.packet).toString("base64"),
        txid: stunRequest.txid,
        response: Buffer.from(buildBindingResponse(stunRequest.packet, stunMapped)).toString("base64"),
        mapped: stunMapped,
      },
      dns: {
        // The same question, answered by the resolver that already runs on the
        // desktop. A phone answers from its own TUN, but the bytes must match.
        query: dnsQuery,
        a: Buffer.from(
          encodeResponse({
            query: dnsQuery,
            answers: [{ name: dnsQuery.question.name, type: RecordType.A, ttl: 60, address: "10.77.0.2" }],
          }),
        ).toString("base64"),
        nxdomain: Buffer.from(encodeResponse({ query: dnsQuery, code: 3 })).toString("base64"),
        empty: Buffer.from(encodeResponse({ query: dnsQuery })).toString("base64"),
      },
      relay: {
        frame: Buffer.from(encodeFrame(discoB.publicKey, new Uint8Array([9, 8, 7]))).toString("base64"),
        toDiscoKey: discoB.publicKey,
      },
      derived: {
        discoAPublicFromPrivate: publicKeyFromPrivate(discoA.privateKey, "x25519"),
      },
    },
    null,
    2,
  ),
);
