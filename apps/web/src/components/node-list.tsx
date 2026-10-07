"use client";

import { useState } from "react";
import { useLocale } from "@/components/locale-provider";
import { appMessages } from "@/i18n/app";
import { rich } from "@/i18n/rich";
import type { Node, Service, Wave } from "@/lib/control";
import { formatDate, osName, timeAgo } from "@/lib/format";

/**
 * "Online" is a held control connection, nothing else. A node that dropped off
 * five seconds ago still has a fresh `lastSeenAt`, so both are shown.
 */
function StatusDot({ online }: { online: boolean }) {
  return (
    <span
      aria-hidden
      className="inline-block size-2 shrink-0 rounded-full"
      style={
        online
          ? { backgroundColor: "var(--color-accent)", boxShadow: "0 0 0 3px #0f6e6e1f" }
          : { backgroundColor: "var(--color-slate)", opacity: 0.5 }
      }
    />
  );
}

/**
 * The services a node answers for, under the node itself.
 *
 * They belong here and nowhere else: a service is an address in the wave with
 * no keys and no tunnel of its own, so the node that carries it is the only
 * thing it can be shown against. A connector without them looks like a device
 * that joined and then did nothing.
 */
function ServiceList({ id, services }: { id: string; services: Service[] }) {
  return (
    <ul id={id} className="col-span-full mt-2 space-y-1 border-line border-l pl-4 md:ml-[1.125rem]">
      {services.map((service) => (
        <li key={service.name}>
          {/*
            Die ganze Zeile ist der Link, nicht nur der Name: wer einen Dienst
            anklickt, meint den Dienst, und die Adresse daneben gehört ihm.

            Die Adresse selbst kommt fertig vom Control-Server und wird hier
            nicht zusammengesetzt: ob der Cluster TLS terminiert, weiß nur er,
            und die Zone nur der Wave. Jedes Gerät bekommt dieselbe in seiner
            Netzkarte. Der Link geht nur auf, wer im Wave ist -- von außen löst
            der Name nicht einmal auf, und das ist die Absicht. Deshalb ein
            neuer Tab: landet man auf nichts, ist die Übersicht nicht mit weg.
          */}
          <a
            href={service.url}
            target="_blank"
            rel="noreferrer"
            className="-mx-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded px-2 py-1 transition-colors hover:bg-navy/4"
          >
            <span className="font-mono text-accent text-caption underline decoration-accent/30 underline-offset-2">
              {service.url}
            </span>
            <span className="font-mono text-caption text-slate">{service.ipv4}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/** Zeigt an, dass unter dieser Zeile noch etwas liegt -- und ob es offen ist. */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 8 12"
      className={`size-2.5 shrink-0 text-slate transition-transform ${open ? "rotate-90" : ""}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 1l5 5-5 5" />
    </svg>
  );
}

/**
 * The removal is a plain form post to the control server, like the ones in the
 * member list: same origin for the browser, session cookie along, no JavaScript.
 */
function NodeRow({
  node,
  wave,
  mayRemove,
  meId,
}: {
  node: Node;
  wave: Wave;
  mayRemove: boolean;
  meId: string;
}) {
  // Umbenennen darf, wer verwaltet, und wer das Gerät hinzugefügt hat: ein
  // Telefon bekommt bei der Anmeldung nur „iPhone", und erst hier wird daraus
  // ein Name, den man wiedererkennt.
  const mayRename = mayRemove || node.userId === meId;
  // Die Dienste liegen eingeklappt unter ihrem Gerät. Der Zustand gehört der
  // Zeile, nicht der Liste: ein Push ersetzt die Geräte, und ein aufgeklapptes
  // bleibt über `key={node.id}` genau dort, wo es der Mensch gelassen hat.
  const [open, setOpen] = useState(false);
  const locale = useLocale();
  const t = appMessages(locale);
  const hasServices = node.services.length > 0;
  const listId = `services-${node.id}`;
  const columns = mayRemove
    ? "md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.6fr)_auto_auto]"
    : "md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.6fr)_auto]";

  const identity = (
    <>
      <StatusDot online={node.online} />
      <span className="truncate font-medium text-navy text-body-sm">{node.hostname}</span>
      {node.ephemeral ? (
        <span className="wc-badge" style={{ backgroundColor: "#0f27440f", color: "var(--color-slate)" }}>
          {t.ephemeral}
        </span>
      ) : null}
      {node.approved ? null : (
        <span className="wc-badge" style={{ backgroundColor: "#dc26260f", color: "#dc2626" }}>
          {t.notApproved}
        </span>
      )}
      {hasServices ? (
        <span className="wc-badge" style={{ backgroundColor: "#0f6e6e14", color: "var(--color-accent)" }}>
          {t.services(node.services.length)}
        </span>
      ) : null}
    </>
  );

  return (
    <li className={`grid grid-cols-1 gap-x-6 gap-y-2 py-4 md:items-center ${columns}`}>
      {/* Ein echter Knopf, kein anklickbares `div`: Tastatur, Fokus und
          `aria-expanded` gibt es damit geschenkt. Und nur dort, wo es etwas
          aufzuklappen gibt -- ein Gerät ohne Dienste, das sich anfassen lässt
          und dann nichts tut, ist ein kaputter Knopf. */}
      {hasServices ? (
        <button
          type="button"
          onClick={() => setOpen((shown) => !shown)}
          aria-expanded={open}
          aria-controls={listId}
          className="flex min-w-0 cursor-pointer items-center gap-2.5 text-left"
        >
          {identity}
          <Chevron open={open} />
        </button>
      ) : (
        <div className="flex min-w-0 items-center gap-2.5">{identity}</div>
      )}

      {/* Unter dem System, weil beides beschreibt, was auf dem Gerät läuft.
          Ein Client von vor den Updates sagt seine Version nie; dann steht
          dort, dass sie unbekannt ist, statt einer geratenen. */}
      <div className="text-caption text-slate">
        <div>{osName(node.os, locale, node.clientPlatform)}</div>
        <div
          className="font-mono"
          title={node.updateChannel ? t.updateChannel(node.updateChannel) : undefined}
        >
          {node.clientVersion
            ? `v${node.clientVersion}${node.updateChannel ? ` · ${node.updateChannel}` : ""}`
            : t.versionUnknown}
        </div>
      </div>

      <div className="min-w-0 font-mono text-caption text-slate">
        <div className="truncate text-ink">{node.ipv4}</div>
        <div className="truncate">{node.ipv6}</div>
      </div>

      {/* Diese Liste wird seit dem Live-Feed auch im Browser gerendert, und
          beide Zeiten hier fallen dabei auseinander: „vor drei Minuten" zählt
          ab jetzt, und der Server steht auf UTC, der Browser nicht. Die
          Fassung des Browsers ist die richtige -- gewarnt werden muss über den
          Unterschied also nicht. */}
      <div
        className="text-caption text-slate md:text-right"
        title={formatDate(node.lastSeenAt, locale)}
        suppressHydrationWarning
      >
        {node.online ? t.online : timeAgo(node.lastSeenAt, locale)}
      </div>

      {mayRemove ? (
        <div className="md:text-right">
          <form method="post" action={`/waves/${wave.id}/nodes/${node.id}/remove`}>
            <button type="submit" className="wc-btn wc-btn-secondary">
              {t.remove}
            </button>
          </form>
        </div>
      ) : null}

      {hasServices && open ? <ServiceList id={listId} services={node.services} /> : null}

      {mayRename ? (
        <details className="col-span-full">
          <summary className="cursor-pointer text-caption text-slate">{t.renameDevice}</summary>
          <form
            method="post"
            action={`/waves/${wave.id}/nodes/${node.id}/name`}
            className="mt-3 flex flex-col gap-3 md:flex-row md:items-end"
          >
            <div className="flex-1">
              <label className="wc-label" htmlFor={`rename-${node.id}`}>
                {t.newDeviceName}
              </label>
              <input
                className="wc-input"
                id={`rename-${node.id}`}
                name="name"
                defaultValue={node.hostname}
                autoComplete="off"
                spellCheck={false}
                required
              />
            </div>
            <button type="submit" className="wc-btn wc-btn-secondary">
              {t.apply}
            </button>
          </form>
          <p className="mt-2 text-caption text-slate">{t.renameDeviceHint}</p>
        </details>
      ) : null}
    </li>
  );
}

export function NodeList({
  nodes,
  wave,
  mayRemove,
  meId,
}: {
  nodes: Node[];
  wave: Wave;
  mayRemove: boolean;
  meId: string;
}) {
  const t = appMessages(useLocale());
  if (nodes.length === 0) {
    return (
      <div className="py-6 text-center">
        <p className="text-body-sm text-slate">{t.noDevices}</p>
        <pre
          className="mx-auto mt-4 inline-block rounded-lg px-4 py-2.5 text-caption text-navy"
          style={{ backgroundColor: "#0f27440a" }}
        >
          wave login &lt;control-server-url&gt;
        </pre>
      </div>
    );
  }

  return (
    <>
      <ul className="divide-y divide-line">
        {nodes.map((node) => (
          <NodeRow key={node.id} node={node} wave={wave} mayRemove={mayRemove} meId={meId} />
        ))}
      </ul>

      {mayRemove ? (
        <p className="mt-3 text-caption text-slate">
          {rich(t.removeDeviceHint, { command: <code>wave login</code> })}
        </p>
      ) : null}
    </>
  );
}
