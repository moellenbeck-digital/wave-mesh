import { type Locale, type Messages, messagesFor } from "@wave/i18n";

/**
 * The texts of every page but the access page (see `./acl.ts`).
 *
 * Sentences with markup in them keep `{name}` holes and go through `rich()`;
 * everything with a number or a name that is plain text is a function, so the
 * German side can put it where German wants it.
 */

type Role = "owner" | "admin" | "member";

const en = {
  // ---- frame ----
  metaDescription: "Management for a self-hosted mesh VPN built on WireGuard.",
  signOut: "Sign out",
  signOutHelp: "How do I sign out completely?",
  language: "Language",
  footerTagline: "wave-mesh — a self-hosted mesh VPN built on WireGuard.",
  footerSigned: "Netmaps are delivered signed.",
  toOverview: "Back to overview",

  notFoundTitle: "Page not found",
  notFoundText: "This address does not belong to any page of this console.",

  errorTitle: "The control server is not answering",
  errorText:
    "The console could not load its data. The tunnel itself is unaffected: devices that are already connected stay connected.",
  errorRetry: "Try again",

  // ---- shared words ----
  never: "never",
  osUnknown: "Unknown",
  roleName: (role: Role) => ({ owner: "Owner", admin: "Administrator", member: "Member" })[role],
  /** The role inside a sentence: "as {role}". */
  asRole: (role: "admin" | "member"): string => (role === "admin" ? "an administrator" : "a member"),
  devices: (n: number) => (n === 1 ? "1 device" : `${n} devices`),
  people: (n: number) => (n === 1 ? "1 person" : `${n} people`),
  providerDev: "Developer login",
  continueWith: (provider: string) => `Continue with ${provider}`,
  or: "or",
  signIn: "Sign in",
  email: "Email",
  password: "Password",
  name: "Name",
  domain: "Domain",
  apply: "Apply",
  remove: "Remove",

  // ---- dashboard ----
  dashboardTitle: "Your network",
  chooseWave: "Choose wave",
  joined: "You are now in {wave}.",
  noWaveTitle: "No wave yet",
  inviteWaiting:
    "An invitation to {wave}{by} is waiting for you. Open the link you were sent — it is valid until {until}.",
  invitedBy: (name: string) => ` from ${name}`,
  noWaveText:
    "No network has been set up for this account yet. A wave is not created on its own — you choose the domain the device names live under when you create it.",
  createWave: "Create wave",
  noWaveBooked: "Ask the owner of a wave to invite you, or confirm your address and try again.",
  noWaveBookedTitle: "You cannot create a wave here",
  waveDenialTitle: (reason: string): string =>
    ({
      placeholder: "This account cannot create waves",
      "unverified-email": "Confirm your address first",
      "email-domain": "This address cannot start a free account",
      "wave-limit": "Free limit reached",
    })[reason] ?? "You cannot create a wave here",
  waveDenialBody: (reason: string, limit: number, used?: number): string =>
    ({
      placeholder:
        "Nobody has confirmed the address of this account yet. Open the link that was mailed to it first.",
      "unverified-email":
        "Waves can only be created with a confirmed email address. Sign in with a provider that confirms addresses, or set a password through the link mailed to you.",
      "email-domain":
        "Addresses of this domain cannot start a free account. Use another address, or subscribe.",
      "wave-limit": `A free account holds up to ${limit} waves across the account, and yours holds ${used ?? limit} of ${limit}. Next step: delete a wave you no longer use, or subscribe at {upgrade}.`,
    })[reason] ?? "Ask the owner of a wave to invite you.",

  // ---- login ----
  loginLead: "Your account is where you manage the devices in your wave.",
  loginInvalid: "Email or password is incorrect.",
  loginThrottled: "Too many attempts. Please try again later.",
  /** The link on the login page, shown only where sign-up is switched on (ticket #147). */
  createAccount: "Create account",

  // ---- sign-up ----
  signupTitle: "Start for free",
  signupLead: "Create an account and set up your first wave in a few minutes.",
  signupFreePlan: (waves: number, people: number, devices: number) =>
    `The free plan includes ${waves} waves, ${people} people and ${devices} devices across your account.`,
  signupHow:
    "Your first sign-in creates the account, and you land on the form for your first wave. Sign up with email and password below, or with one of the providers.",
  signupVerified:
    "Your email address has to be confirmed: by the link in the mail we send you, or by your provider (email_verified). Without a confirmed address you cannot create a wave.",
  signupWith: (provider: string) => `Sign up with ${provider}`,
  signupNothing:
    "Nobody can sign up here yet: this server has neither a mail server nor a sign-in provider configured.",
  signupPasswordHint: (n: number) =>
    `At least ${n} characters. We send a link to confirm the address; the account exists once you use it.`,
  signupSubmit: "Create account",
  /** The codes `/auth/signup` redirects back with, in the page's own wording; empty for one it does not know. */
  signupError: (code: string) =>
    (
      ({
        "invalid-email": "That does not look like an email address.",
        "password-too-short": "That password is too short.",
        "password-too-long": "That password is too long.",
        throttled: "Too many attempts. Please try again later.",
        "mail-failed": "The confirmation mail could not be sent. Try again later.",
      }) as Record<string, string>
    )[code] ?? "",
  signupSentTitle: "The mail is on its way",
  signupSentBody:
    "Open the link in it to confirm your address. It can take a few minutes, and it may be in the spam folder. The link works once.",
  signupConfirmTitle: "Confirm your address",
  signupConfirmBody: "One click creates your account.",
  signupConfirmButton: "Confirm and create account",
  signupConfirmedTitle: "Address confirmed",
  signupConfirmedBody: "Your account exists. Sign in to set up your first wave.",
  signupGoneTitle: "This link no longer works",
  signupGoneBody:
    "It was used already or has expired, or the address has an account by now. Sign in, or sign up again for a new link.",
  signupHaveAccount: "Already have an account?",
  // --- forgot password (ticket #159) ------------------------------------------
  forgotLink: "Forgot password",
  forgotTitle: "Forgot password",
  forgotLead:
    "Enter the email address of your account. If it has a password, we send a link to choose a new one.",
  forgotSubmit: "Send link",
  forgotSentTitle: "The mail is on its way",
  forgotSentBody:
    "If there is an account for this address, a mail with a link has been sent. It can take a few minutes, and it may be in the spam folder. The link works once and for 1 hour.",
  resetTitle: "Choose a new password",
  resetBody:
    "Choose a new password for your account. You will be signed out everywhere and sign in again afterwards.",
  resetButton: "Save password",
  resetGoneTitle: "This link no longer works",
  resetGoneBody: "It was used already or has expired, or a newer one replaced it. Ask for a new link.",
  resetAskAgain: "Ask for a new link",
  passwordChanged: "Password changed. Sign in with the new one.",
  resetPasswordHint: (n: number) => `At least ${n} characters.`,
  /** The codes `/auth/password/forgot` and `/auth/password/reset` redirect back with; empty for one it does not know. */
  forgotError: (code: string) =>
    (
      ({
        "invalid-email": "That does not look like an email address.",
        throttled: "Too many attempts. Please try again later.",
        "password-too-short": "That password is too short.",
        "password-too-long": "That password is too long.",
      }) as Record<string, string>
    )[code] ?? "",

  // ---- device approval ----
  chooseOne: (host: string) => `Add ${host}?`,
  chooseMany: (host: string) => `Which wave should ${host} join?`,
  chooseOneText: "It gets an address in the wave and is then visible to every device in it.",
  chooseManyText: "A device belongs to exactly one wave. To be in a second, it signs in there once more.",
  addDevice: "Add device",

  connectedHost: (host: string) => `${host} is connected`,
  connectedDevice: "Device is connected",
  connectedWave: "It now belongs to {wave}{ip}.",
  connectedIp: " and listens on {ip}",
  connectedNoWave: "The device has been added to your wave.",
  connectedClose: "You can close this window — the device connects on its own now.",

  expiredTitle: "Request expired",
  expiredText:
    "The link was only valid for a short while, so that an intercepted link cannot let a stranger's device into the network.",
  expiredRetry: "Start the sign-in on the device again:",
  expiredRetryApp: "In the wave-mesh app on a phone or tablet: tap Log in again.",

  // ---- invitations ----
  goneTitle: "This invitation is no longer valid",
  goneText:
    "It has been used, withdrawn or has expired. An invitation works once, and only for the address it was sent to.",
  goneAsk:
    "Ask someone in the wave for a new one — invitations are created by the owner and the administrators.",

  joinWrongAddress: "This invitation belongs to a different address than the one you are signed in with.",
  joinUnverified:
    "The sign-in provider does not confirm your address. An unconfirmed address cannot accept an invitation.",
  joinGone: "This invitation has been used, withdrawn or has expired.",
  joinTitle: (wave: string) => `Invitation to ${wave}`,
  joinLead: "For {email}, as {role}{by}. Valid until {until}.",
  joinBy: (name: string) => `, from ${name}`,
  signedInAs: "You are signed in as {who}.",
  join: "Join",
  signOutToAccept: (email: string) => `Sign out and sign back in as ${email} to accept the invitation.`,
  hasAccount:
    "There is already an account for this address. Sign in with it — the invitation is accepted along the way.",
  passwordFor: (email: string) => `Password for ${email}`,
  minChars: "At least 12 characters.",
  createAndJoin: "Create account and join",

  invitedTitle: (email: string) => `${email} is invited`,
  invitedCreated: "Invitation created",
  invitedAs: "As {role} in {wave}. ",
  invitedShare: "Pass this link on — no email is sent. It works once, and only for the invited address.",
  invitedNoLink: "The link is missing from the address. Create the invitation again.",
  invitedPending: "Until someone joins, the invitation stays in the people list and can be withdrawn there.",

  // ---- creating a wave ----
  newLead: "A wave is your network: every device in it gets a fixed address and a name under your domain.",
  newInviteWaiting:
    "An invitation to {wave}{by} is waiting for you. Open the link you were sent — you do not need a wave of your own for it.",
  nameHint: "Lowercase letters, digits and hyphens.",
  // Same wording as `domainFormat` in apps/control/src/routes/messages.ts, which the
  // server shows after a refused domain: keep the two in step.
  domainFormat:
    "Format: at least two labels, only a–z, 0–9 and hyphens, no scheme such as https://, no trailing dot. Example: my-company.example.com",
  domainHint:
    "Devices will then be called {pattern}. Keep the suggestion if you have no domain of your own — you can change it later, but that renames every device in the wave.",

  // ---- wave card ----
  rename: "Rename",
  renameHint:
    "Lowercase letters, digits and hyphens; umlauts and spaces are replaced. The devices notice nothing — their names hang off the domain, not the wave's name.",
  changeDomain: "Change domain",
  domainChangeHint:
    "Every device is then called {pattern}. Connected devices pick that up with the next netmap; a certificate is only possible for a domain you own.",
  accessLink: "Access: who reaches whom →",
  certificatesLink: "Certificates: DNS provider →",
  devicesTitle: "Devices",
  wavePaused:
    "This wave is paused because its subscription is not active. Devices stay enrolled but reach nobody until it is again.",
  waveEnded: (deleteAfter: string | null | undefined) =>
    deleteAfter
      ? `The subscription for this wave has ended. It is paused and will be deleted on ${new Intl.DateTimeFormat("en-GB", { dateStyle: "long" }).format(new Date(deleteAfter))}.`
      : "The subscription for this wave has ended. It is paused and will be deleted soon.",
  addPhone: "Add a phone",
  addPhoneCode: "QR code that opens the wave-mesh app with this server",
  addPhoneHint:
    "Scan it with the iPhone camera: the wave-mesh app opens with this server filled in. Approve the device here afterwards, as always.",
  addPhoneManual: "Or type this address into the app:",
  peopleTitle: "People",
  cleanupTitle: "Clean up",
  deleteWave: "Delete wave",
  ownerCannotLeave:
    "As the owner you cannot leave this wave, and ownership cannot be handed over yet. For you, leaving means deleting the wave.",
  leaveWave: "Leave wave",
  leaveWaveHint:
    "You leave this wave, and your devices in it leave with you. Coming back takes a new invitation.",
  leaveWaveConfirm: "Leave this wave",
  renameDevice: "Rename",
  newDeviceName: "New name",
  renameDeviceHint:
    "Lower case letters, digits and hyphens; anything else becomes a hyphen. A name already taken gets a number. Every device in the wave learns the new name.",
  deleteConfirm: "Type {name} to confirm",
  deleteForGood: "Delete for good",
  deleteHint:
    "Takes {devices} and {people} with it. Every device loses its sign-in and has to be approved again, and {suffix} is free again afterwards. This cannot be undone.",
  connectedCount: (online: number, total: number) =>
    `${online} of ${total} ${total === 1 ? "device" : "devices"} connected`,

  // ---- people ----
  memberSince: (date: string) => `member since ${date}`,
  invitedNotJoined: "invited, not joined yet",
  until: (date: string) => `until ${date}`,
  withdraw: "Withdraw",
  inviteSomeone: "Invite someone",
  role: "Role",
  roleOf: (who: string) => `Role of ${who}`,
  saveRole: "Save",
  invite: "Invite",
  inviteHint:
    "The invitation is handed out as a link — no email is sent. Whoever is removed loses their devices in this wave.",

  // ---- devices ----
  ephemeral: "ephemeral",
  notApproved: "not approved",
  services: (n: number) => (n === 1 ? "1 service" : `${n} services`),
  updateChannel: (channel: string) => `Update channel: ${channel}`,
  versionUnknown: "Version unknown",
  online: "connected",
  noDevices: "No device has signed in to this wave yet.",
  removeDeviceHint:
    "A removed device loses access at once — the others drop it from their netmap, and it has to be approved again with {command}.",
  feedOffline:
    "No live connection — the devices are shown as they were when the page loaded. The next attempt is under way.",
} satisfies Messages;

