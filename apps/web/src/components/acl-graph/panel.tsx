"use client";

import { type FormEvent, useState } from "react";
import type { AclPreview, AclView } from "@/lib/control";
import { type Draft, type Edge, kindOf, NAME_PATTERN, parsePort } from "./model";

const PRESETS: [string, string][] = [
  ["SSH", "22"],
  ["HTTP", "80"],
  ["HTTPS", "443"],
  ["SMB", "445"],
  ["NFS", "tcp:2049"],
  ["DNS", "53"],
];

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function Title({ children }: { children: React.ReactNode }) {
  return <h3 className="wc-section-title mb-0! pb-1.5!">{children}</h3>;
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h2 className="break-words font-display font-semibold text-headline text-navy">{children}</h2>;
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="break-words text-body-sm text-slate">{children}</p>;
}

/** The devices and services a selector covers, as the control server worked them out. */
function Covered({
  selector,
  view,
  preview,
}: {
  selector: string;
  view: AclView;
  preview: AclPreview | null;
}) {
  const covers = preview?.covers[selector];
  if (!covers) return <Note>Wird ausgewertet …</Note>;
  const devices = view.devices.filter((d) => covers.nodes.includes(d.id));
  const services = view.services.filter((s) => covers.services.includes(s.name));
  if (devices.length === 0 && services.length === 0) return <Note>Trifft derzeit kein Gerät.</Note>;
  return (
    <ul className="divide-y divide-line">
      {devices.map((d) => (
        <li key={d.id} className="flex justify-between gap-2 py-1.5 text-body-sm text-navy">
          <span className="min-w-0 break-words">{d.hostname}</span>
          <code className="text-caption text-ink">{d.ipv4}</code>
        </li>
      ))}
      {services.map((s) => (
        <li key={s.name} className="flex justify-between gap-2 py-1.5 text-body-sm text-navy">
          <span className="min-w-0 break-words">svc:{s.name}</span>
          <code className="text-caption text-ink">{s.ipv4}</code>
        </li>
      ))}
    </ul>
  );
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="h-7 w-7 flex-none cursor-pointer rounded-md text-slate hover:bg-[#dc26260f] hover:text-[#dc2626]"
    >
      ×
    </button>
  );
}

const dangerButton =
  "wc-btn wc-btn-secondary whitespace-normal! border-[#dc262626]! text-center text-[#dc2626]! hover:bg-[#dc26260f]!";

export interface PanelActions {
  change: (mutate: (draft: Draft) => void) => void;
  connect: (src: string, dst: string) => void;
  selectEdge: (id: string | null) => void;
  selectNode: (id: string | null) => void;
  created: (id: string, kind: "group" | "tag") => void;
  cancelCreate: () => void;
}

