/**
 * What the page "delete account" decides on its own, apart from rendering: how
 * the control server's preview is read, when the form may be sent, and which
 * answer of `POST /api/me/delete` means what. No cookies here (unlike
 * `@/lib/control`), so client components and tests can import it.
 */

type Outcome = "delete" | "handover" | "leave";

/** `GET /api/me/delete-preview`, as `describeDeletion` in the control server builds it. */
export interface DeletePreview {
  /** What has to be typed: the address (`email`) or, for an account without one, the word. */
  confirmation: "email" | "word";
  word: string | null;
  twoFactor: boolean;
  /** Others are in these waves and the user is their last administrator: deleting is refused. */
  blockers: { id: string; name: string }[];
  /** The user is alone in these: they go with the account. */
  deleted: { id: string; name: string }[];
  /** They stay and get another owner. */
  handedOver: { id: string; name: string }[];
  /** They stay; the user only leaves. */
  left: { id: string; name: string }[];
  devices: number;
  /** Waves whose subscription keeps running after the deletion. */
  billed: { id: string; name: string; outcome: Outcome }[];
  accountSubscription: boolean;
}

/** The word an account without an address types, when the server does not name one. */
export const DEFAULT_WORD = "DELETE";

/** A preview the server sent, with every list present: an older or odd answer must not crash the page. */
export function readPreview(data: unknown): DeletePreview {
  const raw = (data ?? {}) as Partial<DeletePreview>;
  const list = <T>(value: T[] | undefined): T[] => (Array.isArray(value) ? value : []);
  return {
    confirmation: raw.confirmation === "word" ? "word" : "email",
    word: raw.confirmation === "word" ? (raw.word ?? DEFAULT_WORD) : null,
    twoFactor: raw.twoFactor === true,
    blockers: list(raw.blockers),
    deleted: list(raw.deleted),
    handedOver: list(raw.handedOver),
    left: list(raw.left),
    devices: typeof raw.devices === "number" ? raw.devices : 0,
    billed: list(raw.billed),
    accountSubscription: raw.accountSubscription === true,
  };
}

/** Whether a wave stops the deletion: the form is then locked. */
export const isBlocked = (preview: DeletePreview): boolean => preview.blockers.length > 0;

/** Whether the deletion leaves a subscription running that has to be cancelled elsewhere. */
export const hasBilling = (preview: DeletePreview): boolean =>
  preview.billed.length > 0 || preview.accountSubscription;

/**
 * Whether the form may be sent: not blocked, the confirmation typed and, with a
 * second factor, a code. The server checks all of it again; this only keeps an
 * obviously empty form from becoming a request (and from counting as a wrong code).
 */
export function mayDelete(preview: DeletePreview, confirm: string, code: string): boolean {
  if (isBlocked(preview)) return false;
  if (!confirm.trim()) return false;
  if (preview.twoFactor && !code.trim()) return false;
  return true;
}

/** What a failed answer of `POST /api/me/delete` is, for choosing its sentence. */
export type DeleteFailure =
  | { kind: "confirmation-mismatch" }
  | { kind: "invalid-code" }
  | { kind: "code-required" }
  | { kind: "throttled" }
  | { kind: "last-admin"; waves: string[] }
  | { kind: "unauthenticated" }
  | { kind: "unknown" };

export function readFailure(data: unknown): DeleteFailure {
  const raw = (data ?? {}) as { error?: unknown; waves?: unknown };
  switch (raw.error) {
    case "confirmation-mismatch":
    case "invalid-code":
    case "code-required":
    case "throttled":
    case "unauthenticated":
      return { kind: raw.error };
    case "last-admin": {
      const waves = Array.isArray(raw.waves)
        ? raw.waves.flatMap((wave) =>
            typeof (wave as { name?: unknown })?.name === "string" ? [(wave as { name: string }).name] : [],
          )
        : [];
      return { kind: "last-admin", waves };
    }
    default:
      return { kind: "unknown" };
  }
}
