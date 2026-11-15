# Account subscriptions: calls for wave-mesh.org

*Deutsch: [`ACCOUNT-SUBSCRIPTIONS.md`](ACCOUNT-SUBSCRIPTIONS.md). For users: [`FREE-PLAN.md`](FREE-PLAN.md).*

Ticket #117. An **account subscription** applies to a whole hosted customer account (`customer_accounts`)
and so to all its waves, unlike the wave subscription (`PUT /api/billing/subscriptions/:id`), which books
exactly one wave. Whoever starts with a free account (up to 3 waves, 3 people, 100 devices) upgrades with an
account subscription and falls back to free when it is cancelled — without anything changing about waves,
keys, addresses or connections.

The site calls the endpoint in a follow-up ticket; this document describes the contract. There is no other
way to write (no `wave-admin`, no interface).

## Call

```bash
curl -X PUT "$CONTROL/api/billing/account-subscriptions/$SUBSCRIPTION_ID" \
  -H "Authorization: Bearer $WAVE_BILLING_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "email": "anna@acme.example", "seats": 10, "state": "active", "asOf": 1789000000000 }'
```

The same bearer token as for the wave subscriptions (`WAVE_BILLING_TOKEN`); without a token the path does
not exist (404), with a wrong one it is 401.

| Field | Meaning |
|---|---|
| `:subscriptionId` | the Stripe subscription id, permanent; one row per id |
| `email` | address of the payer; only needed on the **first** call of an id, ignored afterwards |
| `seats` | integer 1…100000: people in the whole account (members plus open invitations) |
| `state` | `active`, `suspended`, `ended` — the state the subscription is to have |
| `asOf` | optional, ms: when the site read the state at Stripe |

What is said is the **state, not the change**: the same thing twice is once, a late event is no worse than a
repeated one. An `asOf` older than the last one applied is not applied and is answered with the current
state (200).

## When a subscription comes into being

An unknown id comes into being only with `email` **and** `state: "active"`. The address must belong to a
**confirmed** user (`emailVerified`): an account subscription buys more room in an account that already
belongs to someone, so there is no placeholder here. If the user has no customer account yet, it is created
empty together with the subscription. If a user has several accounts, the oldest applies.

## Answers

| Status | Body | Meaning for the site |
|---|---|---|
| 200 | `{ subscriptionId, accountId, created, state, seats, deleteAfter, waves, people }` | applied (also repeated or outdated). `deleteAfter` only in `ended` (ISO time), `waves` and `people` are the account's state now |
| 400 | `{ "error": "invalid request" \| "not JSON" \| "not an email address…" }` | call is wrong, do not repeat |
| 401 | `{ "error": "unauthorized" }` | wrong token |
| 404 | `{ "error": "unknown-subscription" }` | never seen and not enough said (no address, or not `active`) |
| 404 | `{ "error": "unknown-account" }` | **no confirmed address of that name**: there is no account that could get the subscription. Nothing was created. The site does not repeat blindly; the buyer has to sign in with that address, confirmed |
| 409 | `{ "error": "ended" }` | ended for good; a later `active`/`suspended` is an outdated reading |
| 409 | `{ "error": "account-has-subscription" }` | the account already has another account subscription that has not ended |
| 409 | `{ "error": "wave-subscription" }` | the id is already that of a wave subscription |
| 500 | `{ "error": "could not apply the subscription" }` | our error, repeat |

Any other 404 (no token, wrong address) is configuration, not "unknown".

## What is fixed by it

- **Ended stays ended.** `delete_after` (now plus `WAVE_BILLING_RETENTION_DAYS`) is set once and not pushed
  back. It deletes **nothing**: an ended account subscription lets the account fall back to free; waves,
  devices, members and invitations stay. The free limits afterwards only say no to what is new, even if the
  account exceeds them.
- **`suspended` is not ended:** the account stays paid. There is no pause of network maps for account
  subscriptions (only the wave subscription pauses a wave).
- **One account subscription per account that has not ended** (partial unique index). Two simultaneous
  deliveries of the same id give one row and two times 200 (`created: true` exactly once).
- **How `seats` counts:** with an account subscription, `seats` plus the sum of the account's
  `wave_billing.seats` applies account-wide, counted as distinct people. A wave with its own `wave_billing`
  row keeps checking per wave.
- **Devices:** an account with an account subscription that has not ended has no device limit.
- **No network map:** an account subscription neither starts nor stops a mesh; nothing is sent to devices.
- **Log:** `billing: account <id> subscription <sub> is <state>, <n> seats` on every change.

## Downgrade check

Before the site allows a cancellation, it asks whether the account could stay as a free account as it is.
The check changes nothing and deletes nothing; the decision stays with the site.

```bash
curl "$CONTROL/api/billing/accounts/$ACCOUNT_ID/downgrade-check" \
  -H "Authorization: Bearer $WAVE_BILLING_TOKEN"
```

`$ACCOUNT_ID` is the `accountId` from the answer of the account subscription (`ca_…`).

```json
{
  "allowed": false,
  "limits": { "waves": 3, "people": 3, "devices": 100 },
  "usage": { "waves": 4, "people": 5, "devices": 12 },
  "overhang": { "waves": 1, "people": 2, "devices": 0 }
}
```

- `allowed` is true with at most `limits.waves` waves, `limits.people` people and `limits.devices` devices
  (default 3 / 3 / 100; the limits are those of the free accounts of this server, `WAVE_FREE_MAX_WAVES`,
  `WAVE_FREE_DEVICE_LIMIT`).
