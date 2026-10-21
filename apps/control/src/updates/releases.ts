import { RELEASE_PUBLIC_KEYS, verifyRelease } from "@wave/crypto";
import {
  channelAccepts,
  channelOfVersion,
  compareVersions,
  MANIFEST_ASSET,
  type SignedRelease,
  SignedRelease as SignedReleaseSchema,
  type UpdateChannel,
} from "@wave/proto";

/**
 * Finds the newest release for each channel this server offers, and passes
 * its archives through to the devices (D13).
 *
 * A source, not an authority. Every manifest is checked here, but only as a
 * filter against noise -- what protects a device is the same check on the
 * device, against the keys it was built with. This server never signs
 * anything, and it can only pass on what is genuine.
 *
 * Why the releases come through here at all: this feed currently uses a token,
 * and a token belongs on one server, not on every device that can be lost or sold;
 * every device reaches its control server anyway, which github.com behind a
 * corporate proxy it may not; and the control socket is already open, so the
 * server can say "there is a new one" instead of every device polling GitHub.
 */

/** One release as the GitHub API lists it, as far as we read it. */
interface GithubRelease {
  tag_name: string;
  draft: boolean;
  assets: Array<{ id: number; name: string }>;
}

interface KnownRelease {
  signed: SignedRelease;
  /** Archive name to asset id: the route to the bytes. */
  assets: Map<string, number>;
}

export interface Offer {
  channel: UpdateChannel;
  channels: UpdateChannel[];
  offer: SignedRelease | null;
}

export interface ReleaseFeedOptions {
  repo: string;
  token?: string;
  channels: UpdateChannel[];
  /** The keys a manifest must be signed with; only the tests pass others. */
  trusted?: readonly string[];
  fetch?: typeof fetch;
  apiBase?: string;
  log?: (message: string) => void;
  /** At most this often; the cache is all a burst of reconnects ever sees. */
  intervalMs?: number;
}

/** How many candidates to look at per channel before giving up on it. */
const CANDIDATES_PER_CHANNEL = 3;

export class ReleaseFeed {
  private readonly best = new Map<UpdateChannel, KnownRelease>();
  /** Verified manifests by tag, and tags that failed: neither is fetched twice. */
  private readonly manifests = new Map<string, KnownRelease | null>();
  private readonly listeners = new Set<() => void>();
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private readonly log: (message: string) => void;
  private timer?: ReturnType<typeof setInterval>;
  private refreshing?: Promise<void>;

  constructor(private readonly options: ReleaseFeedOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.apiBase = (options.apiBase ?? "https://api.github.com").replace(/\/$/, "");
    this.log = options.log ?? ((message) => console.log(`updates: ${message}`));
  }

  /** Without a token there is nothing to read; a server that says so is not broken. */
  get enabled(): boolean {
    return Boolean(this.options.token);
  }

  get channels(): UpdateChannel[] {
    return this.options.channels;
  }

  /** Told whenever any channel's newest release changes. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The device's wish if this server offers it, otherwise the default. */
  assign(wish?: UpdateChannel | null): UpdateChannel {
    const channels = this.options.channels;
    return wish && channels.includes(wish) ? wish : (channels[0] as UpdateChannel);
  }

  offerFor(wish?: UpdateChannel | null): Offer {
    const channel = this.assign(wish);
    return {
      channel,
      channels: [...this.options.channels],
      offer: this.best.get(channel)?.signed ?? null,
    };
  }

