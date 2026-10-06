import { type Locale, type Messages, messagesFor } from "@wave/i18n";
import type { Kind } from "@/components/acl-graph/model";

/**
 * The texts of the access page: the policy graph, its side panel and the JSON
 * editor beside it. Selectors (`tag:nas`, `user:…`), port specs and JSON keys
 * are the policy's own language and stay as they are in both catalogs.
 *
 * What the control server says about a draft -- errors, warnings, the words
 * describing a device's ports -- arrives already in the reader's language,
 * since it reads the same cookie, and is shown as it comes.
 */

const en = {
  // ---- page ----
  back: "← Overview",
  title: (wave: string) => `Access in ${wave}`,
  policyActive: (version: number, date: string) =>
    `Policy version ${version} applies, set ${date}. Only what a rule names is allowed.`,
  noPolicy: "There is no policy: every device reaches every other, on all ports.",
  reachTitle: "Who reaches whom",
  editJson: "Edit as JSON",
  jsonHelp:
    "Sources and destinations: {selectors}, and as a destination also {svc}. Ports: {p1}, {p2} or {p3}. Tags are not part of it; they belong to the device.",
  unenforced: "Limited only by the netmap, not on the ports:",
  historyTitle: "History",
  historyEmpty: "Nothing recorded yet.",

  // ---- JSON editor ----
  exampleUser: "me@example.com",
  invalidJson: (message: string) => `Not valid JSON: ${message}`,
  refused: "The server refused.",
  confirmRemove: "Remove the policy? Every device will reach every other again.",
  policyLabel: "Policy (JSON)",
  hint: (text: string) => `Note: ${text}`,
  applied: "Applied. Connected devices already have the new netmap.",
  save: "Save",
  removePolicy: "Remove policy",

  // ---- graph toolbar and messages ----
  undone: "Undone",
  svcOnlyTarget: "A service is only ever a destination, never a source",
  edgeExists: "This connection already exists",
  created: (id: string, kind: "group" | "tag") =>
    `${id} created — now add ${kind === "tag" ? "devices" : "members"}`,
  refusedShort: "refused",
  anySubtitle: "all devices and services",
  allServicesSubtitle: "all services, future ones too",
  noSuchService: "no such service",
  noDevices: "no devices",
  someDevices: (n: number, names: string) => `${n} devices: ${names}`,
  addGroup: "Add group",
  addTag: "Add tag",
  undo: "Undo",
  badgeMesh: "No policy · full mesh",
  badgeNothing: "Policy · nothing allowed",
  badgeRules: (n: number) => `Policy · ${n} ${n === 1 ? "rule" : "rules"}`,
  confirmFirst:
    "The first arrow switches the policy on. From then on only {pair} applies; everything else is blocked.",
  createRule: "Create rule",
  cancel: "Cancel",
  meshBanner:
    "Without a policy every device reaches every other, on all ports — the dashed lines. Draw the first arrow: from then on only what an arrow allows applies.",
  tapTarget: "Now tap the destination",
  legendArrow: "Arrow: who may {start} a connection. Replies and ICMP always come back.",
  legendStart: "start",
  legendDashed: "Dashed cards (roles, *) come about by themselves; groups and tags are yours to create.",
  savingRemoves: "Saving removes the policy — afterwards every device reaches every other again.",
  unsaved: "Unsaved changes. The devices notice nothing until you save.",
  discard: "Discard",
  saved: "Saved. Connected devices already have the new netmap.",
  reachDraft: "Who reaches whom (draft)",
  previewFailed: "The server did not evaluate the draft. Reloading usually helps.",
  fullMesh: "Every device reaches every other, on all ports.",
  evaluating: "Evaluating …",
  nobody: "Nobody reaches anybody. Ping and replies to your own connections still get through.",
  cutOff: (names: string) => `Cut off: ${names}`,

  // ---- graph cards ----
  graphLabel: "Graph of the access rules",
  kindLabel: (kind: Kind) =>
    ({ user: "USER", group: "GROUP", role: "ROLE", any: "ALL", tag: "TAG", svc: "SERVICE" })[kind],
  allPorts: "all ports",
  anyCard: "* all",

  // ---- side panel ----
  kindTitle: (kind: Kind) =>
    ({ user: "Member", role: "Role", any: "All", svc: "Service", group: "Group", tag: "Tag" })[kind],
  portInvalid: (port: string) =>
    `“${port}” is not a port. Allowed: *, 22, 5000-5001, optionally with tcp: or udp: in front.`,
  connection: "Connection",
  edgeNote: (src: string, dst: string, limited: boolean) =>
    `${src} may start connections to ${dst}${limited ? " — only on these ports." : ", on all ports."}`,
  ports: "Ports",
  removeItem: (item: string) => `Remove ${item}`,
  portPlaceholder: "e.g. 443 or tcp:5000-5001",
  addPort: "Add port",
  add: "Add",
  portsNote: "Without ports the edge applies to all of them. Ping and path MTU discovery always get through.",
  viewReverse: "View the reverse direction",
  allowReverse: (dst: string, src: string) => `Also allow ${dst} → ${src}`,
  removeConnection: "Remove connection",
  nodeUser:
    "All untagged devices of this member. A tagged device no longer counts as theirs, only as its tags.",
  nodeRole:
    "All untagged devices of the members with this role. If someone changes role, their devices move with them.",
  nodeAny:
    "Every device in the wave, tagged or not — and as a destination every service too. New devices belong to it at once.",
  nodeSvc: "Reported by a connector. A service is only ever the destination of a rule.",
  nodeAllServices:
    "Every service in the wave, but no device. Services a connector reports later belong to it at once.",
  notMember: "This address is not a member of the wave. The rule reaches nobody.",
  address: "Address",
  covers: "Reaches",
  edgeCounts: (out: number, into: number) =>
    `${out} outgoing, ${into} incoming ${into === 1 ? "connection" : "connections"}.`,
  coversNone: "Currently reaches no device.",

  groupNote: "A group gathers members. It reaches their untagged devices, as user: would.",
  members: "Members",
  notAMember: "not a member",
  groupEmpty: "Empty so far. An empty group reaches nobody.",
  chooseMember: "Choose member",
  groupDevicesNote: "Single devices are bundled by a tag, not a group.",
  groupNoPolicy: "A group is part of the policy. As long as there is none, it is not saved.",
  deleteGroup: (edges: number) =>
    `Delete group${edges > 0 ? ` (with ${edges} ${edges === 1 ? "connection" : "connections"})` : ""}`,

  tagNote:
    "To the policy a tagged device is only its tags: {user}, {group} and {role} no longer reach it, only {tag} and {any}.",
  devices: "Devices",
  tagEmpty: "Empty so far. A tag without devices reaches nobody.",
  chooseDevice: "Choose device",
  noOwner: "no owner",
  tagCountsNote: "Beside each device is what it counts as right now: its owner or its other tags.",
  tagUnsaved: "A tag that no device wears and no rule names is not saved.",
  deleteTag: (edges: number) =>
    `Delete tag${edges > 0 ? ` (with ${edges} ${edges === 1 ? "connection" : "connections"})` : ""}`,

  newTag: "New tag",
  newGroup: "New group",
  createTagNote: "A tag gathers devices, whoever they belong to. Devices are added in the next step.",
  createGroupNote:
    "A group gathers members, so that one rule means all of them at once. Members are added in the next step.",
  nameRule: "Lowercase letters, digits and -, no - at the start, at most 63 characters.",
  exists: (id: string) => `${id} already exists.`,
  name: "Name",
  tagPlaceholder: "printer",
  groupPlaceholder: "family",
  create: "Create",

  howTo: "How it works",
  help1:
    "Drag from the {dot} on one card onto another. On a phone: tap the dot, then the destination. The first arrow switches the policy on — from then on only what an arrow allows applies.",
  help2: "Tap an edge and enter ports if not all of them are meant.",
  help3: "{addGroup} for members, {addTag} for devices — then tap the card and fill it.",
  help4: "Save. Until then nothing changes on the devices.",
  help5: "Cards can be moved. {del} deletes the selected edge, {esc} cancels.",
  deleteKey: "Del",
} satisfies Messages;

