/**
 * Ticket #116: Gratis-Kontingent pro Kundenkonto, höchstens 100 verschiedene registrierte Geräte.
 *
 * Das Kundenkonto (`customer_accounts`, `waves.account_id`) lässt sich in der Oberfläche nicht anlegen und
 * kommt in keiner Antwort vor (siehe #114). Die Test-Waves haben deshalb kein Konto, das Limit (auf dem
 * Testsystem 100) greift bei ihnen nicht: Das ist der selbst betriebene Fall, der laut Ticket unbegrenzt
 * bleiben muss. Beobachtbar ist, was die Änderung an Registrierung, Freigabe und Geräteliste nicht
 * verändern darf, soweit die Oberfläche es hergibt.
 *
 * Geräte entstehen mit einer signierten Registrierung (`POST /v1/machine/register`, Ed25519-Schlüssel des
 * Tests, Signatur wie in `packages/crypto/src/httpsig.ts`) und der Freigabe im Browser
 * (`/machine/authorize` → `/devices/choose`), ohne Pre-Auth-Key: Ein solcher Schlüssel lässt sich nur mit
 * `wave-admin` auf dem Server erzeugen, nicht über die Oberfläche. Beide Wege gehen durch `createNode()`.
 * Jedes Gerät hat einen eigenen Schlüssel mit Lauf-Kennung im Hostnamen und wird am Ende in der Oberfläche
 * entfernt. Jeder Fall ist ein Kriterium des Tickets, soweit es sich zeigen lässt:
 *
 * - G1 „Wave ohne Konto bleibt unbegrenzt“ (Abnahme „Gerät 1–100 registrierbar“, soweit ohne Konto prüfbar):
 *   Zwei verschiedene Geräte melden sich an, werden freigegeben und stehen in der Geräteliste; weder die
 *   Registrierung (JSON `device_limit`, 403) noch die Freigabeseite („Device limit reached“) sperrt.
 * - G2 „Dasselbe Gerät meldet sich erneut“: Mit `X-Wave-Id` und neuem Node-Schlüssel (Rotation) bleibt es
 *   dasselbe Gerät: gleiche Node-ID, keine zweite Zeile in der Geräteliste.
 * - G3 „Gleiches Gerät in zwei Waves“: Dieselbe Gerätekennung steht danach in zwei Waves mit je eigener
 *   Node-ID; ohne `X-Wave-Id` ist die Wave nicht zu erraten (409), mit ihr geht es.
 * - G4 „Geräteliste und Wave-Karte“: Wave-Karte und Geräteliste zeigen die Geräte, Wave-ID, Rolle und
 *   Abrechnung (`billing` ist `null`) der beiden Waves sind gegenüber vorher unverändert, `canCreateWave`
 *   bleibt wahr, keine Kontingent- oder Pausenmeldung.
 * - G5 „Entfernen aus nur einer Wave lässt das Gerät in der anderen“ und „Testdaten restlos entfernt“: Das
 *   Entfernen über die Oberfläche nimmt das Gerät nur aus dieser Wave; danach sind beide Listen leer.
 *
 * Nicht über die Oberfläche prüfbar, mit Grund (Beleg: `apps/control/test/device-limit.test.ts`, die 17 Tests
 * aus PR #126):
 * - Gerät 101 wird verständlich abgewiesen (API 403 `device_limit`, Browser-Seite auf Deutsch und Englisch,
 *   Pre-Auth-Key bleibt unverbraucht): Das Limit gilt nur für Waves mit Kundenkonto ohne Abo. Ein Konto lässt
 *   sich in der Oberfläche nicht anlegen, die Test-Waves haben keines, die Abweisung kann hier nie greifen.
 *   101 Geräte auf dem geteilten Testsystem anzulegen, brächte ohne Konto nichts und ist deshalb nicht
 *   vertretbar. Belege: „takes devices up to the limit and turns the next one away“, „the hundred-and-first
 *   device of a default account is refused“, „says why in the reader's language, and adds nothing“,
 *   „keeps a key usable for a device that fits once a place is free“.
 * - Gleiches Gerät in zwei Waves zählt einmal, Entfernen aus nur einer Wave gibt keinen Platz frei: Gezählt
 *   wird nur im Konto, das hier fehlt, und kein Antwortfeld nennt die Zahl der Geräte. G3 und G5 zeigen nur
 *   die Zuordnung der Knoten. Belege: „counts a device once when it is in two waves of the account“,
 *   „counts across the waves of the account, not per wave“.
 * - Zwei parallele Registrierungen vergeben den letzten Platz nicht doppelt: Es gibt keinen letzten Platz
 *   ohne Konto, und ein Wettlauf um ihn ist über die Oberfläche nicht gezielt auszulösen. Beleg: „lets two
 *   devices race for the last place with exactly one winner“.
 * - Schlüsselrotation und Connectoren: Der Connector meldet sich mit Pre-Auth-Key an (kein Weg über die
 *   Oberfläche, siehe oben), und die Rotation des Gerätekennzeichens (`machine_key`) gibt es nur im Client.
 *   G2 deckt die Rotation des Node-Schlüssels ab. Belege: `device-limit.test.ts` („what has no limit“,
 *   „one device in several waves“), `docs/DEVICE-IDENTITY.md`.
 * - Bestandsgeräte über dem Limit bleiben, Konto mit Abo bleibt unbegrenzt: Beides verlangt ein Konto
 *   bzw. ein Abo. Belege: „devices over the limit that were there before stay“, „an account with a
 *   subscription in any of its waves“.
 *
 * Testdaten: Der Eigentümer (APP_USER) legt zwei Waves mit Lauf-Kennung im Namen an. Drei Registrierungen
 * (zwei Geräte, eines davon in beiden Waves) werden im Browser des Eigentümers freigegeben. Am Ende
 * entfernt der Eigentümer die Geräte und die Waves; fremde Daten werden nie angefasst. Es gibt keine
 * Konten und keine Zweitkonten.
 *
 * Beschriftungen gelten für `en-US` (Config); Selektoren sonst über `name`, `action`, Rolle. Die Sperren
 * werden zusätzlich sprachunabhängig über Statuscode und `code` der Antwort ausgeschlossen.
 */
