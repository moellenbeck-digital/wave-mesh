import { describe, expect, test } from "bun:test";
import { items, oid, oidString, read, toPem } from "./der.ts";
import {
  createCsr,
  generateCertificateKey,
  leafOf,
  readCertificate,
  readCsr,
  selfSignedCertificate,
} from "./x509.ts";

describe("certificate signing requests", () => {
  test("carries every name it was asked for", () => {
    const key = generateCertificateKey();
    const names = ["laptop.wave.example.com", "grafana.wave.example.com"];
    expect(readCsr(createCsr({ privateKeyPem: key.privateKeyPem, names })).names).toEqual(names);
  });

  test("uppercase in a name comes back lowercased, as DNS has no case", () => {
    const key = generateCertificateKey();
    const csr = createCsr({ privateKeyPem: key.privateKeyPem, names: ["Laptop.Wave.Example.com"] });
    expect(readCsr(csr).names).toEqual(["laptop.wave.example.com"]);
  });

  test("the request carries the public key of the key that signed it", () => {
    const key = generateCertificateKey();
    const csr = createCsr({ privateKeyPem: key.privateKeyPem, names: ["a.wave.example.com"] });
    expect(readCsr(csr).publicKeyDer.equals(key.publicKeyDer)).toBe(true);
  });

  // Proof of possession is the whole point: without the self-signature a node
  // could hand us a request built around somebody else's key.
  test("a tampered request does not verify", () => {
    const key = generateCertificateKey();
    const csr = createCsr({ privateKeyPem: key.privateKeyPem, names: ["laptop.wave.example.com"] });
    const index = csr.indexOf(Buffer.from("laptop", "ascii"));
    expect(index).toBeGreaterThan(0);
    // Same length, so every offset in the structure stays where it was.
    csr.write("laptoq", index, "ascii");
    expect(() => readCsr(csr)).toThrow(/does not verify/);
  });

  test("a name too long for a common name still gets a request", () => {
    const key = generateCertificateKey();
    const long = `${"a".repeat(60)}.wave.example.com`;
    const csr = createCsr({ privateKeyPem: key.privateKeyPem, names: [long] });
    expect(readCsr(csr).names).toEqual([long]);
    // The subject is left empty rather than carrying a truncated name.
    const [info] = items(read(csr).content);
    const subject = items(info?.content ?? Buffer.alloc(0))[1];
    expect(subject?.content.length).toBe(0);
  });

  test("a request without names is refused before it is built", () => {
    const key = generateCertificateKey();
    expect(() => createCsr({ privateKeyPem: key.privateKeyPem, names: [] })).toThrow();
  });
});

describe("certificates", () => {
  const notBefore = new Date("2026-09-01T00:00:00Z");
  const notAfter = new Date("2026-11-30T00:00:00Z");

  test("reads back validity, names, serial and key identifier", () => {
    const key = generateCertificateKey();
    const der = selfSignedCertificate({
      privateKeyPem: key.privateKeyPem,
      names: ["laptop.wave.example.com"],
      notBefore,
      notAfter,
      serial: Buffer.from([0x2a, 0x2b]),
      keyIdentifier: Buffer.alloc(20, 0x11),
    });

    const parsed = readCertificate(der);
    expect(parsed.names).toEqual(["laptop.wave.example.com"]);
    expect(parsed.notBefore).toEqual(notBefore);
    expect(parsed.notAfter).toEqual(notAfter);
    expect(parsed.serial.toString("hex")).toBe("2a2b");
    expect(parsed.authorityKeyIdentifier?.toString("hex")).toBe("11".repeat(20));
  });

  test("the leaf of a chain is its first certificate", () => {
    const key = generateCertificateKey();
    const leaf = selfSignedCertificate({
      privateKeyPem: key.privateKeyPem,
      names: ["laptop.wave.example.com"],
      notBefore,
      notAfter,
    });
    const issuer = selfSignedCertificate({
      privateKeyPem: generateCertificateKey().privateKeyPem,
      names: ["ca.example"],
      notBefore,
      notAfter,
    });
    const chain = toPem("CERTIFICATE", leaf) + toPem("CERTIFICATE", issuer);
    expect(leafOf(chain).names).toEqual(["laptop.wave.example.com"]);
  });
});

describe("DER primitives", () => {
  test("object identifiers survive a round trip", () => {
    for (const dotted of ["1.2.840.113549.1.9.14", "2.5.29.17", "1.3.6.1.5.5.7.1.1"]) {
      expect(oidString(read(oid(dotted)).content)).toBe(dotted);
    }
  });
});
