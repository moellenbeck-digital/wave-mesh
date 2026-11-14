import { describe, expect, test } from "bun:test";
import { appMessages } from "@/i18n/app";

/**
 * The page a free account lands on when it has all its waves (ticket #119): the
 * numbers as `used of allowed` and a next step, in both languages. The page
 * puts the link to `/account#plan` into the `{upgrade}` hole.
 */
describe("the wave limit", () => {
  test("English: used of allowed, delete a wave or subscribe", () => {
    const body = appMessages("en").waveDenialBody("wave-limit", 3, 3);
    expect(body).toContain("yours holds 3 of 3");
    expect(body).toContain("Next step: delete a wave you no longer use");
    expect(body).toContain("subscribe at {upgrade}");
    expect(appMessages("en").waveDenialTitle("wave-limit")).toBe("Free limit reached");
  });

  test("German: the same numbers and the same next steps", () => {
    const body = appMessages("de").waveDenialBody("wave-limit", 3, 3);
    expect(body).toContain("deins hält 3 von 3");
    expect(body).toContain("Nächster Schritt: Lösche einen Wave");
    expect(body).toContain("schließe ein Abo ab unter {upgrade}");
  });

  test("without a count the limit stands for it, and other reasons are unchanged", () => {
    expect(appMessages("en").waveDenialBody("wave-limit", 3)).toContain("yours holds 3 of 3");
    expect(appMessages("en").waveDenialBody("placeholder", 3)).toContain("Nobody has confirmed");
  });
});