import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { type APIRequestContext, type APIResponse, expect, type Page, test } from "@playwright/test";
import { createWave, deleteWave, env, login, waveCard, waveId } from "./helpers.ts";

const run = Math.random().toString(36).slice(2, 8);
const waveOne = `t116-wave-1-${run}`;
const waveTwo = `t116-wave-2-${run}`;

interface Device {
  hostname: string;
  machineKey: string;
  discoKey: string;
  privateKey: KeyObject;
}

/** Roher 32-Byte-Schlüssel in Base64, wie ihn die Registrierung erwartet. */
const rawPublic = (key: KeyObject): string =>
  key.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");

function newDevice(label: string): Device {
  const machine = generateKeyPairSync("ed25519");
  return {
    hostname: `t116-${label}-${run}`,
    machineKey: rawPublic(machine.publicKey),
    discoKey: rawPublic(generateKeyPairSync("x25519").publicKey),
    privateKey: machine.privateKey,
  };
}

/** Eine signierte Anfrage des Geräts; Aufbau der Signatur wie `buildAuthorizationHeader()`. */
async function signed(
  api: APIRequestContext,
  device: Device,
  method: "GET" | "POST",
  path: string,
  payload: string,
  wave?: string,
): Promise<APIResponse> {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(12).toString("base64url");
  const message = [
    "wave-sig-v1",
    method,
    path,
    String(timestamp),
    nonce,
    createHash("sha256").update(payload).digest("hex"),
  ].join("\n");
  const signature = sign(null, Buffer.from(message), device.privateKey).toString("base64");
  return api.fetch(path, {
    method,
    ...(method === "GET" ? {} : { data: payload }),
    headers: {
      "content-type": "application/json",
      authorization: `WaveSig k=${device.machineKey},t=${timestamp},n=${nonce},s=${signature}`,
      ...(wave ? { "x-wave-id": wave } : {}),
    },
    failOnStatusCode: false,
    maxRedirects: 0,
  });
}