- `usage.people` is distinct users plus open invitations to addresses not involved yet, `usage.devices`
  distinct devices (machine keys) across all waves of the account.
- `overhang` is by how much `usage` is above `limits`, per number (0 if it fits).
- It is always measured against the **free** limits, even for an account with a subscription: the question
  is "would it fit".

| Status | Body | Meaning |
|---|---|---|
| 200 | as above | holds for any account, even an empty one |
| 401 | `{ "error": "unauthorized" }` | token missing or wrong |
| 404 | `{ "error": "unknown-account" }` | the id is no customer account |
| 404 | (empty) | no `WAVE_BILLING_TOKEN` on the server: configuration, not "unknown" |

## What the owner sees

`/api/me` carries in `account`, in addition to `identities` and `linkable` (only on a hosted server, with
`WAVE_BILLING_TOKEN`):

```json
{
  "accountId": "ca_…",
  "plan": "free",
  "limits": { "waves": 3, "people": 3, "devices": 100 },
  "usage": { "waves": 2, "people": 1, "devices": 5 },
  "overhang": {
    "waves": 0, "people": 0, "devices": 0,
    "perWave": [
      { "waveId": "w_…", "waveName": "alpha",
        "people": [{ "email": "anna@acme.example", "kind": "member" },
                   { "email": "wait@acme.example", "kind": "invitation" }],
        "devices": [{ "name": "laptop" }] }
    ]
  }
}
```

`plan` is `free` or `paid`. A subscription (limits `null`), a free account and a self-hosted server (no
`plan` at all) are thus three different answers; the interface calculates nothing itself, it only reads
these numbers. For a paid account `limits.waves` and `limits.devices` are `null` (no limit) and
`limits.people` is the number of seats. `accountId` is `null` while the user has no account yet (their first
wave creates it); plan `free`, usage 0. `usage.people` counts the way the plan limits its people: free and
account subscription as **distinct people** (members plus open invitations to addresses not involved yet, a
person in two waves once), an account paid only through `wave_billing` as **memberships** plus open
invitations (a person in two waves twice). So `used / limit` is always one rule. `overhang.perWave` is only
filled when something is above a limit, and then names, for **every** wave of the account, the people
(address, member or invitation) and the devices (name). Which of them are "too many" is not decided by the
system: it **deletes and stops nothing**, the limits only say no to what is new. In the interface this is on
`/account` (section "Plan and usage", `#plan`).

For the people hints when inviting, `GET /api/waves/:id/members` additionally returns `account`
(`{ plan, limits, usage }`, as above): the usage of the account the wave belongs to. The key is missing on a
self-hosted server and for a wave without an account; the interface then shows no hint.

## Setting the limits (operation)

| Setting | Default | Effect |
|---|---|---|
| `WAVE_FREE_MAX_WAVES` | 3 | waves per free account; empty = 3, at least 1 |
| `WAVE_FREE_DEVICE_LIMIT` | 100 | distinct devices per free account, across all waves; empty = 100, at least 1 |
| People | 3, fixed | **no environment variable:** the constant `FREE_PEOPLE_LIMIT` in `apps/control/src/billing/plan.ts` |
| `WAVE_FREE_IPV4_PREFIX_LENGTH` | `/24` | address block of a new free wave (#118); has to leave room for `WAVE_FREE_DEVICE_LIMIT` |
| `WAVE_FREE_BLOCKED_EMAIL_DOMAINS` | empty | comma list; blocks only the free start |
| `WAVE_SIGNUP_ENABLED` | off | sign-up page `/signup` (#147); only `true` or `1` turns it on, empty or unknown is off. Changes no limit, only whether the page and the "Create account" link exist; `/api/auth/providers` reports it as `signup` (with `freePlan` when on) |
| `WAVE_BASE_URL` | | basis of the `upgradeUrl` in the errors (`<WAVE_BASE_URL>/account#plan`) |

The limits apply only with `WAVE_BILLING_TOKEN` (hosted). Without it, that is with self-hosting, waves are
created without an account, and without an account there is no limit: neither a display nor a refusal.

## Errors at the limits

Every refusal names `used / limit` and at least one next step; the texts come in German or English
(`Accept-Language` header). `upgradeUrl` is the absolute address of `/account#plan`.

| Limit | Call | Answer |
|---|---|---|
| Waves | `POST /waves` with `Accept: application/json` | `403 { "error": "wave-limit", "limit": 3, "used": 3, "message": "…", "upgradeUrl": "…" }` |
| People | `POST /waves/:id/invites` with `Accept: application/json` | `409 { "error": "people-limit", "limit": 3, "used": 3, "plan": "free", "message": "…", "upgradeUrl": "…" }` |
| Devices | `POST /v1/machine/register` | `403 { "error": "…", "code": "device_limit", "limit": 100, "used": 100, "upgradeUrl": "…" }` |

- `error` and `code` stay as they were; `used`, `message` and `upgradeUrl` are new. With `device_limit`,
  `error` is an English sentence with the same numbers and steps, which an older client shows unchanged.
- Next steps: delete a wave or subscribe (waves); withdraw an invitation, remove a person or subscribe
  (people); remove a device or subscribe (devices).
- Browsers get the same sentences as a page (`data-error="wave-limit"`, `409` when inviting, `403` when
  approving a device) with a link to `/account#plan`; `wave-admin add-member|invite` says them on the shell.
- The client (`wave up`, `wave login`, daemon, DSM interface) shows `device_limit` as the notice
  `device-limit` in the reader's language, instead of the raw answer.
