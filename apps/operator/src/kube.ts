import { readFile } from "node:fs/promises";

/**
 * Just enough Kubernetes API to read three kinds of object.
 *
 * No client library: what this needs is three GETs against an HTTPS endpoint
 * whose address, token and CA are all in the pod already. A client library
 * would bring a dependency tree larger than the whole operator for generated
 * types nothing here uses.
 */

const SERVICE_ACCOUNT = "/var/run/secrets/kubernetes.io/serviceaccount";

export interface KubeClient {
  list<T>(path: string): Promise<T[]>;
}

export interface KubeOptions {
  host?: string;
  port?: string;
  tokenPath?: string;
  caPath?: string;
  fetch?: typeof fetch;
}

/**
 * The in-cluster client. The token is re-read on every call because a projected
 * service account token is rotated in place -- a client that read it once works
 * for an hour and then starts failing with 401s that look like a permission
 * problem.
 */
export async function inClusterClient(options: KubeOptions = {}): Promise<KubeClient> {
  const host = options.host ?? process.env.KUBERNETES_SERVICE_HOST;
  const port = options.port ?? process.env.KUBERNETES_SERVICE_PORT ?? "443";
  if (!host) throw new Error("not running in a cluster: KUBERNETES_SERVICE_HOST is unset");

  const tokenPath = options.tokenPath ?? `${SERVICE_ACCOUNT}/token`;
  const caPath = options.caPath ?? `${SERVICE_ACCOUNT}/ca.crt`;
  const ca = await readFile(caPath, "utf8").catch(() => undefined);
  const http = options.fetch ?? fetch;

  return {
    async list<T>(path: string): Promise<T[]> {
      const token = (await readFile(tokenPath, "utf8")).trim();
      const res = await http(`https://${host}:${port}${path}`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        // The cluster CA, not the system store: the API server's certificate is
        // issued by the cluster itself.
        ...(ca ? { tls: { ca } } : {}),
      } as RequestInit);

      if (res.status === 404) return [];
      if (!res.ok) throw new Error(`${path} answered ${res.status} ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as { items?: T[] };
      return body.items ?? [];
    },
  };
}

export const INGRESS_PATH = "/apis/networking.k8s.io/v1/ingresses";
export const HTTPROUTE_PATH = "/apis/gateway.networking.k8s.io/v1/httproutes";
export const GATEWAY_PATH = "/apis/gateway.networking.k8s.io/v1/gateways";
