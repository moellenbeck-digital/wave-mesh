/** A way to sign in besides the password, with what the control server calls it. */
export interface AuthProvider {
  id: string;
  /** Set by the operator for an OIDC provider ("Pocket ID"); missing from an older server. */
  label: string | null;
}

/** What a free account may hold, as the control server is configured (never invented here). */
export interface FreePlan {
  waves: number;
  people: number;
  devices: number;
}

/** `GET /api/auth/providers`, read defensively: an older server sends less. */
export interface AuthOptions {
  providers: AuthProvider[];
  /** Whether `/signup` exists on the control server. A missing field is off (ticket #147). */
  signup: boolean;
  /**
   * Whether the form for email and password is on offer (ticket #150): sign-up
   * is on and the server can send the confirmation mail. A missing field is off.
   */
  passwordSignup: boolean;
  /** Only present when sign-up is on. */
  freePlan?: FreePlan;
}

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

export function parseAuthOptions(body: {
  providers?: string[];
  labels?: Record<string, string>;
  signup?: unknown;
  passwordSignup?: unknown;
  freePlan?: { waves?: unknown; people?: unknown; devices?: unknown } | null;
}): AuthOptions {
  const providers = (body.providers ?? []).map((id) => ({ id, label: body.labels?.[id] ?? null }));
  // Only a real `true` counts: an older server leaves the field out, and
  // anything else is not an invitation to show a page the server does not serve.
  const signup = body.signup === true;
  // Only inside a page that exists: the form without the page is nothing.
  const passwordSignup = signup && body.passwordSignup === true;
  const waves = count(body.freePlan?.waves);
  const people = count(body.freePlan?.people);
  const devices = count(body.freePlan?.devices);
  const freePlan =
    signup && waves !== undefined && people !== undefined && devices !== undefined
      ? { waves, people, devices }
      : undefined;
  return { providers, signup, passwordSignup, ...(freePlan ? { freePlan } : {}) };
}

/** The providers the sign-up page offers: the development login is no registration. */
export const signupProviders = (providers: AuthProvider[]): AuthProvider[] =>
  providers.filter((p) => p.id !== "dev");

/** Where the first login lands. */
export const SIGNUP_NEXT = "/waves/new";
