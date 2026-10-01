import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { type ProviderClaims, resolveUser } from "../src/auth/identity.ts";
import type { Database } from "../src/db/client.ts";
import { users } from "../src/db/schema.ts";
import { createTestDb } from "./helpers.ts";

let db: Database;
let close: () => Promise<void>;

beforeEach(async () => {
  if (close) await close();
  ({ db, close } = await createTestDb());
});

const claims = (over: Partial<ProviderClaims> = {}): ProviderClaims => ({
  provider: "google",
  subject: "sub-1",
  email: "robin@example.com",
  emailVerified: true,
  name: "Robin",
  avatarUrl: null,
  ...over,
});

describe("resolveUser", () => {
  test("creates a user on first login", async () => {
    const result = await resolveUser(db, claims());
    expect(result.isNewUser).toBe(true);
    const rows = await db.select().from(users).where(eq(users.id, result.userId));
    expect(rows[0]?.email).toBe("robin@example.com");
  });

  test("returns the same user for the same provider subject", async () => {
    const first = await resolveUser(db, claims());
    const second = await resolveUser(db, claims({ name: "Robin L." }));
    expect(second.userId).toBe(first.userId);
    expect(second.isNewUser).toBe(false);
  });

  test("links a second provider on a verified email", async () => {
    const first = await resolveUser(db, claims());
    const linked = await resolveUser(db, claims({ provider: "linkedin", subject: "li-9" }));
    expect(linked.userId).toBe(first.userId);
    expect(linked.linkedExisting).toBe(true);
  });

  test("never links on an unverified email", async () => {
    const first = await resolveUser(db, claims());
    const other = await resolveUser(
      db,
      claims({ provider: "facebook", subject: "fb-9", emailVerified: false }),
    );
    expect(other.userId).not.toBe(first.userId);
    expect(other.isNewUser).toBe(true);
  });

  test("never links an unverified account to a verified one either way round", async () => {
    const unverified = await resolveUser(
      db,
      claims({ provider: "facebook", subject: "fb-1", emailVerified: false }),
    );
    const verified = await resolveUser(db, claims());
    expect(verified.userId).not.toBe(unverified.userId);
  });

  test("normalises the email address", async () => {
    const upper = await resolveUser(db, claims({ email: "  Robin@Example.COM " }));
    const lower = await resolveUser(db, claims({ provider: "linkedin", subject: "li-1" }));
    expect(lower.userId).toBe(upper.userId);
  });

  test("accepts a provider without any email, like Instagram", async () => {
    const result = await resolveUser(db, claims({ provider: "instagram", subject: "ig-1", email: null }));
    const rows = await db.select().from(users).where(eq(users.id, result.userId));
    expect(rows[0]?.email).toBeNull();
    expect(rows[0]?.emailVerified).toBe(false);
  });
});
