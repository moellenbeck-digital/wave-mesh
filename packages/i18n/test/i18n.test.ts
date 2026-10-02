import { describe, expect, test } from "bun:test";
import { fromAcceptLanguage, matchLocale, pickLocale, requestLocale } from "../src/index.ts";
import { systemLocale } from "../src/system.ts";

describe("reading a language tag", () => {
  test("every spelling of ours, and nothing else", () => {
    expect(matchLocale("de")).toBe("de");
    expect(matchLocale("de-AT")).toBe("de");
    expect(matchLocale("de_DE.UTF-8")).toBe("de");
    expect(matchLocale("en_US.UTF-8")).toBe("en");
    expect(matchLocale("fr_FR.UTF-8")).toBeNull();
    // "No language" is not English: it falls through to whatever comes next.
    expect(matchLocale("C.UTF-8")).toBeNull();
    expect(matchLocale("POSIX")).toBeNull();
    expect(pickLocale("C", "fr", undefined)).toBe("en");
  });
});

describe("a browser's request", () => {
  test("Accept-Language by weight, ours only", () => {
    expect(fromAcceptLanguage("fr-FR,fr;q=0.9,de;q=0.8,en;q=0.7")).toBe("de");
    expect(fromAcceptLanguage("en-US,en;q=0.9,de;q=0.8")).toBe("en");
    expect(fromAcceptLanguage("de;q=0.2, en;q=0.5")).toBe("en");
    expect(fromAcceptLanguage("fr, es")).toBeNull();
    expect(fromAcceptLanguage("de;q=0, en")).toBe("en");
  });

  test("the switcher's cookie beats the browser", () => {
    expect(requestLocale({ cookie: "a=1; wave_lang=en", acceptLanguage: "de-DE" })).toBe("en");
    expect(requestLocale({ cookie: "wave_lang=xx", acceptLanguage: "de-DE" })).toBe("de");
    expect(requestLocale({ acceptLanguage: "fr" })).toBe("en");
  });
});

describe("the language of this machine", () => {
  const never = () => null;

  test("WAVE_LANG, then the POSIX order", () => {
    expect(systemLocale({ WAVE_LANG: "en", LANG: "de_DE.UTF-8" }, "linux", never)).toBe("en");
    expect(systemLocale({ LANGUAGE: "fr:de", LANG: "en_US.UTF-8" }, "linux", never)).toBe("de");
    expect(systemLocale({ LC_ALL: "de_DE.UTF-8", LANG: "en_US.UTF-8" }, "linux", never)).toBe("de");
    expect(systemLocale({ LC_MESSAGES: "de_AT.UTF-8", LANG: "C" }, "linux", never)).toBe("de");
  });

  test("the platform's settings only when the environment says nothing", () => {
    const plist = '(\n    "de-DE",\n    "en-US"\n)';
    expect(systemLocale({}, "darwin", () => plist)).toBe("de");
    expect(systemLocale({ LANG: "en_US.UTF-8" }, "darwin", () => plist)).toBe("en");
    expect(systemLocale({}, "win32", () => "de-CH")).toBe("de");
  });
});
