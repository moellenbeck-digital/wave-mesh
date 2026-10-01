import { buildAuthorizationHeader, canonicalJson, verify } from "@wave/crypto";
import {
  type Candidate,
  CertOrderAccepted,
  CertOrderStatus,
  type Netmap,
  PollResponse,
  RegisterResponse,
  ServiceSyncResponse,
  SignedNetmap,
} from "@wave/proto";
import type { NodeState } from "./state.ts";

export class ControlClient {
  constructor(private readonly state: NodeState) {}

  private async request(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<unknown> {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const res = await fetch(new URL(path, this.state.controlUrl), {
      method,
      body: method === "GET" ? undefined : payload,
      signal: timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs),
      headers: {
        "content-type": "application/json",
        authorization: buildAuthorizationHeader({
          machineKey: this.state.machineKey.publicKey,
          machinePrivateKey: this.state.machineKey.privateKey,
          method,
          path,
          body: payload,
        }),
      },
    });

    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  }

  /**
   * Registers this device. With a pre-auth key it is enrolled straight away --
   * the key is an approval given in advance, for machines that have no browser
   * and nobody to sit at one (D11).
   */
  async register(authKey?: string) {
    return RegisterResponse.parse(
      await this.request("POST", "/v1/machine/register", {
        machineKey: this.state.machineKey.publicKey,
        nodeKey: this.state.nodeKey.publicKey,
        discoKey: this.state.discoKey.publicKey,
        hostname: hostname(),
        os: currentOs(),
        ...(authKey ? { authKey } : {}),
      }),
    );
  }

  async poll(pollSecret: string) {
    return PollResponse.parse(await this.request("POST", "/v1/machine/poll", { pollSecret }));
  }

  async netmap(): Promise<SignedNetmap> {
    return SignedNetmap.parse(await this.request("GET", "/v1/netmap"));
  }

  /**
   * Removes this node from its wave. Best effort, and bounded: the local
   * enrolment is cleared either way, so a server that cannot be reached must
   * not hold the command open. Unbounded, it outlived the CLI's own timeout
   * and a logout that had worked locally reported "the daemon did not answer".
   */
  async logout(timeoutMs = 5_000): Promise<void> {
    await this.request("POST", "/v1/node/logout", {}, timeoutMs);
  }

  /**
   * Asks for a certificate on these names. Only the request travels -- the key
   * that made it never leaves this machine.
   */
  async orderCert(csrPem: string, names: string[]): Promise<CertOrderAccepted> {
    return CertOrderAccepted.parse(await this.request("POST", "/v1/cert/order", { csr: csrPem, names }));
  }

  /** How that order is going. Issuance takes as long as the CA takes. */
  async certOrder(orderId: string): Promise<CertOrderStatus> {
    return CertOrderStatus.parse(await this.request("GET", `/v1/cert/order/${orderId}`));
  }

  /**
   * Declares the whole set of names this node answers for (D11). Used by the
   * operator, which holds this node's key because the cluster is one member of
   * the wave, not two.
   */
  /** `secure` is the subset of `names` the cluster serves over TLS (D11). */
  async syncServices(names: string[], secure?: string[]): Promise<ServiceSyncResponse> {
    return ServiceSyncResponse.parse(await this.request("POST", "/v1/services", { names, secure }));
  }

  /**
   * Fetches an update archive through the control server (D13), signed like
   * every other node request. Handed back as the response so the caller can
   * hash it while it streams to disk; nothing here is trusted until the hash
   * matches the signed manifest.
   */
  async download(version: string, archive: string, timeoutMs = 10 * 60 * 1000): Promise<Response> {
    const path = `/v1/update/${encodeURIComponent(version)}/${encodeURIComponent(archive)}`;
    const res = await fetch(new URL(path, this.state.controlUrl), {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        authorization: buildAuthorizationHeader({
          machineKey: this.state.machineKey.publicKey,
          machinePrivateKey: this.state.machineKey.privateKey,
          method: "GET",
          path,
          body: "",
        }),
      },
    });
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res;
  }

  async publishEndpoints(candidates: Candidate[]): Promise<void> {
    await this.request("POST", "/v1/node/endpoints", { candidates });
  }
}

/**
 * A netmap is only trustworthy if it carries a valid signature from the key
 * pinned at enrolment -- otherwise anything that can answer HTTP could hand us
 * fabricated peer keys.
 */
export function verifyNetmap(signed: SignedNetmap, pinnedPublicKey: string): Netmap {
  if (signed.keyId !== pinnedPublicKey) {
    throw new Error(`netmap signed by an unexpected key (${signed.keyId})`);
  }
  if (!verify(pinnedPublicKey, canonicalJson(signed.netmap), signed.signature)) {
    throw new Error("netmap signature does not verify");
  }
  return signed.netmap;
}

export const currentOs = (): "linux" | "darwin" | "windows" | "other" =>
  process.platform === "linux"
    ? "linux"
    : process.platform === "darwin"
      ? "darwin"
      : process.platform === "win32"
        ? "windows"
        : "other";

const hostname = (): string =>
  (process.env.HOSTNAME ?? Bun.spawnSync(["hostname"]).stdout.toString().trim()) || "node";
