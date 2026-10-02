"use client";

import { type FormEvent, useState } from "react";
import { useLocale } from "@/components/locale-provider";
import { aclMessages } from "@/i18n/acl";
import { rich } from "@/i18n/rich";
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
  const t = aclMessages(useLocale());
  const covers = preview?.covers[selector];
  if (!covers) return <Note>{t.evaluating}</Note>;
  const devices = view.devices.filter((d) => covers.nodes.includes(d.id));
  const services = view.services.filter((s) => covers.services.includes(s.name));
  if (devices.length === 0 && services.length === 0) return <Note>{t.coversNone}</Note>;
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
  const t = aclMessages(useLocale());
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
      setError(t.portInvalid(bad));
      return;
    }
    setError("");
    setText("");
    add(parts.map((p) => parsePort(p) as string));
  }

  return (
    <>
      <Title>{t.connection}</Title>
      <Heading>
        {edge.src}
        <span className="px-1 text-accent">→</span>
        {edge.dst}
      </Heading>
      <Note>{t.edgeNote(edge.src, edge.dst, edge.ports.length > 0)}</Note>
      <div className="grid gap-2">
        <Title>{t.ports}</Title>
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
                  aria-label={t.removeItem(port)}
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
            <span className="wc-badge bg-[#0f27440f] text-slate">{t.allPorts}</span>
          )}
        </div>
        <form className="flex min-w-0 gap-2" onSubmit={submit} noValidate>
          <input
            id="acl-port"
            className={`wc-input min-w-0 flex-1 px-2.5! py-1.5! font-mono ${error ? "border-[#dc2626]!" : ""}`}
            placeholder={t.portPlaceholder}
            value={text}
            onChange={(event) => setText(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-label={t.addPort}
          />
          <button type="submit" className="wc-btn wc-btn-primary flex-none px-4! py-1.5!">
            {t.add}
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
        <Note>{t.portsNote}</Note>
      </div>
      <div className="grid gap-2">
        {kindOf(edge.dst) === "svc" ? null : reverse ? (
          <button
            type="button"
            className="wc-btn wc-btn-secondary whitespace-normal!"
            onClick={() => actions.selectEdge(reverse.id)}
          >
            {t.viewReverse}
          </button>
        ) : (
          <button
            type="button"
            className="wc-btn wc-btn-secondary whitespace-normal! break-words"
            onClick={() => actions.connect(edge.dst, edge.src)}
          >
            {t.allowReverse(edge.dst, edge.src)}
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
          {t.removeConnection}
        </button>
      </div>
    </>
  );
}

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
  const t = aclMessages(useLocale());
  const kind = kindOf(id);
  const nodeText: Partial<Record<typeof kind, string>> = {
    user: t.nodeUser,
    role: t.nodeRole,
    any: t.nodeAny,
    svc: t.nodeSvc,
  };
  const out = draft.edges.filter((e) => e.src === id).length;
  const into = draft.edges.filter((e) => e.dst === id).length;
  const known = kind !== "user" || view.members.some((m) => `user:${m.email}` === id);
  return (
    <>
      <Title>{t.kindTitle(kind)}</Title>
      <Heading>{id}</Heading>
      <Note>{nodeText[kind]}</Note>
      {known ? null : <p className="wc-alert-error">{t.notMember}</p>}
      <div className="grid gap-2">
        <Title>{kind === "svc" ? t.address : t.covers}</Title>
        <Covered selector={id} view={view} preview={preview} />
      </div>
      {draft.policy ? <Note>{t.edgeCounts(out, into)}</Note> : null}
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
  const t = aclMessages(useLocale());
  const members = draft.groups[id] ?? [];
  const free = view.members.filter((m) => !members.includes(m.email));
  const [pick, setPick] = useState("");
  const chosen = free.some((m) => m.email === pick) ? pick : (free[0]?.email ?? "");
  const usedIn = draft.edges.filter((e) => e.src === id || e.dst === id).length;

  return (
    <>
      <Title>{t.kindTitle("group")}</Title>
      <Heading>{id}</Heading>
      <Note>{t.groupNote}</Note>
      <div className="grid gap-2">
        <Title>{t.members}</Title>
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
                    <span className="ml-1 text-[#dc2626] text-caption">{t.notAMember}</span>
                  )}
                </span>
                <RemoveButton
                  label={t.removeItem(email)}
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
          <Note>{t.groupEmpty}</Note>
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
            aria-label={t.chooseMember}
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
            {t.add}
          </button>
        </form>
        <Note>{t.groupDevicesNote}</Note>
      </div>
      <div className="grid gap-2">
        <Title>{t.covers}</Title>
        <Covered selector={id} view={view} preview={preview} />
      </div>
      {draft.policy ? null : <Note>{t.groupNoPolicy}</Note>}
      <button
        type="button"
        className={dangerButton}
        onClick={() => {
          actions.change((d) => removeSelector(d, id));
          actions.selectNode(null);
        }}
      >
        {t.deleteGroup(usedIn)}
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
  const t = aclMessages(useLocale());
  const wearing = view.devices.filter((d) => (draft.tags[d.id] ?? []).includes(id));
  const free = view.devices.filter((d) => !(draft.tags[d.id] ?? []).includes(id));
  const [pick, setPick] = useState("");
  const chosen = free.some((d) => d.id === pick) ? pick : (free[0]?.id ?? "");
  const usedIn = draft.edges.filter((e) => e.src === id || e.dst === id).length;
  // What a device counts as right now: its owner while untagged, else its other tags.
  const countsAs = (deviceId: string, email: string | null) => {
    const others = (draft.tags[deviceId] ?? []).filter((t) => t !== id);
    return others.length > 0 ? others.join(", ") : (email ?? t.noOwner);
  };

  return (
    <>
      <Title>{t.kindTitle("tag")}</Title>
      <Heading>{id}</Heading>
      <Note>
        {rich(t.tagNote, {
          user: <code>user:</code>,
          group: <code>group:</code>,
          role: <code>role:</code>,
          tag: <code>tag:</code>,
          any: <code>*</code>,
        })}
      </Note>
      <div className="grid gap-2">
        <Title>{t.devices}</Title>
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
                  label={t.removeItem(d.hostname)}
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
          <Note>{t.tagEmpty}</Note>
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
            aria-label={t.chooseDevice}
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
            {t.add}
          </button>
        </form>
        <Note>{t.tagCountsNote}</Note>
      </div>
      {wearing.length === 0 && usedIn === 0 ? <Note>{t.tagUnsaved}</Note> : null}
      <button
        type="button"
        className={dangerButton}
        onClick={() => {
          actions.change((d) => removeSelector(d, id));
          actions.selectNode(null);
        }}
      >
        {t.deleteTag(usedIn)}
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
  const t = aclMessages(useLocale());
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const prefix = kind === "tag" ? "tag:" : "group:";

  function submit(event: FormEvent) {
    event.preventDefault();
    const clean = name.trim().toLowerCase();
    const id = prefix + clean;
    if (!NAME_PATTERN.test(clean)) {
      setError(t.nameRule);
      return;
    }
    if (exists(id)) {
      setError(t.exists(id));
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
      <Title>{kind === "tag" ? t.newTag : t.newGroup}</Title>
      <Heading>{kind === "tag" ? t.addTag : t.addGroup}</Heading>
      <Note>{kind === "tag" ? t.createTagNote : t.createGroupNote}</Note>
      <form className="grid gap-2" onSubmit={submit} noValidate>
        <label htmlFor="acl-create-name" className="wc-label mb-0!">
          {t.name}
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
              placeholder={kind === "tag" ? t.tagPlaceholder : t.groupPlaceholder}
              autoComplete="off"
              spellCheck={false}
              // biome-ignore lint/a11y/noAutofocus: the panel opens for exactly this field
              autoFocus
            />
          </div>
          <button type="submit" className="wc-btn wc-btn-primary flex-none px-4! py-1.5!">
            {t.create}
          </button>
        </div>
        {error ? <p className="text-[#dc2626] text-caption">{error}</p> : null}
      </form>
      <button type="button" className="wc-btn wc-btn-secondary" onClick={actions.cancelCreate}>
        {t.cancel}
      </button>
    </>
  );
}

export function HelpPanel() {
  const t = aclMessages(useLocale());
  return (
    <>
      <Title>{t.howTo}</Title>
      <ol className="grid list-decimal gap-2 pl-5 text-body-sm text-navy marker:font-semibold marker:text-accent">
        <li>{rich(t.help1, { dot: <span className="text-accent">●</span> })}</li>
        <li>{t.help2}</li>
        <li>{rich(t.help3, { addGroup: <b>{t.addGroup}</b>, addTag: <b>{t.addTag}</b> })}</li>
        <li>{t.help4}</li>
      </ol>
      <Note>
        {rich(t.help5, {
          del: <kbd className="font-mono">{t.deleteKey}</kbd>,
          esc: <kbd className="font-mono">Esc</kbd>,
        })}
      </Note>
    </>
  );
}