const register = (api: APIRequestContext, device: Device, nodeKey: string, wave?: string) =>
  signed(
    api,
    device,
    "POST",
    "/v1/machine/register",
    JSON.stringify({
      machineKey: device.machineKey,
      nodeKey,
      discoKey: device.discoKey,
      hostname: device.hostname,
      os: "linux",
    }),
    wave,
  );

const freshNodeKey = (): string => rawPublic(generateKeyPairSync("x25519").publicKey);

/** Das Gerät fragt nach einem Platz; die Antwort ist „offen“, nie eine Sperre. */
async function askToJoin(api: APIRequestContext, device: Device, wave?: string) {
  const res = await register(api, device, freshNodeKey(), wave);
  const body = (await res.json()) as {
    status?: string;
    code?: string;
    authUrl?: string;
    pollSecret?: string;
  };
  expect(res.status()).toBe(200);
  expect(body.code).not.toBe("device_limit");
  expect(body.status).toBe("pending");
  const requestId = new URL(body.authUrl ?? "", "https://invalid.test").searchParams.get("request");
  expect(requestId).toBeTruthy();
  expect(body.pollSecret).toBeTruthy();
  return { requestId: requestId ?? "", pollSecret: body.pollSecret ?? "" };
}

/** Der Eigentümer gibt die Anfrage im Browser für eine Wave frei, wie nach `wave login`. */
async function approve(page: Page, requestId: string, wave: { id: string; name: string }, hostname: string) {
  await page.goto(`/machine/authorize?request=${encodeURIComponent(requestId)}`);
  await page.waitForURL(/\/devices\/choose/);
  // Mit mehreren Waves wählt der Eigentümer, bei genau einer steht sie fest.
  const radio = page.locator(`input[type="radio"][name="wave"][value="${wave.id}"]`);
  if ((await page.locator('input[type="radio"][name="wave"]').count()) > 0) await radio.check();
  await page.locator('form[action="/machine/authorize"] button[type="submit"]').click();
  await page.waitForURL(/\/devices\/connected/);
  const query = new URL(page.url()).searchParams;
  expect(query.get("wave")).toBe(wave.name);
  expect(query.get("host")).toBe(hostname);
  await expect(page.getByText("Device limit reached")).toHaveCount(0);
}

async function nodeIdOf(api: APIRequestContext, device: Device, pollSecret: string): Promise<string> {
  const res = await signed(api, device, "POST", "/v1/machine/poll", JSON.stringify({ pollSecret }));
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { status: string; nodeId?: string };
  expect(body.status).toBe("authorized");
  expect(body.nodeId).toBeTruthy();
  return body.nodeId ?? "";
}

interface Node {
  id: string;
  hostname: string;
}

/** Geräteliste einer Wave, wie die Oberfläche sie bezieht. */
async function nodesOf(page: Page, id: string): Promise<Node[]> {
  const res = await page.request.get(`/api/waves/${id}/nodes`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { nodes: Node[] }).nodes;
}

interface Me {
  canCreateWave: boolean;
  waves: { id: string; name: string; role: string; billing: unknown }[];
}

async function me(page: Page): Promise<Me> {
  const res = await page.request.get("/api/me");
  expect(res.status()).toBe(200);
  return (await res.json()) as Me;
}

/** Texte, die bei Kontingent, Pause oder Gerätelimit erscheinen würden (en-US). */
const refusal = (page: Page) =>
  page.getByText(/Device limit reached|No seat left|booked for \d+ people|This wave is paused/);

