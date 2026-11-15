# Free plan and self-hosting

*Deutsch: [`GRATIS-TARIF.md`](GRATIS-TARIF.md). Ticket #119; the technical side is in
[`ACCOUNT-SUBSCRIPTIONS.en.md`](ACCOUNT-SUBSCRIPTIONS.en.md) and in the section "Gratis-Konto und
Tarifwechsel" of [`CLAUDE.md`](../CLAUDE.md) (German).*

Whoever creates an account on a **hosted** server (wave-mesh.org) starts on the free plan. A server you
**run yourself** (self-hosting) has no plan and no limits.

## What free means

The limits apply to **the whole account, across all its waves together**, not per wave:

| What | Free | Paid (account subscription) |
|---|---|---|
| Waves | 3 | no limit |
| People | 3 | the seats booked |
| Devices | 100 | no limit |

The terms are the same everywhere: in the account overview, in the error messages, in the API
(`/api/me`) and here.

## How it is counted

- **Waves:** every wave of the account.
- **People:** members plus **open invitations**. An open invitation **reserves a place** until it is
  accepted, withdrawn or expires. A person who is a member of several waves of the account counts
  **once**. An invitation to an address that is already a member or invited elsewhere in the account costs
  no further place; a new invitation to the same address in the same wave replaces the old one.
- **Devices:** every device once (by its machine key), however many waves of the account it is in.

An example: Anna owns two waves (place 1), Ben is a member of both (place 2), and an invitation to Chris is
open (place 3). The account holds **3 of 3 people**; a fourth invitation is turned away until one is
withdrawn or a person is removed.

## Where you see the usage

- **Account overview** (`/account#plan`): plan, waves, people and devices, each as *used of allowed*, with the
  counting rules. When the account is above a limit (after a cancellation), the **overhang** is shown below:
  which number is how far over and, per wave, which people and devices are in it.
- **When inviting** (the people list of a wave and the page after inviting): the current usage of people,
  with the explanation that it applies across all waves of the account, that open invitations reserve a
  place and that membership in several waves counts once. The hint appears only on hosted servers with a
  plan, never on a self-hosted one.

## When a limit is reached

Every refusal names the numbers as *used / allowed* and at least one next step. It concerns only **what is
new**; what is there stays and keeps working.

| Limit | Where you notice | Next step |
|---|---|---|
| Waves | creating a wave | delete a wave you no longer use, or subscribe (`/account#plan`) |
| People | inviting, adding a person with `wave-admin` | withdraw an invitation or remove a person, or subscribe |
| Devices | registering a device (`wave up`, key, browser approval) | remove a device (web app, or `wave logout <wave>` on the device), or subscribe |

On the command line (`wave up`, `wave login`), in the DSM interface and in the web app the same message
appears, in German or English. Programs read it from the JSON errors (`device_limit`, `people-limit`,
`wave-limit`, each with `limit` and `used`, see [`ACCOUNT-SUBSCRIPTIONS.en.md`](ACCOUNT-SUBSCRIPTIONS.en.md)).

## Upgrade and downgrade

- **Upgrade:** an account subscription applies to the whole account, at once. Waves and devices are then no
  longer limited, people follow the seats booked. Nothing changes about waves, keys, addresses or
  connections.
- **Downgrade:** before a cancellation is allowed, the site checks whether the account could stay as a free
  account as it is (`downgrade-check`, always against the **free** limits). If it does not fit, the
  **overhang** says by how much.
- **After the cancellation** the account is free again. **Nothing is deleted or stopped:** waves, people,
  invitations and devices stay and keep working; the limits only say no to what is new until the account is
  within them again. What is "too much" is for the owner to decide, not the system.

## Self-hosting is unlimited

A self-run control server (without `WAVE_BILLING_TOKEN`) knows no plan:

- `/api/me` has no `plan` (and no `limits`, `usage`, `overhang`);
- no wave, invitation or device is turned away because of a free limit;
- the interface shows no quota hints: no "Plan and usage" block, no people hint when inviting.

What limits it there is hardware and address space only. Operation: [`deployment/README.md`](../deployment/README.md).

**License.** Self-hosting is free, and the code is source-available. It is licensed under the
[Elastic License 2.0](../LICENSE) (ELv2, <https://www.elastic.co/licensing/elastic-license>): using,
modifying and redistributing it is allowed, including inside your own company. **Not allowed** is offering
wave-mesh to third parties as a hosted or managed service. Because of this restriction, ELv2 is **not an
OSI-approved open-source license**; "unlimited" means the absence of the free limits, not permission to run
a hosting offer of your own.

## For operators of hosted servers

| Setting | Default | Meaning |
|---|---|---|
| `WAVE_FREE_MAX_WAVES` | 3 | waves per free account (at least 1) |
| `WAVE_FREE_DEVICE_LIMIT` | 100 | devices per free account (at least 1) |
| People | 3, fixed | **no** environment variable; the constant `FREE_PEOPLE_LIMIT` in `billing/plan.ts` |
| `WAVE_SIGNUP_ENABLED` | off | sign-up page `/signup` (#147); only `true` or `1` turns it on. Hosted deployments set it, self-hosting leaves it off |
| `WAVE_SMTP_URL`, `WAVE_MAIL_FROM` | unset | outgoing mail (#150), `smtp://user:pass@host:587` or `smtps://host:465`, and the sender; the sign-up form with email and password exists only with them |

**Sign-up (`/signup`).** The operator of a hosted server can offer prospects a page that explains the free plan
(waves, people and devices, with the numbers of the server) and offers registration through the configured
OIDC providers and, where the server can send mail, with email and password (#150). The first login creates the
account, and the next stop is `/waves/new`. Only an account with a **confirmed** email address (`email_verified`)
can create a wave; the page says so. A password registration makes **no account until the link in the
confirmation mail is used** (once, within 24 hours); without `WAVE_SMTP_URL` the form is not there at all. An
address that already has an account gets the same answer and a mail saying so, never a merge. `WAVE_SIGNUP_ENABLED` is **off by
default**: `/signup` then answers 404, the login page shows no "Create account" link, and everything behaves as
before. Self-hosting leaves the switch off.

More, including `WAVE_FREE_IPV4_PREFIX_LENGTH` and `WAVE_FREE_BLOCKED_EMAIL_DOMAINS`:
[`ACCOUNT-SUBSCRIPTIONS.en.md`](ACCOUNT-SUBSCRIPTIONS.en.md).