const de: typeof en = {
  metaDescription: "Verwaltung für ein selbst gehostetes Mesh-VPN auf WireGuard-Basis.",
  signOut: "Abmelden",
  signOutHelp: "Wie melde ich mich komplett ab?",
  language: "Sprache",
  footerTagline: "wave-mesh — selbst gehostetes Mesh-VPN auf WireGuard-Basis.",
  footerSigned: "Netzkarten werden signiert ausgeliefert.",
  toOverview: "Zur Übersicht",

  notFoundTitle: "Seite nicht gefunden",
  notFoundText: "Diese Adresse gehört zu keiner Seite dieser Verwaltung.",

  errorTitle: "Der Control-Server antwortet nicht",
  errorText:
    "Die Oberfläche konnte ihre Daten nicht laden. Der Tunnel selbst ist davon unberührt: Geräte, die bereits verbunden sind, bleiben es.",
  errorRetry: "Erneut versuchen",

  never: "noch nie",
  osUnknown: "Unbekannt",
  roleName: (role) => ({ owner: "Eigentümer", admin: "Administrator", member: "Mitglied" })[role],
  asRole: (role) => (role === "admin" ? "Administrator" : "Mitglied"),
  devices: (n) => (n === 1 ? "1 Gerät" : `${n} Geräte`),
  people: (n) => (n === 1 ? "1 Person" : `${n} Personen`),
  providerDev: "Entwickler-Login",
  continueWith: (provider) => `Weiter mit ${provider}`,
  or: "oder",
  signIn: "Anmelden",
  email: "E-Mail",
  password: "Passwort",
  name: "Name",
  domain: "Domain",
  apply: "Übernehmen",
  remove: "Entfernen",

  dashboardTitle: "Dein Netz",
  chooseWave: "Wave auswählen",
  joined: "Du bist jetzt in {wave}.",
  noWaveTitle: "Noch kein Wave",
  inviteWaiting:
    "Es wartet eine Einladung in {wave}{by}. Öffne den Link, den du bekommen hast — er gilt bis {until}.",
  invitedBy: (name) => ` von ${name}`,
  noWaveText:
    "Für dieses Konto ist noch kein Netz eingerichtet. Ein Wave entsteht nicht von selbst — die Domain, unter der die Gerätenamen hängen, wählst du beim Anlegen.",
  createWave: "Wave anlegen",
  noWaveBooked:
    "Lass dich vom Eigentümer eines Waves einladen oder bestätige deine Adresse und versuche es dann erneut.",
  noWaveBookedTitle: "Du kannst hier keinen Wave anlegen",
  waveDenialTitle: (reason) =>
    ({
      placeholder: "Dieses Konto kann keine Waves anlegen",
      "unverified-email": "Bestätige zuerst deine Adresse",
      "email-domain": "Mit dieser Adresse geht kein kostenloses Konto",
      "wave-limit": "Kostenlose Grenze erreicht",
    })[reason] ?? "Du kannst hier keinen Wave anlegen",
  waveDenialBody: (reason, limit, used) =>
    ({
      placeholder:
        "Die Adresse dieses Kontos hat noch niemand bestätigt. Öffne zuerst den Link, der ihr geschickt wurde.",
      "unverified-email":
        "Waves legst du nur mit einer bestätigten E-Mail-Adresse an. Melde dich bei einem Anbieter an, der Adressen bestätigt, oder lege über den Link, der dir geschickt wurde, ein Passwort fest.",
      "email-domain":
        "Adressen dieser Domain können kein kostenloses Konto starten. Nimm eine andere Adresse oder schließe ein Abo ab.",
      "wave-limit": `Ein kostenloses Konto fasst höchstens ${limit} Waves, und deins hält ${used ?? limit} von ${limit}. Nächster Schritt: Lösche einen Wave, den du nicht mehr brauchst, oder schließe ein Abo ab unter {upgrade}.`,
    })[reason] ?? "Lass dich vom Eigentümer eines Waves einladen.",

  loginLead: "Mit deinem Konto verwaltest du die Geräte in deinem Wave.",
  loginInvalid: "E-Mail oder Passwort stimmt nicht.",
  loginThrottled: "Zu viele Versuche. Bitte später erneut probieren.",
  /** Der Link auf der Anmeldeseite, nur wo die Registrierung eingeschaltet ist (Ticket #147). */
  createAccount: "Konto erstellen",

  // ---- Registrierung ----
  signupTitle: "Gratis starten",
  signupLead: "Erstelle ein Konto und richte in wenigen Minuten deinen ersten Wave ein.",
  signupFreePlan: (waves, people, devices) =>
    `Der Gratis-Tarif umfasst ${waves} Waves, ${people} Personen und ${devices} Geräte im ganzen Konto.`,
  signupHow:
    "Der erste Login legt das Konto an, danach landest du im Formular für deinen ersten Wave. Registriere dich unten mit E-Mail und Passwort oder über einen der Anbieter.",
  signupVerified:
    "Deine E-Mail-Adresse muss bestätigt werden: über den Link in der Mail, die wir dir schicken, oder durch deinen Anbieter (email_verified). Ohne bestätigte Adresse kannst du keinen Wave anlegen.",
  signupWith: (provider) => `Mit ${provider} registrieren`,
  signupNothing:
    "Hier kann sich noch niemand registrieren: Auf diesem Server sind weder ein Mailserver noch ein Anmeldeanbieter eingerichtet.",
  signupPasswordHint: (n) =>
    `Mindestens ${n} Zeichen. Wir schicken einen Link zur Bestätigung der Adresse; das Konto entsteht erst, wenn du ihn benutzt.`,
  signupSubmit: "Konto erstellen",
  signupError: (code) =>
    (
      ({
        "invalid-email": "Das sieht nicht nach einer E-Mail-Adresse aus.",
        "password-too-short": "Das Passwort ist zu kurz.",
        "password-too-long": "Das Passwort ist zu lang.",
        throttled: "Zu viele Versuche. Bitte später erneut probieren.",
        "mail-failed": "Die Bestätigungsmail ließ sich nicht senden. Versuch es später noch einmal.",
      }) as Record<string, string>
    )[code] ?? "",
  signupSentTitle: "Die Mail ist unterwegs",
  signupSentBody:
    "Öffne den Link darin, um deine Adresse zu bestätigen. Das kann ein paar Minuten dauern, und die Mail kann im Spam-Ordner liegen. Der Link gilt einmal.",
  signupConfirmTitle: "Adresse bestätigen",
  signupConfirmBody: "Ein Klick legt dein Konto an.",
  signupConfirmButton: "Bestätigen und Konto anlegen",
  signupConfirmedTitle: "Adresse bestätigt",
  signupConfirmedBody: "Dein Konto besteht. Melde dich an, um deinen ersten Wave einzurichten.",
  signupGoneTitle: "Dieser Link gilt nicht mehr",
  signupGoneBody:
    "Er wurde schon benutzt oder ist abgelaufen, oder die Adresse hat inzwischen ein Konto. Melde dich an, oder registriere dich noch einmal für einen neuen Link.",
  signupHaveAccount: "Du hast schon ein Konto?",
  // --- forgot password (ticket #159) ------------------------------------------
  forgotLink: "Passwort vergessen",
  forgotTitle: "Passwort vergessen",
  forgotLead:
    "Gib die E-Mail-Adresse deines Kontos ein. Hat es ein Passwort, schicken wir dir einen Link, mit dem du ein neues wählst.",
  forgotSubmit: "Link senden",
  forgotSentTitle: "Die Mail ist unterwegs",
  forgotSentBody:
    "Falls es ein Konto zu dieser Adresse gibt, wurde eine Mail mit einem Link gesendet. Das kann ein paar Minuten dauern, und sie kann im Spam-Ordner landen. Der Link gilt einmal und 1 Stunde.",
  resetTitle: "Neues Passwort wählen",
  resetBody:
    "Wähle ein neues Passwort für dein Konto. Du wirst überall abgemeldet und meldest dich danach neu an.",
  resetButton: "Passwort speichern",
  resetGoneTitle: "Dieser Link gilt nicht mehr",
  resetGoneBody:
    "Er wurde schon benutzt, ist abgelaufen oder durch einen neueren ersetzt. Fordere einen neuen Link an.",
  resetAskAgain: "Neuen Link anfordern",
  passwordChanged: "Passwort geändert. Melde dich mit dem neuen an.",
  resetPasswordHint: (n) => `Mindestens ${n} Zeichen.`,
  /** Die Codes, mit denen `/auth/password/forgot` und `/auth/password/reset` zurückleiten; leer bei einem unbekannten. */
  forgotError: (code) =>
    (
      ({
        "invalid-email": "Das sieht nicht wie eine E-Mail-Adresse aus.",
        throttled: "Zu viele Versuche. Bitte später erneut probieren.",
        "password-too-short": "Dieses Passwort ist zu kurz.",
        "password-too-long": "Dieses Passwort ist zu lang.",
      }) as Record<string, string>
    )[code] ?? "",

  chooseOne: (host) => `${host} aufnehmen?`,
  chooseMany: (host) => `In welchen Wave soll ${host}?`,
  chooseOneText: "Es bekommt eine Adresse im Wave und ist danach für jedes Gerät darin sichtbar.",
  chooseManyText:
    "Ein Gerät gehört zu genau einem Wave. Für einen zweiten meldet es sich dort noch einmal an.",
  addDevice: "Gerät hinzufügen",

  connectedHost: (host) => `${host} ist verbunden`,
  connectedDevice: "Gerät ist verbunden",
  connectedWave: "Es gehört jetzt zu {wave}{ip}.",
  connectedIp: " und hört auf {ip}",
  connectedNoWave: "Das Gerät wurde deinem Wave hinzugefügt.",
  connectedClose: "Dieses Fenster kann zu — das Gerät verbindet sich jetzt von selbst.",

  expiredTitle: "Anfrage abgelaufen",
  expiredText: "Der Link war nur kurz gültig, damit ein abgefangener Link kein fremdes Gerät ins Netz lässt.",
  expiredRetry: "Starte die Anmeldung auf dem Gerät noch einmal:",
  expiredRetryApp: "In der wave-mesh-App auf Telefon oder Tablet: noch einmal auf Anmelden tippen.",

  goneTitle: "Diese Einladung gilt nicht mehr",
  goneText:
    "Sie wurde schon benutzt, zurückgezogen oder ist abgelaufen. Eine Einladung gilt einmal und nur für die Adresse, an die sie ging.",
  goneAsk:
    "Bitte jemanden aus dem Wave um eine neue — Einladungen erstellen der Eigentümer und die Administratoren.",

  joinWrongAddress: "Diese Einladung gehört zu einer anderen Adresse als der, mit der du angemeldet bist.",
  joinUnverified:
    "Der Anmeldedienst bestätigt deine Adresse nicht. Eine unbestätigte Adresse kann keine Einladung annehmen.",
  joinGone: "Diese Einladung wurde schon benutzt, zurückgezogen oder ist abgelaufen.",
  joinTitle: (wave) => `Einladung in ${wave}`,
  joinLead: "Für {email}, als {role}{by}. Gültig bis {until}.",
  joinBy: (name) => `, von ${name}`,
  signedInAs: "Du bist als {who} angemeldet.",
  join: "Beitreten",
  signOutToAccept: (email) => `Melde dich ab und mit ${email} wieder an, um die Einladung anzunehmen.`,
  hasAccount:
    "Für diese Adresse gibt es schon ein Konto. Melde dich damit an — die Einladung wird dabei angenommen.",
  passwordFor: (email) => `Passwort für ${email}`,
  minChars: "Mindestens 12 Zeichen.",
  createAndJoin: "Konto anlegen und beitreten",

  invitedTitle: (email) => `${email} ist eingeladen`,
  invitedCreated: "Einladung erstellt",
  invitedAs: "Als {role} in {wave}. ",
  invitedShare:
    "Schicke diesen Link weiter — es wird keine E-Mail verschickt. Er gilt einmal und nur für die eingeladene Adresse.",
  invitedNoLink: "Der Link fehlt in der Adresse. Lege die Einladung noch einmal an.",
  invitedPending:
    "Solange niemand beigetreten ist, steht die Einladung in der Personenliste und kann dort zurückgezogen werden.",

  newLead:
    "Ein Wave ist dein Netz: jedes Gerät darin bekommt eine feste Adresse und einen Namen unter deiner Domain.",
  newInviteWaiting:
    "Es wartet eine Einladung in {wave}{by}. Öffne den Link, den du bekommen hast — ein eigener Wave ist dafür nicht nötig.",
  nameHint: "Kleinbuchstaben, Ziffern und Bindestriche.",
  // Gleicher Wortlaut wie `domainFormat` in apps/control/src/routes/messages.ts, das der
  // Server nach einer abgelehnten Domain zeigt: beide Stellen gemeinsam pflegen.
  domainFormat:
    "Format: mindestens zwei Labels, nur a–z, 0–9 und Bindestrich, kein Schema wie https://, kein abschließender Punkt. Beispiel: meine-firma.example.com",
  domainHint:
    "Geräte heißen dann {pattern}. Behalte den Vorschlag, wenn du keine eigene Domain hast — ändern kannst du ihn später, das benennt allerdings jedes Gerät im Wave um.",

  rename: "Namen ändern",
  renameHint:
    "Kleinbuchstaben, Ziffern und Bindestriche; Umlaute und Leerzeichen werden ersetzt. Die Geräte merken davon nichts — ihre Namen hängen an der Domain, nicht am Wave-Namen.",
  changeDomain: "Domain ändern",
  domainChangeHint:
    "Danach heißt jedes Gerät {pattern}. Verbundene Geräte übernehmen das mit der nächsten Netzkarte; ein Zertifikat gibt es nur für eine Domain, die dir gehört.",
  accessLink: "Zugriff: wer wen erreicht →",
  certificatesLink: "Zertifikate: DNS-Provider →",
  devicesTitle: "Geräte",
  wavePaused:
    "Dieser Wave ist pausiert, weil sein Abo nicht aktiv ist. Die Geräte bleiben angemeldet, erreichen aber niemanden, bis es wieder aktiv ist.",
  waveEnded: (deleteAfter) =>
    deleteAfter
      ? `Das Abo für diesen Wave ist beendet. Er ist pausiert und wird am ${new Intl.DateTimeFormat("de-DE", { dateStyle: "long" }).format(new Date(deleteAfter))} gelöscht.`
      : "Das Abo für diesen Wave ist beendet. Er ist pausiert und wird bald gelöscht.",
  addPhone: "Telefon hinzufügen",
  addPhoneCode: "QR-Code, der die wave-mesh-App mit diesem Server öffnet",
  addPhoneHint:
    "Mit der iPhone-Kamera scannen: Die wave-mesh-App öffnet sich mit diesem Server. Danach das Gerät wie gewohnt hier freigeben.",
  addPhoneManual: "Oder diese Adresse in der App eingeben:",
  peopleTitle: "Personen",
  cleanupTitle: "Aufräumen",
  deleteWave: "Wave löschen",
  ownerCannotLeave:
    "Als Eigentümer kannst du diesen Wave nicht verlassen, und die Eigentümerschaft lässt sich noch nicht übertragen. Für dich heißt Verlassen: den Wave löschen.",
  leaveWave: "Wave verlassen",
  leaveWaveHint:
    "Du verlässt diesen Wave, und deine Geräte darin gehen mit. Zurück geht es nur mit einer neuen Einladung.",
  leaveWaveConfirm: "Diesen Wave verlassen",
  renameDevice: "Umbenennen",
  newDeviceName: "Neuer Name",
  renameDeviceHint:
    "Kleinbuchstaben, Ziffern und Bindestriche; alles andere wird zum Bindestrich. Ein vergebener Name bekommt eine Nummer. Alle Geräte im Wave lernen den neuen Namen.",
  deleteConfirm: "Zum Bestätigen {name} eintippen",
  deleteForGood: "Endgültig löschen",
  deleteHint:
    "Nimmt {devices} und {people} mit. Jedes Gerät verliert seine Anmeldung und muss neu freigegeben werden, und {suffix} ist danach wieder frei. Rückgängig geht das nicht.",
  connectedCount: (online, total) => `${online} von ${total} ${total === 1 ? "Gerät" : "Geräten"} verbunden`,

  memberSince: (date) => `dabei seit ${date}`,
  invitedNotJoined: "eingeladen, noch nicht beigetreten",
  until: (date) => `bis ${date}`,
  withdraw: "Zurückziehen",
  inviteSomeone: "Jemanden einladen",
  role: "Rolle",
  roleOf: (who) => `Rolle von ${who}`,
  saveRole: "Speichern",
  invite: "Einladen",
  inviteHint:
    "Die Einladung wird als Link ausgegeben — es wird keine E-Mail verschickt. Wer entfernt wird, verliert seine Geräte in diesem Wave.",

  ephemeral: "flüchtig",
  notApproved: "nicht freigegeben",
  services: (n) => (n === 1 ? "1 Dienst" : `${n} Dienste`),
  updateChannel: (channel) => `Update-Kanal: ${channel}`,
  versionUnknown: "Version unbekannt",
  online: "verbunden",
  noDevices: "In diesem Wave ist noch kein Gerät angemeldet.",
  removeDeviceHint:
    "Ein entferntes Gerät verliert den Zugang sofort — für die anderen ist es aus der Netzkarte, und es selbst muss mit {command} neu freigegeben werden.",
  feedOffline:
    "Keine Live-Verbindung — die Geräte stehen so da, wie sie beim Laden der Seite waren. Der nächste Versuch läuft.",
};

export type AppMessages = typeof en;

export const appMessages = (locale: Locale): AppMessages => messagesFor({ en, de }, locale);

/**
 * A sign-in provider as the buttons name it. Brands keep their own name; an
 * OIDC provider is called what its operator called it ("Pocket ID"), and the
 * development login is the one name that is ours to translate.
 */
export const providerName = (provider: { id: string; label: string | null }, t: AppMessages): string =>
  provider.id === "dev"
    ? t.providerDev
    : provider.id === "google"
      ? "Google"
      : (provider.label ?? provider.id);
