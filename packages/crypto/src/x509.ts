import {
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  generateKeyPairSync,
} from "node:crypto";
import {
  allFromPem,
  bitString,
  boolean,
  context,
  encode,
  fromPem,
  integer,
  items,
  octetString,
  oid,
  oidString,
  read,
  sequence,
  set,
  Tag,
  toPem,
  utf8String,
} from "./der.ts";

/**
 * Keys and certificate signing requests for the ACME flow (D7).
 *
 * The split this file exists for: a node makes the key and the request, the
 * control server reads the request back to decide whether the names in it are
 * that node's to ask for. **No private key ever leaves a node**, so both sides
 * need to speak PKCS#10 -- one writing, one reading -- and they share it here.
 */

const OID = {
  ecPublicKey: "1.2.840.10045.2.1",
  prime256v1: "1.2.840.10045.3.1.7",
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  commonName: "2.5.4.3",
  extensionRequest: "1.2.840.113549.1.9.14",
  subjectAltName: "2.5.29.17",
  authorityKeyIdentifier: "2.5.29.35",
  basicConstraints: "2.5.29.19",
} as const;

/** dNSName inside a GeneralNames; primitive, because IA5String is not constructed. */
const DNS_NAME = context(2, false);

export interface CertificateKey {
  /** PKCS#8, what goes into key.pem next to the certificate. */
  privateKeyPem: string;
  /** SubjectPublicKeyInfo, ready to be dropped into a request. */
  publicKeyDer: Buffer;
}

/**
 * P-256 rather than RSA: every ACME CA accepts it, the key is a tenth of the
 * size and generating one is instant even on a small machine.
 */
export function generateCertificateKey(): CertificateKey {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKeyDer: publicKey.export({ format: "der", type: "spki" }),
  };
}

/** A CN longer than this is invalid, and a SAN-only request is perfectly fine. */
const MAX_COMMON_NAME = 64;

/**
 * A PKCS#10 request for the given names, signed with the node's own key.
 *
 * The names go into the subjectAltName extension, which is the only place a CA
 * looks. The common name is set as well when the first name fits into its 64
 * characters -- some software still reads it -- and left out entirely when it
 * does not, because a truncated CN would be a name nobody asked for.
 */
export function createCsr(input: { privateKeyPem: string; names: string[] }): Buffer {
  if (input.names.length === 0) throw new Error("a certificate request needs at least one name");

  const privateKey = createPrivateKey(input.privateKeyPem);
  const publicKeyDer = createPublicKey(privateKey).export({ format: "der", type: "spki" });

  const first = input.names[0] as string;
  const subject =
    first.length <= MAX_COMMON_NAME
      ? sequence(set(sequence(oid(OID.commonName), utf8String(first))))
      : sequence();

  const sanExtension = sequence(
    oid(OID.subjectAltName),
    octetString(sequence(...input.names.map((name) => encode(DNS_NAME, Buffer.from(name, "ascii"))))),
  );
  const attributes = encode(context(0), sequence(oid(OID.extensionRequest), set(sequence(sanExtension))));

  const info = sequence(integer(0), subject, publicKeyDer, attributes);
  const signature = createSign("sha256").update(info).sign(privateKey);
  return sequence(info, sequence(oid(OID.ecdsaWithSha256)), bitString(signature));
}

export interface ParsedCsr {
  /** The dNSNames from the subjectAltName extension, lowercased. */
  names: string[];
  /** SubjectPublicKeyInfo of the key the requester holds. */
  publicKeyDer: Buffer;
}

/**
 * Reads a request and checks it signed itself.
 *
 * The self-signature is what makes a CSR proof of possession: without it any
 * node could hand us a request built around someone else's public key. The CA
 * checks it too, but a request that cannot be trusted has no business reaching
 * the CA in our account's name.
 */
export function readCsr(der: Buffer): ParsedCsr {
  const [info, , signature] = items(read(der).content);
  if (!info || !signature) throw new Error("not a certificate request");

  const [, , publicKey, attributes] = items(info.content);
  if (!publicKey) throw new Error("certificate request without a public key");

  // The first byte of a BIT STRING counts the unused bits; for a signature it
  // is always zero and never part of the value.
  const verified = createVerify("sha256")
    .update(info.raw)
    .verify(
      createPublicKey({ key: publicKey.raw, format: "der", type: "spki" }),
      signature.content.subarray(1),
    );
  if (!verified) throw new Error("certificate request does not verify against its own key");

  return { names: sanNames(attributes ? extensionsOf(attributes) : []), publicKeyDer: publicKey.raw };
}

/** The extensions carried in a request's extensionRequest attribute, if any. */
function extensionsOf(attributes: { content: Buffer }): { content: Buffer }[] {
  for (const attribute of items(attributes.content)) {
    const [type, values] = items(attribute.content);
    if (!type || !values || oidString(type.content) !== OID.extensionRequest) continue;
    const list = items(values.content)[0];
    return list ? items(list.content) : [];
  }
  return [];
}

