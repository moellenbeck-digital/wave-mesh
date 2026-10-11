import { createMemoryNonceStore, der, type NonceStore } from "@wave/crypto";
import { CertOrderRequest } from "@wave/proto";
import { Hono } from "hono";
import { isSuspended } from "../billing/subscriptions.ts";
import type { CertificateService } from "../certs/issue.ts";
import type { Database } from "../db/client.ts";
import { authenticateMachine, nodeByMachineKey } from "./machine-auth.ts";

/**
 * The two routes a node needs for a certificate (D7).
 *
 * It posts a request it made itself and comes back later for the chain. The
 * split is not politeness -- a dns-01 validation takes as long as the CA takes,
 * which is well past any sensible request timeout, and the node has nothing to
 * do in the meantime.
 */
export interface CertRouteDeps {
  db: Database;
  certs: CertificateService;
  nonces?: NonceStore;
}

export function certRoutes({ db, certs, nonces }: CertRouteDeps) {
  const app = new Hono();
  const nonceStore = nonces ?? createMemoryNonceStore();

  app.post("/v1/cert/order", async (c) => {
    const { result, body } = await authenticateMachine(c, nonceStore);
    if (!result.ok) return c.json({ error: result.reason }, 401);

    const node = await nodeByMachineKey(db, result.machineKey);
    if (!node) return c.json({ error: "unknown node" }, 404);
    // A paused wave keeps its devices but gets nothing new from the server,
    // and a certificate is something new: issued now, valid for months.
    if (await isSuspended(db, node.waveId)) {
      return c.json({ error: "this wave is paused: its subscription is not active" }, 403);
    }

    const parsed = CertOrderRequest.safeParse(JSON.parse(body || "{}"));
    if (!parsed.success) return c.json({ error: "invalid request", detail: parsed.error.issues }, 400);

    let csrDer: Buffer;
    try {
      csrDer = der.fromPem(parsed.data.csr, "CERTIFICATE REQUEST");
    } catch {
      return c.json({ error: "the request is not a PEM certificate request" }, 400);
    }

    const accepted = await certs.request({ nodeId: node.id, csrDer, names: parsed.data.names });
    if ("error" in accepted) return c.json({ error: accepted.error }, accepted.status);

    // Deliberately not awaited: the answer is the order id, and the issuance
    // outlives this request. Failures land on the order, which is where the
    // node looks for them.
    accepted.done.catch(() => {});
    return c.json({ orderId: accepted.orderId }, 202);
  });

  app.get("/v1/cert/order/:id", async (c) => {
    const { result } = await authenticateMachine(c, nonceStore);
    if (!result.ok) return c.json({ error: result.reason }, 401);

    const node = await nodeByMachineKey(db, result.machineKey);
    if (!node) return c.json({ error: "unknown node" }, 404);

    // Scoped to this node: an order id is not a secret, and someone else's
    // certificate is not this device's business even though it is public.
    const order = await certs.find(c.req.param("id"), node.id);
    if (!order) return c.json({ error: "unknown order" }, 404);

    if (order.status === "failed") {
      return c.json({ status: "failed", error: order.error ?? "the order failed" });
    }
    if (order.status === "waiting") {
      // Asking after the order is also what makes it look at the zone again --
      // but not on this request's time: once the record is there, the poke runs
      // the rest of the order, and that takes as long as a CA takes. The node
      // asks again in a few seconds and sees it move on. How often a poke
      // really looks at DNS is the service's business.
      void certs.poke(order.id).catch(() => {});
      return c.json({
        status: "waiting",
        records: order.challenges.map((challenge) => ({ name: challenge.name, value: challenge.value })),
      });
    }
    if (order.status !== "valid" || !order.chainPem || !order.expiresAt || !order.renewAt) {
      return c.json({ status: "pending" });
    }
    return c.json({
      status: "issued",
      chainPem: order.chainPem,
      notAfter: order.expiresAt.toISOString(),
      renewAt: order.renewAt.toISOString(),
    });
  });

  return app;
}