const de: typeof en = {
  back: "← Übersicht",
  title: (wave) => `Zugriff in ${wave}`,
  policyActive: (version, date) =>
    `Es gilt Policy-Version ${version}, gesetzt ${date}. Erlaubt ist nur, was eine Regel nennt.`,
  noPolicy: "Es gibt keine Policy: jedes Gerät erreicht jedes andere, auf allen Ports.",
  reachTitle: "Wer wen erreicht",
  editJson: "Als JSON bearbeiten",
  jsonHelp:
    "Quellen und Ziele: {selectors}, als Ziel auch {svc}. Ports: {p1}, {p2} oder {p3}. Tags stehen nicht darin, sie hängen am Gerät.",
  unenforced: "Nur über die Netzkarte begrenzt, nicht in den Ports:",
  historyTitle: "Verlauf",
  historyEmpty: "Noch nichts aufgezeichnet.",

  exampleUser: "ich@example.com",
  invalidJson: (message) => `Kein gültiges JSON: ${message}`,
  refused: "Der Server hat abgelehnt.",
  confirmRemove: "Policy entfernen? Danach erreicht wieder jedes Gerät jedes andere.",
  policyLabel: "Policy (JSON)",
  hint: (text) => `Hinweis: ${text}`,
  applied: "Übernommen. Verbundene Geräte haben die neue Netzkarte schon.",
  save: "Speichern",
  removePolicy: "Policy entfernen",

  undone: "Rückgängig gemacht",
  svcOnlyTarget: "Ein Dienst ist nur Ziel, nie Quelle",
  edgeExists: "Diese Verbindung gibt es schon",
  created: (id, kind) => `${id} angelegt — jetzt ${kind === "tag" ? "Geräte" : "Mitglieder"} hinzufügen`,
  refusedShort: "abgelehnt",
  anySubtitle: "alle Geräte und Dienste",
  allServicesSubtitle: "alle Dienste, auch künftige",
  noSuchService: "kein solcher Dienst",
  noDevices: "keine Geräte",
  someDevices: (n, names) => `${n} Geräte: ${names}`,
  addGroup: "Gruppe hinzufügen",
  addTag: "Tag hinzufügen",
  undo: "Rückgängig",
  badgeMesh: "Keine Policy · voller Mesh",
  badgeNothing: "Policy · nichts erlaubt",
  badgeRules: (n) => `Policy · ${n} ${n === 1 ? "Regel" : "Regeln"}`,
  confirmFirst:
    "Der erste Pfeil schaltet die Policy ein. Dann gilt nur noch {pair}, alles andere ist gesperrt.",
  createRule: "Regel anlegen",
  cancel: "Abbrechen",
  meshBanner:
    "Ohne Policy erreicht jedes Gerät jedes andere, auf allen Ports — die gestrichelten Linien. Zieh den ersten Pfeil: dann gilt nur noch, was ein Pfeil erlaubt.",
  tapTarget: "Jetzt das Ziel antippen",
  legendArrow: "Pfeil: wer eine Verbindung {start} darf. Antworten und ICMP gehen immer zurück.",
  legendStart: "beginnen",
  legendDashed: "Gestrichelte Karten (Rollen, *) ergeben sich von selbst, Gruppen und Tags legst du an.",
  savingRemoves: "Speichern entfernt die Policy — danach erreicht wieder jedes Gerät jedes andere.",
  unsaved: "Ungespeicherte Änderungen. Die Geräte merken davon erst etwas beim Speichern.",
  discard: "Verwerfen",
  saved: "Gespeichert. Verbundene Geräte haben die neue Netzkarte schon.",
  reachDraft: "Wer wen erreicht (Entwurf)",
  previewFailed: "Der Server hat den Entwurf nicht ausgewertet. Neu laden hilft meist.",
  fullMesh: "Jedes Gerät erreicht jedes andere, auf allen Ports.",
  evaluating: "Wird ausgewertet …",
  nobody: "Niemand erreicht jemanden. Ping und Antworten auf eigene Verbindungen gehen weiter.",
  cutOff: (names) => `Abgeschnitten: ${names}`,

  graphLabel: "Graph der Zugriffsregeln",
  kindLabel: (kind) =>
    ({ user: "BENUTZER", group: "GRUPPE", role: "ROLLE", any: "ALLE", tag: "TAG", svc: "DIENST" })[kind],
  allPorts: "alle Ports",
  anyCard: "* alle",

  kindTitle: (kind) =>
    ({ user: "Mitglied", role: "Rolle", any: "Alle", svc: "Dienst", group: "Gruppe", tag: "Tag" })[kind],
  portInvalid: (port) => `„${port}“ ist kein Port. Erlaubt: *, 22, 5000-5001, mit tcp: oder udp: davor.`,
  connection: "Verbindung",
  edgeNote: (src, dst, limited) =>
    `${src} darf Verbindungen zu ${dst} beginnen${limited ? " — nur auf diesen Ports." : ", auf allen Ports."}`,
  ports: "Ports",
  removeItem: (item) => `${item} entfernen`,
  portPlaceholder: "z. B. 443 oder tcp:5000-5001",
  addPort: "Port hinzufügen",
  add: "Hinzufügen",
  portsNote: "Ohne Ports gilt die Kante für alle. Ping und Path-MTU-Discovery gehen immer.",
  viewReverse: "Gegenrichtung ansehen",
  allowReverse: (dst, src) => `Auch ${dst} → ${src} erlauben`,
  removeConnection: "Verbindung entfernen",
  nodeUser:
    "Alle ungetaggten Geräte dieses Mitglieds. Ein getaggtes Gerät zählt nicht mehr zu ihm, nur noch zu seinen Tags.",
  nodeRole:
    "Alle ungetaggten Geräte der Mitglieder mit dieser Rolle. Wechselt jemand die Rolle, wandern seine Geräte mit.",
  nodeAny:
    "Jedes Gerät im Wave, getaggt oder nicht — und als Ziel auch jeder Dienst. Neue Geräte gehören sofort dazu.",
  nodeSvc: "Gemeldet von einem Connector. Ein Dienst ist nur Ziel einer Regel.",
  nodeAllServices:
    "Jeder Dienst im Wave, aber kein Gerät. Dienste, die ein Connector später meldet, gehören sofort dazu.",
  notMember: "Diese Adresse ist kein Mitglied des Waves. Die Regel trifft niemanden.",
  address: "Adresse",
  covers: "Trifft",
  edgeCounts: (out, into) =>
    `${out} ausgehende, ${into} ${into === 1 ? "eingehende Verbindung" : "eingehende Verbindungen"}.`,
  coversNone: "Trifft derzeit kein Gerät.",

  groupNote: "Eine Gruppe fasst Mitglieder zusammen. Sie trifft deren ungetaggte Geräte, wie user: es täte.",
  members: "Mitglieder",
  notAMember: "kein Mitglied",
  groupEmpty: "Noch leer. Eine leere Gruppe trifft niemanden.",
  chooseMember: "Mitglied wählen",
  groupDevicesNote: "Einzelne Geräte bündelt ein Tag, keine Gruppe.",
  groupNoPolicy: "Eine Gruppe ist Teil der Policy. Solange es keine gibt, wird sie nicht gespeichert.",
  deleteGroup: (edges) =>
    `Gruppe löschen${edges > 0 ? ` (mit ${edges} ${edges === 1 ? "Verbindung" : "Verbindungen"})` : ""}`,

  tagNote:
    "Ein getaggtes Gerät ist für die Policy nur noch seine Tags: {user}, {group} und {role} treffen es nicht mehr, nur {tag} und {any}.",
  devices: "Geräte",
  tagEmpty: "Noch leer. Ein Tag ohne Geräte trifft niemanden.",
  chooseDevice: "Gerät wählen",
  noOwner: "ohne Besitzer",
  tagCountsNote: "Hinter jedem Gerät steht, wozu es jetzt zählt: seinem Besitzer oder seinen anderen Tags.",
  tagUnsaved: "Ein Tag, den kein Gerät trägt und keine Regel nennt, wird nicht gespeichert.",
  deleteTag: (edges) =>
    `Tag löschen${edges > 0 ? ` (mit ${edges} ${edges === 1 ? "Verbindung" : "Verbindungen"})` : ""}`,

  newTag: "Neuer Tag",
  newGroup: "Neue Gruppe",
  createTagNote:
    "Ein Tag fasst Geräte zusammen, unabhängig davon, wem sie gehören. Geräte kommen im nächsten Schritt dazu.",
  createGroupNote:
    "Eine Gruppe fasst Mitglieder zusammen, damit eine Regel sie alle auf einmal meint. Mitglieder kommen im nächsten Schritt dazu.",
  nameRule: "Kleinbuchstaben, Ziffern und -, am Anfang kein -, höchstens 63 Zeichen.",
  exists: (id) => `${id} gibt es schon.`,
  name: "Name",
  tagPlaceholder: "drucker",
  groupPlaceholder: "familie",
  create: "Anlegen",

  howTo: "So geht's",
  help1:
    "Vom {dot} an einer Karte auf eine andere ziehen. Auf dem Telefon: Punkt antippen, dann das Ziel. Der erste Pfeil schaltet die Policy ein — ab dann gilt nur noch, was ein Pfeil erlaubt.",
  help2: "Eine Kante antippen und Ports eintragen, wenn nicht alle gemeint sind.",
  help3: "{addGroup} für Mitglieder, {addTag} für Geräte — dann die Karte antippen und füllen.",
  help4: "Speichern. Bis dahin ändert sich nichts an den Geräten.",
  help5: "Karten lassen sich verschieben. {del} löscht die gewählte Kante, {esc} bricht ab.",
  deleteKey: "Entf",
};

export type AclMessages = typeof en;

export const aclMessages = (locale: Locale): AclMessages => messagesFor({ en, de }, locale);