function sanNames(extensions: { content: Buffer }[]): string[] {
  for (const extension of extensions) {
    const parts = items(extension.content);
    const type = parts[0];
    // The value is the last element: `critical` sits between them when present.
    const value = parts[parts.length - 1];
    if (!type || !value || oidString(type.content) !== OID.subjectAltName) continue;
    return items(read(value.content).content)
      .filter((entry) => entry.tag === DNS_NAME)
      .map((entry) => entry.content.toString("ascii").toLowerCase());
  }
  return [];
}

export interface ParsedCertificate {
  /** The value octets of the serial number, as ARI wants them. */
  serial: Buffer;
  /** The issuer's key identifier from the AKI extension; ARI needs it too. */
  authorityKeyIdentifier: Buffer | null;
  notBefore: Date;
  notAfter: Date;
  names: string[];
}

/**
 * The few fields of an issued certificate this project cares about: when it
 * expires, and the two values that name it to the CA's renewal-info endpoint.
 */
export function readCertificate(der: Buffer): ParsedCertificate {
  const tbs = items(read(der).content)[0];
  if (!tbs) throw new Error("not a certificate");

  const fields = items(tbs.content);
  // An explicit [0] version comes first when present; without it the serial is.
  const versioned = fields[0]?.tag === context(0);
  const serial = fields[versioned ? 1 : 0];
  const validity = fields[versioned ? 4 : 3];
  if (!serial || !validity) throw new Error("certificate without a serial or validity");

  const [notBefore, notAfter] = items(validity.content);
  if (!notBefore || !notAfter) throw new Error("certificate without both validity bounds");

  const extensions = fields.find((field) => field.tag === context(3));
  const list = extensions ? items(items(extensions.content)[0]?.content ?? Buffer.alloc(0)) : [];

  return {
    serial: serial.content,
    authorityKeyIdentifier: keyIdentifier(list),
    notBefore: parseTime(notBefore),
    notAfter: parseTime(notAfter),
    names: sanNames(list),
  };
}

function keyIdentifier(extensions: { content: Buffer }[]): Buffer | null {
  for (const extension of extensions) {
    const parts = items(extension.content);
    const type = parts[0];
    const value = parts[parts.length - 1];
    if (!type || !value || oidString(type.content) !== OID.authorityKeyIdentifier) continue;
    // AuthorityKeyIdentifier ::= SEQUENCE { keyIdentifier [0] IMPLICIT OCTET STRING OPTIONAL, ... }
    const inner = items(read(value.content).content).find((entry) => entry.tag === context(0, false));
    return inner ? inner.content : null;
  }
  return null;
}

/**
 * UTCTime for anything before 2050, GeneralizedTime after -- that is the rule
 * X.509 states, and both appear in real chains.
 */
function parseTime(element: { tag: number; content: Buffer }): Date {
  const text = element.content.toString("ascii");
  const digits =
    element.tag === Tag.UTC_TIME ? `${Number(text.slice(0, 2)) < 50 ? "20" : "19"}${text}` : text;
  const [, year, month, day, hour, minute, second = "00"] =
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/.exec(digits) ?? [];
  if (!year || !month || !day || !hour || !minute) throw new Error(`unreadable certificate time: ${text}`);
  return new Date(Date.UTC(+year, +month - 1, +day, +hour, +minute, +second));
}

/** The leaf of a PEM chain, which is always the first certificate in it. */
export function leafOf(chainPem: string): ParsedCertificate {
  const [leaf] = allFromPem(chainPem);
  if (!leaf) throw new Error("no certificate in the chain");
  return readCertificate(leaf);
}

export { allFromPem, fromPem, toPem };

/**
 * Only used by the tests: a self-signed certificate, so the fake CA can hand
 * out something the client parses the same way it parses a real one.
 */
export function selfSignedCertificate(input: {
  privateKeyPem: string;
  names: string[];
  notBefore: Date;
  notAfter: Date;
  serial?: Buffer;
  keyIdentifier?: Buffer;
}): Buffer {
  const privateKey = createPrivateKey(input.privateKeyPem);
  const publicKeyDer = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const name = sequence(set(sequence(oid(OID.commonName), utf8String(input.names[0] ?? "wave"))));

  const extensions = encode(
    context(3),
    sequence(
      sequence(
        oid(OID.subjectAltName),
        octetString(sequence(...input.names.map((n) => encode(DNS_NAME, Buffer.from(n, "ascii"))))),
      ),
      sequence(
        oid(OID.authorityKeyIdentifier),
        octetString(sequence(encode(context(0, false), input.keyIdentifier ?? Buffer.alloc(20, 7)))),
      ),
      sequence(oid(OID.basicConstraints), boolean(true), octetString(sequence())),
    ),
  );

  const tbs = sequence(
    encode(context(0), integer(2)),
    integer(input.serial ?? Buffer.from([0x01, 0x02, 0x03, 0x04])),
    sequence(oid(OID.ecdsaWithSha256)),
    name,
    sequence(generalizedTime(input.notBefore), generalizedTime(input.notAfter)),
    name,
    publicKeyDer,
    extensions,
  );
  const signature = createSign("sha256").update(tbs).sign(privateKey);
  return sequence(tbs, sequence(oid(OID.ecdsaWithSha256)), bitString(signature));
}

const generalizedTime = (date: Date): Buffer =>
  encode(Tag.GENERALIZED_TIME, Buffer.from(date.toISOString().replace(/[-:T]|\.\d+/g, ""), "ascii"));
