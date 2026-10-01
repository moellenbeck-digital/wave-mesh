import { createHash, createPrivateKey, createPublicKey, createSign, generateKeyPairSync } from "node:crypto";

/**
 * The signing half of ACME: ES256 over JWS, and nothing else.
 *
 * ACME allows several algorithms; a client only has to speak one, and P-256 is
 * the one every CA supports and the one the node keys already use. Written out
 * here rather than pulled in because it is forty lines and the alternative is a
 * JOSE library on the server for exactly two shapes of message.
 */

export type Jwk = { kty: "EC"; crv: "P-256"; x: string; y: string };

/** The account key. It identifies us to the CA and nothing else -- never a node. */
export function generateAccountKey(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return privateKey.export({ format: "pem", type: "pkcs8" }).toString();
}

export function publicJwk(privateKeyPem: string): Jwk {
  const jwk = createPublicKey(createPrivateKey(privateKeyPem)).export({ format: "jwk" }) as Record<
    string,
    string
  >;
  const { x, y } = jwk;
  if (!x || !y) throw new Error("account key is not an EC key");
  return { kty: "EC", crv: "P-256", x, y };
}

/**
 * RFC 7638 thumbprint: SHA-256 over the JWK with only the required members, in
 * lexicographic order and without a space anywhere. The dns-01 response is
 * built from it, so a stray space here is a challenge that never validates.
 */
export function thumbprint(jwk: Jwk): string {
  const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`;
  return createHash("sha256").update(canonical).digest("base64url");
}

export interface JwsInput {
  privateKeyPem: string;
  url: string;
  nonce: string;
  /** The account URL once there is one; before that the key goes in as a JWK. */
  kid?: string;
  /** `undefined` means POST-as-GET, whose payload is the empty string. */
  payload?: unknown;
}

/** A flattened JWS, which is the only encoding ACME uses. */
export function signJws(input: JwsInput): string {
  const header = {
    alg: "ES256",
    nonce: input.nonce,
    url: input.url,
    ...(input.kid ? { kid: input.kid } : { jwk: publicJwk(input.privateKeyPem) }),
  };
  const protectedHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
  const payload =
    input.payload === undefined ? "" : Buffer.from(JSON.stringify(input.payload)).toString("base64url");

  // JWS wants the two integers raw and concatenated; node's default is the DER
  // envelope, which a CA rejects as a malformed signature.
  const signature = createSign("sha256")
    .update(`${protectedHeader}.${payload}`)
    .sign({ key: createPrivateKey(input.privateKeyPem), dsaEncoding: "ieee-p1363" })
    .toString("base64url");

  return JSON.stringify({ protected: protectedHeader, payload, signature });
}