export function EdgePanel({ edge, draft, actions }: { edge: Edge; draft: Draft; actions: PanelActions }) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const reverse = draft.edges.find((e) => e.src === edge.dst && e.dst === edge.src);

  function add(ports: string[]) {
    const fresh = ports.filter((p) => !edge.ports.includes(p));
    if (fresh.length === 0) return;
    actions.change((d) => {
      const target = d.edges.find((e) => e.id === edge.id);
      // `*` is every port -- the same as no list, so nothing stays beside it.
      if (target) target.ports = fresh.includes("*") ? [] : [...target.ports, ...fresh];
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const parts = text.split(/[,\s]+/).filter(Boolean);
    if (parts.length === 0) return;
    const bad = parts.find((p) => parsePort(p) === null);
    if (bad) {
      setError(`„${bad}“ ist kein Port. Erlaubt: *, 22, 5000-5001, mit tcp: oder udp: davor.`);
      return;
    }
    setError("");
    setText("");
    add(parts.map((p) => parsePort(p) as string));
  }

  return (
    <>
      <Title>Verbindung</Title>
      <Heading>
        {edge.src}
        <span className="px-1 text-accent">→</span>
        {edge.dst}
      </Heading>
      <Note>
        {edge.src} darf Verbindungen zu {edge.dst} beginnen
        {edge.ports.length > 0 ? " — nur auf diesen Ports." : ", auf allen Ports."}
      </Note>
      <div className="grid gap-2">
        <Title>Ports</Title>
        <div className="flex flex-wrap gap-1.5">
          {edge.ports.length > 0 ? (
            edge.ports.map((port, index) => (
              <span
                key={port}
                className="inline-flex items-center gap-1 rounded-full bg-[#0f6e6e14] py-0.5 pr-1 pl-2.5 font-mono text-accent-strong text-caption"
              >
                {port}
                <button
                  type="button"
                  aria-label={`${port} entfernen`}
                  className="h-5 w-5 cursor-pointer rounded-full hover:bg-[#0f6e6e26]"
                  onClick={() =>
                    actions.change((d) => {
                      d.edges.find((e) => e.id === edge.id)?.ports.splice(index, 1);
                    })
                  }
                >
                  ×
                </button>
              </span>
            ))
          ) : (
            <span className="wc-badge bg-[#0f27440f] text-slate">alle Ports</span>
          )}
        </div>
        <form className="flex min-w-0 gap-2" onSubmit={submit} noValidate>
          <input
            id="acl-port"
            className={`wc-input min-w-0 flex-1 px-2.5! py-1.5! font-mono ${error ? "border-[#dc2626]!" : ""}`}
            placeholder="z. B. 443 oder tcp:5000-5001"
            value={text}
            onChange={(event) => setText(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-label="Port hinzufügen"
          />
          <button type="submit" className="wc-btn wc-btn-primary flex-none px-4! py-1.5!">
            Hinzufügen
          </button>
        </form>
        {error ? <p className="text-[#dc2626] text-caption">{error}</p> : null}
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map(([name, port]) => (
            <button
              key={port}
              type="button"
              disabled={edge.ports.includes(port)}
              onClick={() => add([port])}
              className="cursor-pointer rounded-full border border-[#0f274433] border-dashed px-2.5 py-0.5 font-medium text-navy text-xs hover:border-accent hover:text-accent disabled:cursor-default disabled:opacity-35"
            >
              {name} {port}
            </button>
          ))}
        </div>
        <Note>Ohne Ports gilt die Kante für alle. Ping und Path-MTU-Discovery gehen immer.</Note>
      </div>
      <div className="grid gap-2">
        {kindOf(edge.dst) === "svc" ? null : reverse ? (
          <button
            type="button"
            className="wc-btn wc-btn-secondary whitespace-normal!"
            onClick={() => actions.selectEdge(reverse.id)}
          >
            Gegenrichtung ansehen
          </button>
        ) : (
          <button
            type="button"
            className="wc-btn wc-btn-secondary whitespace-normal! break-words"
            onClick={() => actions.connect(edge.dst, edge.src)}
          >
            Auch {edge.dst} → {edge.src} erlauben
          </button>
        )}
        <button
          type="button"
          className={dangerButton}
          onClick={() => {
            actions.change((d) => {
              d.edges = d.edges.filter((e) => e.id !== edge.id);
            });
            actions.selectEdge(null);
          }}
        >
          Verbindung entfernen
        </button>
      </div>
    </>
  );
}

const NODE_TEXT: Record<string, string> = {
  user: "Alle ungetaggten Geräte dieses Mitglieds. Ein getaggtes Gerät zählt nicht mehr zu ihm, nur noch zu seinen Tags.",
  role: "Alle ungetaggten Geräte der Mitglieder mit dieser Rolle. Wechselt jemand die Rolle, wandern seine Geräte mit.",
  any: "Jedes Gerät im Wave, getaggt oder nicht — und als Ziel auch jeder Dienst. Neue Geräte gehören sofort dazu.",
  svc: "Gemeldet von einem Connector. Ein Dienst ist nur Ziel einer Regel.",
};

export function NodePanel({
  id,
  draft,
  view,
  preview,
}: {
  id: string;
  draft: Draft;
  view: AclView;
  preview: AclPreview | null;
}) {
  const kind = kindOf(id);
  const out = draft.edges.filter((e) => e.src === id).length;
  const into = draft.edges.filter((e) => e.dst === id).length;
  const known = kind !== "user" || view.members.some((m) => `user:${m.email}` === id);
  return (
    <>
      <Title>
        {{ user: "Mitglied", role: "Rolle", any: "Alle", svc: "Dienst", group: "Gruppe", tag: "Tag" }[kind]}
      </Title>
      <Heading>{id}</Heading>
      <Note>{NODE_TEXT[kind]}</Note>
      {known ? null : (
        <p className="wc-alert-error">
          Diese Adresse ist kein Mitglied des Waves. Die Regel trifft niemanden.
        </p>
      )}
      <div className="grid gap-2">
        <Title>{kind === "svc" ? "Adresse" : "Trifft"}</Title>
        <Covered selector={id} view={view} preview={preview} />
      </div>
      {draft.policy ? (
        <Note>
          {out} ausgehende, {plural(into, "eingehende Verbindung", "eingehende Verbindungen")}.
        </Note>
      ) : null}
    </>
  );
}

function removeSelector(draft: Draft, id: string) {
  delete draft.groups[id];
  for (const device of Object.keys(draft.tags))
    draft.tags[device] = (draft.tags[device] ?? []).filter((t) => t !== id);
  draft.extraTags = draft.extraTags.filter((t) => t !== id);
  draft.edges = draft.edges.filter((e) => e.src !== id && e.dst !== id);
}

export function GroupPanel({
  id,
  draft,
  view,
  preview,
  actions,
}: {
  id: string;
  draft: Draft;
  view: AclView;
  preview: AclPreview | null;
  actions: PanelActions;
}) {
  const members = draft.groups[id] ?? [];
  const free = view.members.filter((m) => !members.includes(m.email));
  const [pick, setPick] = useState("");
  const chosen = free.some((m) => m.email === pick) ? pick : (free[0]?.email ?? "");
  const usedIn = draft.edges.filter((e) => e.src === id || e.dst === id).length;

  return (
    <>
      <Title>Gruppe</Title>
      <Heading>{id}</Heading>
      <Note>
        Eine Gruppe fasst Mitglieder zusammen. Sie trifft deren ungetaggte Geräte, wie user: es täte.
      </Note>
      <div className="grid gap-2">
        <Title>Mitglieder</Title>
        {members.length > 0 ? (
          <ul className="divide-y divide-line">
            {members.map((email) => (
              <li
                key={email}
                className="flex items-center justify-between gap-2 py-1.5 text-body-sm text-navy"
              >
                <span className="min-w-0 break-words">
                  {email}
                  {view.members.some((m) => m.email === email) ? null : (
                    <span className="ml-1 text-[#dc2626] text-caption">kein Mitglied</span>
                  )}
                </span>
                <RemoveButton
                  label={`${email} entfernen`}
                  onClick={() =>
                    actions.change((d) => {
                      d.groups[id] = (d.groups[id] ?? []).filter((m) => m !== email);
                    })
                  }
                />
              </li>
            ))}
          </ul>
        ) : (
          <Note>Noch leer. Eine leere Gruppe trifft niemanden.</Note>
        )}
        <form
          className="flex min-w-0 gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!chosen) return;
            actions.change((d) => {
              d.groups[id] = [...(d.groups[id] ?? []), chosen];
            });
          }}
        >
          <select
            id="acl-group-member"
            aria-label="Mitglied wählen"
            className="wc-input min-w-0 flex-1 truncate px-2.5! py-1.5!"
            value={chosen}
            onChange={(event) => setPick(event.target.value)}
          >
            {free.map((m) => (
              <option key={m.email} value={m.email}>
                {m.email}
              </option>
            ))}
          </select>
          <button type="submit" className="wc-btn wc-btn-primary flex-none px-4! py-1.5!" disabled={!chosen}>
            Hinzufügen
          </button>
        </form>
        <Note>Einzelne Geräte bündelt ein Tag, keine Gruppe.</Note>
      </div>
      <div className="grid gap-2">
        <Title>Trifft</Title>
        <Covered selector={id} view={view} preview={preview} />
      </div>
      {draft.policy ? null : (
        <Note>Eine Gruppe ist Teil der Policy. Solange es keine gibt, wird sie nicht gespeichert.</Note>
      )}
      <button
        type="button"
        className={dangerButton}
        onClick={() => {
          actions.change((d) => removeSelector(d, id));
          actions.selectNode(null);
        }}
      >
        Gruppe löschen{usedIn > 0 ? ` (mit ${plural(usedIn, "Verbindung", "Verbindungen")})` : ""}
      </button>
    </>
  );
}

