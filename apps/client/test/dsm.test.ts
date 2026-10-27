import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DsmPaths, detectDsm, installInDsm, pemCertificates } from "../src/dsm.ts";

/**
 * DSM's certificate store, laid out in a scratch directory the way a
 * DiskStation does it: an `_archive` with its INFO and DEFAULT, one directory
 * per service that has a certificate assigned, and a reload script per
 * subscriber.
 */

const LEAF = "-----BEGIN CERTIFICATE-----\nbGVhZg==\n-----END CERTIFICATE-----";
const ISSUER = "-----BEGIN CERTIFICATE-----\naXNzdWVy\n-----END CERTIFICATE-----";
const ROOT = "-----BEGIN CERTIFICATE-----\ncm9vdA==\n-----END CERTIFICATE-----";
const CHAIN = `${LEAF}\n${ISSUER}\n${ROOT}\n`;
const KEY = "-----BEGIN PRIVATE KEY-----\na2V5\n-----END PRIVATE KEY-----\n";

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Store {
  paths: DsmPaths;
  archive: string;
  info: string;
  commands: string[][];
  log: string[];
  options: {
    paths: DsmPaths;
    run: (command: string[]) => Promise<{ code: number; output: string }>;
    log: (m: string) => void;
  };
}

/** A DSM with the default certificate in `_archive/own123` and nothing of ours yet. */
function store(
  info: Record<string, unknown> = { own123: { desc: "", services: [] } },
  fail: (command: string[]) => number = () => 0,
): Store {
  const root = mkdtempSync(join(tmpdir(), "wave-dsm-"));
  cleanup.push(root);
  const paths: DsmPaths = {
    versionFile: join(root, "etc.defaults/VERSION"),
    certRoot: join(root, "usr/syno/etc/certificate"),
    serviceRoots: [join(root, "usr/local/etc/certificate"), join(root, "usr/syno/etc/certificate")],
    subscriberDirs: [join(root, "usr/libexec/certificate.d"), join(root, "usr/local/libexec/certificate.d")],
    profileDir: join(root, "usr/libexec/security-profile/tls-profile"),
    synosystemctl: join(root, "usr/syno/bin/synosystemctl"),
  };
  const archive = join(paths.certRoot, "_archive");
  mkdirSync(archive, { recursive: true });
  writeFileSync(join(archive, "INFO"), `${JSON.stringify(info, null, 2)}\n`);
  writeFileSync(join(archive, "DEFAULT"), "own123");
  const commands: string[][] = [];
  const log: string[] = [];
  return {
    paths,
    archive,
    info: join(archive, "INFO"),
    commands,
    log,
    options: {
      paths,
      run: async (command) => {
        commands.push(command);
        const code = fail(command);
        return { code, output: code === 0 ? "" : "it did not work" };
      },
      log: (message) => log.push(message),
    },
  };
}