/** Entfernt ein Gerät über den Knopf in der Geräteliste der Wave-Karte. */
async function removeDevice(page: Page, wave: { id: string; name: string }, nodeId: string): Promise<void> {
  await page.goto("/");
  const card = await waveCard(page, wave.name);
  const form = card.locator(`form[action="/waves/${wave.id}/nodes/${nodeId}/remove"]`);
  await expect(form).toHaveCount(1);
  await form.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname === "/");
  await expect.poll(async () => (await nodesOf(page, wave.id)).some((n) => n.id === nodeId)).toBe(false);
}

const deviceA = newDevice("a");
const deviceB = newDevice("b");

let page: Page;
let one: { id: string; name: string };
let two: { id: string; name: string };
let before: Me["waves"];
const nodeIds: { aOne?: string; bOne?: string; aTwo?: string } = {};

test.describe("Gerätekontingent: Wave ohne Konto bleibt unbegrenzt, Geräte und Listen bleiben", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    const context = await browser.newContext({ baseURL: env("APP_URL"), locale: "en-US" });
    page = await context.newPage();
    await login(page, env("APP_USER"), env("APP_PASSWORD"));
    const cardOne = await createWave(page, waveOne, `${waveOne}.wave.internal`);
    one = { id: await waveId(cardOne), name: waveOne };
    const cardTwo = await createWave(page, waveTwo, `${waveTwo}.wave.internal`);
    two = { id: await waveId(cardTwo), name: waveTwo };
    before = (await me(page)).waves.filter((w) => w.id === one.id || w.id === two.id);
  });

  test.afterAll(async () => {
    test.setTimeout(240_000);
    const attempt = async (step: () => Promise<unknown>) => {
      try {
        await step();
      } catch {
        // Aufräumen läuft weiter; ein Rest steht im Bericht des Eigentümers, nicht hier.
      }
    };
    if (page) {
      // Geräte zuerst einzeln, dann die Waves: bleibt ein Gerät übrig, geht es mit seiner Wave.
      for (const [wave, id] of [
        [one, nodeIds.aOne],
        [one, nodeIds.bOne],
        [two, nodeIds.aTwo],
      ] as const) {
        const nodeId = id;
        if (nodeId) await attempt(() => removeDevice(page, wave, nodeId));
      }
      await attempt(() => deleteWave(page, waveOne));
      await attempt(() => deleteWave(page, waveTwo));
      await attempt(() => page.context().close());
    }
  });

  test("G1 Zwei verschiedene Geräte melden sich an und werden freigegeben, keine Gerätelimit-Sperre", {
    tag: "@t116",
  }, async ({ request }) => {
    test.setTimeout(180_000);
    for (const [device, key] of [
      [deviceA, "aOne"],
      [deviceB, "bOne"],
    ] as const) {
      const { requestId, pollSecret } = await askToJoin(request, device, one.id);
      await approve(page, requestId, one, device.hostname);
      nodeIds[key] = await nodeIdOf(request, device, pollSecret);
    }

    const list = await nodesOf(page, one.id);
    expect(list.map((n) => n.hostname).sort()).toEqual([deviceA.hostname, deviceB.hostname].sort());
    expect(list.find((n) => n.hostname === deviceA.hostname)?.id).toBe(nodeIds.aOne);
    expect(list.find((n) => n.hostname === deviceB.hostname)?.id).toBe(nodeIds.bOne);
    expect(nodeIds.aOne).not.toBe(nodeIds.bOne);
  });

  test("G2 Dasselbe Gerät meldet sich mit neuem Node-Schlüssel erneut: gleiche Node-ID, keine zweite Zeile", {
    tag: "@t116",
  }, async ({ request }) => {
    const res = await register(request, deviceA, freshNodeKey(), one.id);
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { status: string; nodeId?: string; code?: string };
    expect(body.code).toBeUndefined();
    expect(body.status).toBe("authorized");
    expect(body.nodeId).toBe(nodeIds.aOne);

    const list = await nodesOf(page, one.id);
    expect(list).toHaveLength(2);
    expect(list.filter((n) => n.hostname === deviceA.hostname)).toHaveLength(1);
  });

  test("G3 Dasselbe Gerät in einer zweiten Wave: eigene Node-ID, ohne X-Wave-Id nicht zu erraten", {
    tag: "@t116",
  }, async ({ request }) => {
    test.setTimeout(120_000);
    const { requestId, pollSecret } = await askToJoin(request, deviceA, two.id);
    await approve(page, requestId, two, deviceA.hostname);
    nodeIds.aTwo = await nodeIdOf(request, deviceA, pollSecret);
    expect(nodeIds.aTwo).not.toBe(nodeIds.aOne);

    expect((await nodesOf(page, two.id)).map((n) => n.hostname)).toEqual([deviceA.hostname]);
    expect(await nodesOf(page, one.id)).toHaveLength(2);

    // Das Gerät steht in zwei Waves: ohne Angabe wird nicht geraten, mit Angabe antwortet jede.
    const ambiguous = await signed(request, deviceA, "GET", "/v1/netmap", "");
    expect(ambiguous.status()).toBe(409);
    expect(((await ambiguous.json()) as { error: string }).error.toLowerCase()).toContain("x-wave-id");
    for (const wave of [one, two]) {
      expect((await signed(request, deviceA, "GET", "/v1/netmap", "", wave.id)).status()).toBe(200);
    }
    // Ein Gerät, das nur in einer Wave steht, braucht den Header nicht.
    expect((await signed(request, deviceB, "GET", "/v1/netmap", "")).status()).toBe(200);
  });

  test("G4 Wave-Karte und Geräteliste zeigen die Geräte, Waves und Abrechnung bleiben unverändert", {
    tag: "@t116",
  }, async () => {
    await page.goto("/");
    const card = await waveCard(page, waveOne);
    await expect(card).toHaveCount(1);
    await expect(card.getByRole("heading", { level: 2, name: waveOne, exact: true })).toBeVisible();
    for (const device of [deviceA, deviceB]) {
      await expect(card.locator("li").filter({ hasText: device.hostname })).toHaveCount(1);
    }
    await expect(refusal(page)).toHaveCount(0);

    const state = await me(page);
    expect(state.canCreateWave).toBe(true);
    const after = state.waves.filter((w) => w.id === one.id || w.id === two.id);
    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
    expect(after.sort(byName)).toEqual([...before].sort(byName));
    expect(after.every((w) => w.role === "owner" && w.billing === null)).toBe(true);

    const cardTwo = await waveCard(page, waveTwo);
    await expect(cardTwo.locator("li").filter({ hasText: deviceA.hostname })).toHaveCount(1);
    await expect(refusal(page)).toHaveCount(0);
  });

  test("G5 Entfernen über die Oberfläche nimmt das Gerät nur aus dieser Wave, danach sind beide Listen leer", {
    tag: "@t116",
  }, async ({ request }) => {
    test.setTimeout(180_000);
    const { aOne, bOne, aTwo } = nodeIds;
    if (!aOne || !bOne || !aTwo) throw new Error("G1 und G3 haben die Geräte nicht angelegt");

    await removeDevice(page, one, aOne);
    expect((await nodesOf(page, one.id)).map((n) => n.id)).toEqual([bOne]);
    // In der zweiten Wave steht dasselbe Gerät weiter und ist ohne Header eindeutig erreichbar.
    expect((await nodesOf(page, two.id)).map((n) => n.id)).toEqual([aTwo]);
    expect((await signed(request, deviceA, "GET", "/v1/netmap", "")).status()).toBe(200);

    await removeDevice(page, one, bOne);
    await removeDevice(page, two, aTwo);
    expect(await nodesOf(page, one.id)).toEqual([]);
    expect(await nodesOf(page, two.id)).toEqual([]);
    nodeIds.aOne = undefined;
    nodeIds.bOne = undefined;
    nodeIds.aTwo = undefined;
  });
});