export function TagPanel({
  id,
  draft,
  view,
  actions,
}: {
  id: string;
  draft: Draft;
  view: AclView;
  actions: PanelActions;
}) {
  const wearing = view.devices.filter((d) => (draft.tags[d.id] ?? []).includes(id));
  const free = view.devices.filter((d) => !(draft.tags[d.id] ?? []).includes(id));
  const [pick, setPick] = useState("");
  const chosen = free.some((d) => d.id === pick) ? pick : (free[0]?.id ?? "");
  const usedIn = draft.edges.filter((e) => e.src === id || e.dst === id).length;
  // What a device counts as right now: its owner while untagged, else its other tags.
  const countsAs = (deviceId: string, email: string | null) => {
    const others = (draft.tags[deviceId] ?? []).filter((t) => t !== id);
    return others.length > 0 ? others.join(", ") : (email ?? "ohne Besitzer");
  };

  return (
    <>
      <Title>Tag</Title>
      <Heading>{id}</Heading>
      <Note>
        Ein getaggtes Gerät ist für die Policy nur noch seine Tags: <code>user:</code>, <code>group:</code>{" "}
        und <code>role:</code> treffen es nicht mehr, nur <code>tag:</code> und <code>*</code>.
      </Note>
      <div className="grid gap-2">
        <Title>Geräte</Title>
        {wearing.length > 0 ? (
          <ul className="divide-y divide-line">
            {wearing.map((d) => (
              <li
                key={d.id}
                className="flex items-center justify-between gap-2 py-1.5 text-body-sm text-navy"
              >
                <span className="min-w-0 break-words">
                  {d.hostname} <code className="text-caption text-slate">{d.ipv4}</code>
                </span>
                <RemoveButton
                  label={`${d.hostname} entfernen`}
                  onClick={() =>
                    actions.change((draft) => {
                      draft.tags[d.id] = (draft.tags[d.id] ?? []).filter((t) => t !== id);
                      // Kept on the page while it is being refilled, even with no device left.
                      if (!draft.extraTags.includes(id)) draft.extraTags.push(id);
                    })
                  }
                />
              </li>
            ))}
          </ul>
        ) : (
          <Note>Noch leer. Ein Tag ohne Geräte trifft niemanden.</Note>
        )}
        <form
          className="flex min-w-0 gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!chosen) return;
            actions.change((draft) => {
              draft.tags[chosen] = [...(draft.tags[chosen] ?? []), id];
            });
          }}
        >
          <select
            id="acl-tag-device"
            aria-label="Gerät wählen"
            className="wc-input min-w-0 flex-1 truncate px-2.5! py-1.5!"
            value={chosen}
            onChange={(event) => setPick(event.target.value)}
          >
            {free.map((d) => (
              <option key={d.id} value={d.id}>
                {d.hostname} · {countsAs(d.id, d.email)}
              </option>
            ))}
          </select>
          <button type="submit" className="wc-btn wc-btn-primary flex-none px-4! py-1.5!" disabled={!chosen}>
            Hinzufügen
          </button>
        </form>
        <Note>Hinter jedem Gerät steht, wozu es jetzt zählt: seinem Besitzer oder seinen anderen Tags.</Note>
      </div>
      {wearing.length === 0 && usedIn === 0 ? (
        <Note>Ein Tag, den kein Gerät trägt und keine Regel nennt, wird nicht gespeichert.</Note>
      ) : null}
      <button
        type="button"
        className={dangerButton}
        onClick={() => {
          actions.change((d) => removeSelector(d, id));
          actions.selectNode(null);
        }}
      >
        Tag löschen{usedIn > 0 ? ` (mit ${plural(usedIn, "Verbindung", "Verbindungen")})` : ""}
      </button>
    </>
  );
}