  start(): void {
    if (!this.enabled) {
      this.log(`WAVE_GITHUB_TOKEN is not set, so no client updates are offered (${this.options.repo})`);
      return;
    }
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.options.intervalMs ?? 10 * 60 * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Looks again. Concurrent callers share one run. */
  refresh(): Promise<void> {
    this.refreshing ??= this.load().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private headers(accept: string): Record<string, string> {
    return {
      accept,
      authorization: `Bearer ${this.options.token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "wave-control",
    };
  }

  private async load(): Promise<void> {
    if (!this.enabled) return;
    let releases: GithubRelease[];
    try {
      const res = await this.fetchImpl(`${this.apiBase}/repos/${this.options.repo}/releases?per_page=50`, {
        headers: this.headers("application/vnd.github+json"),
      });
      // The body is not logged: an error page is no place for a token to end
      // up, and GitHub's say little anyway.
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      releases = (await res.json()) as GithubRelease[];
    } catch (error) {
      this.log(`could not list the releases of ${this.options.repo}: ${describe(error)}`);
      return;
    }

    const published = releases
      .filter((release) => !release.draft)
      .map((release) => ({ release, version: release.tag_name.replace(/^v/, "") }))
      .map((entry) => ({ ...entry, channel: channelOfVersion(entry.version) }))
      .filter((entry): entry is typeof entry & { channel: UpdateChannel } => entry.channel !== null)
      .sort((a, b) => compareVersions(b.version, a.version));

    let changed = false;
    for (const channel of this.options.channels) {
      let found: KnownRelease | null = null;
      const candidates = published.filter((entry) => channelAccepts(channel, entry.channel));
      for (const entry of candidates.slice(0, CANDIDATES_PER_CHANNEL)) {
        found = await this.manifestOf(entry.release, entry.version, entry.channel);
        if (found) break;
      }
      const before = this.best.get(channel)?.signed.manifest.version;
      if (found) this.best.set(channel, found);
      else this.best.delete(channel);
      if (found?.signed.manifest.version !== before) {
        changed = true;
        if (found) this.log(`${channel}: ${found.signed.manifest.version}`);
      }
    }
    if (changed) for (const listener of this.listeners) listener();
  }

  /**
   * The release's manifest, checked: signed with a trusted key, and saying of
   * itself what its tag says. A manifest that claims another version or
   * channel than the release it is attached to was put there by hand.
   */
  private async manifestOf(
    release: GithubRelease,
    version: string,
    channel: UpdateChannel,
  ): Promise<KnownRelease | null> {
    if (this.manifests.has(release.tag_name)) return this.manifests.get(release.tag_name) ?? null;

    const remember = (known: KnownRelease | null, why?: string): KnownRelease | null => {
      if (why) this.log(`${release.tag_name} is not offered: ${why}`);
      this.manifests.set(release.tag_name, known);
      return known;
    };

    const asset = release.assets.find((candidate) => candidate.name === MANIFEST_ASSET);
    // Releases from before D13 have none. Not worth a line each time.
    if (!asset) return remember(null);

    let signed: SignedRelease;
    try {
      const res = await this.asset(asset.id);
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      signed = SignedReleaseSchema.parse(await res.json());
    } catch (error) {
      // Not remembered: a network failure is not a property of the release.
      this.log(`could not read the manifest of ${release.tag_name}: ${describe(error)}`);
      return null;
    }

    if (!verifyRelease(signed.manifest, signed.signature, signed.keyId, this.trusted)) {
      return remember(null, `its manifest is not signed by a release key (${signed.keyId})`);
    }
    if (signed.manifest.version !== version || signed.manifest.channel !== channel) {
      return remember(
        null,
        `its manifest says ${signed.manifest.version} (${signed.manifest.channel}), the tag ${version} (${channel})`,
      );
    }

    const assets = new Map<string, number>();
    for (const archive of signed.manifest.archives) {
      const match = release.assets.find((candidate) => candidate.name === archive.name);
      if (match) assets.set(archive.name, match.id);
    }
    return remember({ signed, assets });
  }

  private get trusted(): readonly string[] {
    return this.options.trusted ?? RELEASE_PUBLIC_KEYS;
  }

  /**
   * One asset's bytes. The API answers with a redirect to a presigned URL on
   * another host, and that redirect is followed by hand and without the
   * token: whether fetch strips the header on a cross-host redirect by itself
   * is not the question the token should hang on.
   */
  private async asset(id: number): Promise<Response> {
    const res = await this.fetchImpl(`${this.apiBase}/repos/${this.options.repo}/releases/assets/${id}`, {
      headers: this.headers("application/octet-stream"),
      redirect: "manual",
    });
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get("location");
    if (!location) throw new Error(`GitHub answered ${res.status} without a location`);
    return this.fetchImpl(location, { headers: { accept: "application/octet-stream" } });
  }

  /**
   * The bytes of an archive, if it is one of a release this server currently
   * offers. Nothing else: no other repository, no other file and no older
   * release -- the route is not a way to send traffic to GitHub over somebody
   * else's bandwidth.
   */
  async download(version: string, archive: string): Promise<Response | null> {
    for (const known of this.best.values()) {
      if (known.signed.manifest.version !== version) continue;
      const id = known.assets.get(archive);
      if (id === undefined) continue;
      return this.asset(id);
    }
    return null;
  }
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));