/** A service directory with an old certificate in it, and optionally a script that reloads it. */
function service(root: string, subscriber: string, name: string): string {
  const dir = join(root, subscriber, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cert.pem"), "old");
  return dir;
}

function script(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
  return path;
}

const entry = (subscriber: string, name: string) => ({
  display_name: `${subscriber} ${name}`,
  isPkg: false,
  owner: "root",
  service: name,
  subscriber,
});

const read = (path: string): string => readFileSync(path, "utf8");
const infoOf = (s: Store): Record<string, { desc: string; services: unknown[] }> => JSON.parse(read(s.info));

describe("telling a DSM from any other linux", () => {
  const paths = store().paths;

  test("by the version file, which every DSM has", () => {
    const text = 'majorversion="7"\nminorversion="2"\nproductversion="7.2.1"\nos_name="DSM"\n';
    expect(detectDsm(paths, () => text)).toEqual({ version: "7.2.1" });
  });

  test("not by the platform, nor by the file merely being there", () => {
    expect(detectDsm(paths, () => 'NAME="Ubuntu"\nVERSION_ID="24.04"\n')).toBeNull();
    expect(detectDsm(paths, () => 'os_name="SRM"\nproductversion="1.3"\n')).toBeNull();
    expect(
      detectDsm(paths, () => {
        throw new Error("ENOENT");
      }),
    ).toBeNull();
  });
});

describe("pulling a chain apart", () => {
  test("keeps the certificates in order and ignores the rest", () => {
    expect(pemCertificates(`junk\n${CHAIN}\n${KEY}`)).toEqual([LEAF, ISSUER, ROOT]);
    expect(pemCertificates("nothing here")).toEqual([]);
  });
});

describe("a certificate that is not in the store yet", () => {
  test("gets a directory of its own with the four files DSM keeps", async () => {
    const s = store();
    const result = await installInDsm(
      { description: "wave: nas.wave.example", keyPem: KEY, chainPem: CHAIN },
      s.options,
    );

    expect(result.created).toBe(true);
    expect(result.id).toMatch(/^[A-Za-z0-9]{6}$/);
    expect(result.id).not.toBe("own123");
    const dir = join(s.archive, result.id);
    expect(read(join(dir, "cert.pem"))).toBe(`${LEAF}\n`);
    expect(read(join(dir, "chain.pem"))).toBe(`${ISSUER}\n${ROOT}\n`);
    expect(read(join(dir, "fullchain.pem"))).toBe(`${CHAIN}`);
    expect(read(join(dir, "privkey.pem"))).toBe(KEY);
  });

  test("keeps the key to root alone, and every file whole or not at all", async () => {
    const s = store();
    const { id } = await installInDsm({ description: "wave: x", keyPem: KEY, chainPem: CHAIN }, s.options);
    expect(statSync(join(s.archive, id, "privkey.pem")).mode & 0o777).toBe(0o600);
    // Written beside and renamed, so nothing is left behind and nothing is half there.
    expect(existsSync(join(s.archive, id, "privkey.pem.wave-new"))).toBe(false);
  });

  test("is listed in INFO with a description and no services, beside what was there", async () => {
    const s = store({ own123: { desc: "Default", services: [entry("system", "default")] } });
    const { id } = await installInDsm(
      { description: "wave: nas.wave.example", keyPem: KEY, chainPem: CHAIN },
      s.options,
    );

    const info = infoOf(s);
    expect(info[id]).toEqual({ desc: "wave: nas.wave.example", services: [] });
    // The default's entry is DSM's own, down to the services it serves.
    expect(info.own123).toEqual({ desc: "Default", services: [entry("system", "default")] });
  });

  test("leaves the default certificate and the web interface alone", async () => {
    const s = store({ own123: { desc: "Default", services: [entry("system", "default")] } });
    const web = service(s.paths.certRoot, "system", "default");
    await installInDsm({ description: "wave: x", keyPem: KEY, chainPem: CHAIN }, s.options);

    expect(read(join(s.archive, "DEFAULT"))).toBe("own123");
    expect(read(join(web, "cert.pem"))).toBe("old");
    expect(s.commands).toEqual([]);
  });
});

describe("a renewal", () => {
  test("goes into the same entry by the id it was given, and adds no second one", async () => {
    const s = store();
    const first = await installInDsm({ description: "wave: x", keyPem: KEY, chainPem: CHAIN }, s.options);
    const before = read(s.info);

    const second = await installInDsm(
      {
        description: "wave: x",
        id: first.id,
        keyPem: "-----BEGIN PRIVATE KEY-----\nbmV3\n-----END PRIVATE KEY-----\n",
        chainPem: CHAIN,
      },
      s.options,
    );

    expect(second).toMatchObject({ id: first.id, created: false });
    expect(Object.keys(infoOf(s))).toHaveLength(2);
    // DSM's index is not touched for a renewal: its service lists are DSM's to keep.
    expect(read(s.info)).toBe(before);
    expect(read(join(s.archive, first.id, "privkey.pem"))).toContain("bmV3");
  });

  test("finds its entry by description when the id is lost, instead of adding another", async () => {
    const s = store();
    const first = await installInDsm({ description: "wave: x", keyPem: KEY, chainPem: CHAIN }, s.options);
    const again = await installInDsm({ description: "wave: x", keyPem: KEY, chainPem: CHAIN }, s.options);

    expect(again).toMatchObject({ id: first.id, created: false });
    expect(Object.keys(infoOf(s))).toHaveLength(2);
  });

  test("two names are two entries", async () => {
    const s = store();
    const a = await installInDsm({ description: "wave: a", keyPem: KEY, chainPem: CHAIN }, s.options);
    const b = await installInDsm({ description: "wave: b", keyPem: KEY, chainPem: CHAIN }, s.options);
    expect(a.id).not.toBe(b.id);
  });

  test("an id the store no longer knows is not trusted: the entry is made again", async () => {
    const s = store();
    const result = await installInDsm(
      { description: "wave: x", id: "gone00", keyPem: KEY, chainPem: CHAIN },
      s.options,
    );
    expect(result.created).toBe(true);
    expect(result.id).not.toBe("gone00");
  });
});

describe("services that already use the certificate", () => {
  /** system/default and smbftpd/ftpd on this certificate, one in each place DSM keeps them. */
  async function assigned(fail?: (command: string[]) => number) {
    const s = store({}, fail);
    const first = await installInDsm({ description: "wave: x", keyPem: KEY, chainPem: CHAIN }, s.options);
    const info = infoOf(s);
    info[first.id] = { desc: "wave: x", services: [entry("system", "default"), entry("smbftpd", "ftpd")] };
    writeFileSync(s.info, JSON.stringify(info));
    const web = service(s.paths.certRoot, "system", "default");
    const ftp = service(s.paths.serviceRoots[0] as string, "smbftpd", "ftpd");
    const reload = {
      system: script(s.paths.subscriberDirs[0] as string, "system"),
      ftp: script(s.paths.subscriberDirs[1] as string, "smbftpd"),
      dsm: script(s.paths.profileDir, "dsm.sh"),
      ftpProfile: script(s.paths.profileDir, "smbftpd.sh"),
    };
    return { s, id: first.id, web, ftp, reload };
  }

  test("get the new files and are told, the way DSM tells them", async () => {
    const { s, id, web, ftp, reload } = await assigned();
    const result = await installInDsm(
      { description: "wave: x", id, keyPem: KEY, chainPem: CHAIN },
      s.options,
    );

    expect(result.services).toEqual(["system/default", "smbftpd/ftpd"]);
    for (const dir of [web, ftp]) {
      expect(read(join(dir, "cert.pem"))).toBe(`${LEAF}\n`);
      expect(read(join(dir, "fullchain.pem"))).toBe(CHAIN);
      expect(statSync(join(dir, "privkey.pem")).mode & 0o777).toBe(0o600);
    }
    // The subscriber's own script, then the TLS profile -- DSM's web interface has its own name for that one.
    expect(s.commands).toEqual([
      [reload.system, "default"],
      [reload.dsm],
      [reload.ftp, "ftpd"],
      [reload.ftpProfile],
    ]);
  });

  test("a reload that fails is said and does not stop the others", async () => {
    const { s, id, ftp, reload } = await assigned((command) => (command[0] === reload.system ? 1 : 0));
    const result = await installInDsm(
      { description: "wave: x", id, keyPem: KEY, chainPem: CHAIN },
      s.options,
    );

    expect(s.log.some((line) => line.includes(`${reload.system} default exited 1: it did not work`))).toBe(
      true,
    );
    expect(result.services).toEqual(["system/default", "smbftpd/ftpd"]);
    expect(s.commands).toContainEqual([reload.ftp, "ftpd"]);
    expect(read(join(ftp, "cert.pem"))).toBe(`${LEAF}\n`);
  });

  test("one whose directory is gone is skipped, and said", async () => {
    const { s, id, web, ftp } = await assigned();
    rmSync(web, { recursive: true });
    const result = await installInDsm(
      { description: "wave: x", id, keyPem: KEY, chainPem: CHAIN },
      s.options,
    );

    expect(result.services).toEqual(["smbftpd/ftpd"]);
    expect(s.log).toContain("DSM: no directory for system/default; skipped");
    expect(read(join(ftp, "cert.pem"))).toBe(`${LEAF}\n`);
  });

  test("the web interface gets nginx reloaded when DSM has no script for it", async () => {
    const s = store({});
    const first = await installInDsm({ description: "wave: x", keyPem: KEY, chainPem: CHAIN }, s.options);
    writeFileSync(
      s.info,
      JSON.stringify({ [first.id]: { desc: "wave: x", services: [entry("system", "default")] } }),
    );
    service(s.paths.certRoot, "system", "default");

    await installInDsm({ description: "wave: x", id: first.id, keyPem: KEY, chainPem: CHAIN }, s.options);
    expect(s.commands).toEqual([[s.paths.synosystemctl, "reload", "nginx"]]);
  });
});

describe("a store that cannot be written", () => {
  test("an INFO that is not JSON is left exactly as it is, and nothing is made", async () => {
    const s = store();
    writeFileSync(s.info, "{ this is not json");

    await expect(
      installInDsm({ description: "wave: x", keyPem: KEY, chainPem: CHAIN }, s.options),
    ).rejects.toThrow(/not valid JSON/);
    expect(read(s.info)).toBe("{ this is not json");
    expect(Bun.spawnSync(["ls", s.archive]).stdout.toString().trim().split("\n").sort()).toEqual([
      "DEFAULT",
      "INFO",
    ]);
  });

  test("an INFO that is not an object is refused as well", async () => {
    const s = store();
    writeFileSync(s.info, "[]");
    await expect(
      installInDsm({ description: "wave: x", keyPem: KEY, chainPem: CHAIN }, s.options),
    ).rejects.toThrow(/not what DSM writes/);
  });

  test("no store at all says where it looked", async () => {
    const s = store();
    rmSync(s.info);
    await expect(
      installInDsm({ description: "wave: x", keyPem: KEY, chainPem: CHAIN }, s.options),
    ).rejects.toThrow(/INFO cannot be read \(ENOENT\)/);
  });

  test("a chain without a certificate in it is refused before anything is written", async () => {
    const s = store();
    await expect(
      installInDsm({ description: "wave: x", keyPem: KEY, chainPem: "nothing" }, s.options),
    ).rejects.toThrow(/no certificate/);
    expect(Object.keys(infoOf(s))).toEqual(["own123"]);
  });
});