export function CreatePanel({
  kind,
  exists,
  actions,
}: {
  kind: "group" | "tag";
  exists: (id: string) => boolean;
  actions: PanelActions;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const prefix = kind === "tag" ? "tag:" : "group:";

  function submit(event: FormEvent) {
    event.preventDefault();
    const clean = name.trim().toLowerCase();
    const id = prefix + clean;
    if (!NAME_PATTERN.test(clean)) {
      setError("Kleinbuchstaben, Ziffern und -, am Anfang kein -, höchstens 63 Zeichen.");
      return;
    }
    if (exists(id)) {
      setError(`${id} gibt es schon.`);
      return;
    }
    actions.change((d) => {
      if (kind === "tag") d.extraTags.push(id);
      else d.groups[id] = [];
    });
    actions.created(id, kind);
  }

  return (
    <>
      <Title>{kind === "tag" ? "Neuer Tag" : "Neue Gruppe"}</Title>
      <Heading>{kind === "tag" ? "Tag hinzufügen" : "Gruppe hinzufügen"}</Heading>
      <Note>
        {kind === "tag"
          ? "Ein Tag fasst Geräte zusammen, unabhängig davon, wem sie gehören. Geräte kommen im nächsten Schritt dazu."
          : "Eine Gruppe fasst Mitglieder zusammen, damit eine Regel sie alle auf einmal meint. Mitglieder kommen im nächsten Schritt dazu."}
      </Note>
      <form className="grid gap-2" onSubmit={submit} noValidate>
        <label htmlFor="acl-create-name" className="wc-label mb-0!">
          Name
        </label>
        <div className="flex min-w-0 gap-2">
          <div
            className={`flex min-w-0 flex-1 overflow-hidden rounded-lg border focus-within:border-accent ${error ? "border-[#dc2626]" : "border-[#0f27441f]"}`}
          >
            <span className="bg-[#0f27440a] py-1.5 pr-1 pl-2.5 font-mono text-body-sm text-slate">
              {prefix}
            </span>
            <input
              id="acl-create-name"
              className="w-full min-w-0 flex-1 px-1.5 py-1.5 font-mono text-body-sm outline-none"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={kind === "tag" ? "drucker" : "familie"}
              autoComplete="off"
              spellCheck={false}
              // biome-ignore lint/a11y/noAutofocus: the panel opens for exactly this field
              autoFocus
            />
          </div>
          <button type="submit" className="wc-btn wc-btn-primary flex-none px-4! py-1.5!">
            Anlegen
          </button>
        </div>
        {error ? <p className="text-[#dc2626] text-caption">{error}</p> : null}
      </form>
      <button type="button" className="wc-btn wc-btn-secondary" onClick={actions.cancelCreate}>
        Abbrechen
      </button>
    </>
  );
}

export function HelpPanel() {
  return (
    <>
      <Title>So geht's</Title>
      <ol className="grid list-decimal gap-2 pl-5 text-body-sm text-navy marker:font-semibold marker:text-accent">
        <li>
          Vom <span className="text-accent">●</span> an einer Karte auf eine andere ziehen. Auf dem Telefon:
          Punkt antippen, dann das Ziel. Der erste Pfeil schaltet die Policy ein — ab dann gilt nur noch, was
          ein Pfeil erlaubt.
        </li>
        <li>Eine Kante antippen und Ports eintragen, wenn nicht alle gemeint sind.</li>
        <li>
          <b>Gruppe hinzufügen</b> für Mitglieder, <b>Tag hinzufügen</b> für Geräte — dann die Karte antippen
          und füllen.
        </li>
        <li>Speichern. Bis dahin ändert sich nichts an den Geräten.</li>
      </ol>
      <Note>
        Karten lassen sich verschieben. <kbd className="font-mono">Entf</kbd> löscht die gewählte Kante,{" "}
        <kbd className="font-mono">Esc</kbd> bricht ab.
      </Note>
    </>
  );
}
