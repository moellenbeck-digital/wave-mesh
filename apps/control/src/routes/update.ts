import { createMemoryNonceStore, type NonceStore } from "@wave/crypto";
import { Hono } from "hono";
import type { Database } from "../db/client.ts";
import type { ReleaseFeed } from "../updates/releases.ts";
import { authenticateMachine, nodeByMachineKey } from "./machine-auth.ts";

/**
 * Where a device fetches the archive of an update it was offered (D13).
 *
 * Signed with the machine key like every other node route: only enrolled
 * devices, and only archives of a release this server offers right now. The
 * body is streamed through and never stored -- a cache would be a volume for
 * hundreds of megabytes that nobody needs, as long as the devices' random
 * delay spreads the load.
 *
 * What the device trusts is not this route but the hash in the signed
 * manifest, which it checks before opening anything. A wrong byte here is a
 * failed download, not a compromised device.
 */
export interface UpdateRouteDeps {
  db: Database;
  releases: ReleaseFeed;
  nonces?: NonceStore;
}

export function updateRoutes({ db, releases, nonces }: UpdateRouteDeps) {
  const app = new Hono();
  const nonceStore = nonces ?? createMemoryNonceStore();

  app.get("/v1/update/:version/:archive", async (c) => {
    const { result } = await authenticateMachine(c, nonceStore);
    if (!result.ok) return c.json({ error: result.reason }, 401);
    if (!(await nodeByMachineKey(db, result.machineKey))) return c.json({ error: "unknown node" }, 404);

    let upstream: Response | null;
    try {
      upstream = await releases.download(c.req.param("version"), c.req.param("archive"));
    } catch (error) {
      console.error("update download failed:", error instanceof Error ? error.message : error);
      return c.json({ error: "release source unreachable" }, 502);
    }
    if (!upstream) return c.json({ error: "not an archive of an offered release" }, 404);
    if (!upstream.ok || !upstream.body)
      return c.json({ error: `release source answered ${upstream.status}` }, 502);

    const headers = new Headers({ "content-type": "application/octet-stream" });
    const length = upstream.headers.get("content-length");
    if (length) headers.set("content-length", length);
    return new Response(upstream.body, { headers });
  });

  return app;
}
