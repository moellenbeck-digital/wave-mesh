"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale } from "@/components/locale-provider";
import { aclMessages } from "@/i18n/acl";
import { rich } from "@/i18n/rich";
// Types only: `@/lib/control` reads the request's cookies on the server.
import type { AclPreview, AclView } from "@/lib/control";
import { Graph } from "./graph";
import {
  changedTags,
  type Draft,
  draftFrom,
  edgeId,
  isDirty,
  kindOf,
  layout,
  nodesOf,
  policyOf,
  viewHeight,
} from "./model";
import {
  CreatePanel,
  EdgePanel,
  GroupPanel,
  HelpPanel,
  NodePanel,
  type PanelActions,
  TagPanel,
} from "./panel";

/**
 * Who may reach whom, drawn: every card is something a rule can name, every
 * arrow is a rule. Policy and tags are edited together as one draft and saved
 * together, because they only mean something together -- a rule for `tag:nas`
 * reaches whatever wears it.
 *
 * What the draft comes to is never worked out here. Every change goes to
 * `/acl/preview`, where the code that builds the netmaps judges it; a second
 * evaluation in the browser would be a second answer, and the day the two
 * differ the page would promise what the devices do not do.
 */

interface Ui {
  edge: string | null;
  node: string | null;
  /** A connection started by tapping a card's dot, waiting for its target. */
  pending: string | null;
  /** The first arrow in the full mesh, waiting to be confirmed. */
  confirm: { src: string; dst: string } | null;
  creating: "group" | "tag" | null;
}

const NONE: Ui = { edge: null, node: null, pending: null, confirm: null, creating: null };

async function send(method: "PUT" | "DELETE" | "POST", path: string, body?: unknown, signal?: AbortSignal) {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? "{}" : JSON.stringify(body),
    signal,
  });
  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, payload };
}

const clone = (draft: Draft): Draft => structuredClone(draft);

export function AclGraph({ waveId, view }: { waveId: string; view: AclView }) {
  const router = useRouter();
  const t = aclMessages(useLocale());
  const base = `/api/waves/${encodeURIComponent(waveId)}`;
  const [draft, setDraft] = useState<Draft>(() => draftFrom(view));
  const [ui, setUi] = useState<Ui>(NONE);
  const [preview, setPreview] = useState<AclPreview | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ errors: string[]; warnings: string[]; saved: boolean }>({
    errors: [],
    warnings: [],
    saved: false,
  });
  const [toast, setToast] = useState<string | null>(null);
  const history = useRef<Draft[]>([]);

  // Where the cards stand is a convenience of this browser, nothing the
  // server keeps: computed by column, and moved cards remembered per wave.
  const layoutKey = `wave-acl-layout:${waveId}`;
  const [moved, setMoved] = useState<Record<string, { x: number; y: number }>>({});
  useEffect(() => {
    try {
      setMoved(JSON.parse(localStorage.getItem(layoutKey) ?? "{}"));
    } catch {}
  }, [layoutKey]);

  // A fresh view after saving replaces the draft -- unless something in it did
  // not make it, which would otherwise vanish with the refresh.
  useEffect(() => {
    setDraft((current) => (isDirty(current, view) ? current : draftFrom(view)));
  }, [view]);

  const nodes = useMemo(() => nodesOf(draft, view), [draft, view]);
  const positions = useMemo(() => ({ ...layout(nodes), ...moved }), [nodes, moved]);
  const height = viewHeight(Object.fromEntries(nodes.map((n) => [n.id, positions[n.id] ?? { x: 0, y: 0 }])));
  const dirty = isDirty(draft, view);

  const say = useCallback((text: string) => {
    setToast(text);
    window.setTimeout(() => setToast((current) => (current === text ? null : current)), 2400);
  }, []);

  // The draft in a ref as well, so a change is pushed onto the history once:
  // an updater function would run twice under React's strict mode.
  const latest = useRef(draft);
  useEffect(() => {
    latest.current = draft;
  }, [draft]);
  const change = useCallback((mutate: (draft: Draft) => void) => {
    const current = latest.current;
    history.current.push(clone(current));
    if (history.current.length > 60) history.current.shift();
    const next = clone(current);
    mutate(next);
    latest.current = next;
    setDraft(next);
    setResult((r) => ({ ...r, saved: false }));
  }, []);

  function undo() {
    const previous = history.current.pop();
    if (!previous) return;
    setDraft(previous);
    setUi((u) => ({
      ...u,
      confirm: null,
      edge: previous.edges.some((e) => e.id === u.edge) ? u.edge : null,
    }));
    say(t.undone);
  }

  // ---- preview, debounced and cancelled when the next change comes ----
  const selectors = nodes.map((n) => n.id).join("\n");
  const previewBody = JSON.stringify({
    policy: policyOf(draft),
    tags: draft.tags,
    selectors: selectors.split("\n"),
  });
  useEffect(() => {
    const abort = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const { ok, payload } = await send(
          "POST",
          `${base}/acl/preview`,
          JSON.parse(previewBody),
          abort.signal,
        );
        if (!ok) throw new Error(String(payload.error ?? "preview refused"));
        setPreview(payload as unknown as AclPreview);
        setPreviewFailed(false);
      } catch (error) {
        if ((error as Error).name !== "AbortError") setPreviewFailed(true);
      }
    }, 250);
    return () => {
      abort.abort();
      window.clearTimeout(timer);
    };
  }, [base, previewBody]);

  // ---- connecting ----
  function connect(src: string, dst: string) {
    if (kindOf(src) === "svc") {
      say(t.svcOnlyTarget);
      return;
    }
    const existing = draft.edges.find((e) => e.src === src && e.dst === dst);
    if (existing) {
      setUi({ ...NONE, edge: existing.id });
      say(t.edgeExists);
      return;
    }
    if (!draft.policy) {
      setUi({ ...NONE, confirm: { src, dst } });
      return;
    }
    const id = edgeId();
    change((d) => {
      d.edges.push({ id, src, dst, ports: [] });
    });
    setUi({ ...NONE, edge: id });
  }

  function confirmFirst() {
    if (!ui.confirm) return;
    const { src, dst } = ui.confirm;
    const id = edgeId();
    change((d) => {
      d.policy = true;
      d.edges = [{ id, src, dst, ports: [] }];
    });
    setUi({ ...NONE, edge: id });
  }

  const actions: PanelActions = {
    change,
    connect,
    selectEdge: (id) => setUi({ ...NONE, edge: id }),
    selectNode: (id) => setUi({ ...NONE, node: id }),
    created: (id, kind) => {
      setUi({ ...NONE, node: id });
      say(t.created(id, kind));
    },
    cancelCreate: () => setUi(NONE),
  };

  // ---- keyboard ----
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.target as Element | null)?.closest("input, select, textarea")) return;
      if ((event.key === "Delete" || event.key === "Backspace") && ui.edge) {
        const gone = ui.edge;
        change((d) => {
          d.edges = d.edges.filter((e) => e.id !== gone);
        });
        setUi(NONE);
      } else if (event.key === "Escape") {
        setUi(NONE);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ui.edge, change]);

  // ---- saving: tags first, then the policy that names them ----
  async function save() {
    setBusy(true);
    const errors: string[] = [];
    let warnings: string[] = [];
    const name = new Map(view.devices.map((d) => [d.id, d.hostname]));
    for (const [id, tags] of Object.entries(changedTags(draft, view))) {
      const { ok, payload } = await send("PUT", `${base}/nodes/${encodeURIComponent(id)}/tags`, { tags });
      if (!ok) errors.push(`${name.get(id) ?? id}: ${String(payload.error ?? t.refusedShort)}`);
    }
    if (errors.length === 0) {
      const policy = policyOf(draft);
      if (policy !== null) {
        const { ok, payload } = await send("PUT", `${base}/acl`, policy);
        warnings = (payload.warnings as string[] | undefined) ?? [];
        if (!ok)
          errors.push(
            ...((payload.errors as string[] | undefined) ?? [String(payload.error ?? t.refusedShort)]),
          );
      } else if (view.policy !== null) {
        const { ok, payload } = await send("DELETE", `${base}/acl`);
        if (!ok) errors.push(String(payload.error ?? t.refusedShort));
      }
    }
    setBusy(false);
    setResult({ errors, warnings, saved: errors.length === 0 });
    if (errors.length === 0) history.current = [];
    router.refresh();
  }

  function discard() {
    history.current = [];
    setDraft(draftFrom(view));
    setUi(NONE);
    setResult({ errors: [], warnings: [], saved: false });
  }

  // ---- what the cards say about themselves ----
  const hostnames = new Map(view.devices.map((d) => [d.id, d.hostname]));
  const subtitles: Record<string, string> = {};
  for (const node of nodes) {
    if (node.kind === "any") {
      subtitles[node.id] = t.anySubtitle;
      continue;
    }
    if (node.kind === "svc") {
      subtitles[node.id] = view.services.find((s) => `svc:${s.name}` === node.id)?.ipv4 ?? t.noSuchService;
      continue;
    }
    const covers = preview?.covers[node.id];
    if (!covers) continue;
    const names = covers.nodes.map((id) => hostnames.get(id) ?? id);
    subtitles[node.id] =
      names.length === 0
        ? t.noDevices
        : names.length === 1
          ? (names[0] ?? "")
          : t.someDevices(names.length, names.join(", "));
  }

  const reached = new Set(preview?.reach?.flatMap((pair) => [pair.from, pair.to]) ?? []);
  const isolated = new Set<string>();
  if (draft.policy && preview?.reach) {
    for (const node of nodes) {
      const covers = preview.covers[node.id];
      if (!covers) continue;
      if (node.kind === "svc" && !reached.has(node.id)) isolated.add(node.id);
      if ((node.kind === "user" || node.kind === "tag") && covers.nodes.length > 0) {
        if (covers.nodes.every((id) => !reached.has(hostnames.get(id) ?? id))) isolated.add(node.id);
      }
    }
  }
  const cut = [...view.devices.map((d) => d.hostname), ...view.services.map((s) => `svc:${s.name}`)].filter(
    (name) => !reached.has(name),
  );

  const edge = draft.edges.find((e) => e.id === ui.edge);
  const exists = (id: string) => nodes.some((n) => n.id === id);
  const rules = (policyOf(draft) as { acls?: unknown[] } | null)?.acls?.length ?? 0;

  let panel: React.ReactNode;
  if (ui.creating)
    panel = <CreatePanel key={ui.creating} kind={ui.creating} exists={exists} actions={actions} />;
  else if (edge) panel = <EdgePanel key={edge.id} edge={edge} draft={draft} actions={actions} />;
  else if (ui.node && kindOf(ui.node) === "group" && ui.node in draft.groups)
    panel = (
      <GroupPanel key={ui.node} id={ui.node} draft={draft} view={view} preview={preview} actions={actions} />
    );
  else if (ui.node && kindOf(ui.node) === "tag")
    panel = <TagPanel key={ui.node} id={ui.node} draft={draft} view={view} actions={actions} />;
  else if (ui.node) panel = <NodePanel id={ui.node} draft={draft} view={view} preview={preview} />;
  else panel = <HelpPanel />;

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="wc-btn wc-btn-primary px-4! py-2!"
          onClick={() => setUi({ ...NONE, creating: "group" })}
        >
          {t.addGroup}
        </button>
        <button
          type="button"
          className="wc-btn wc-btn-primary px-4! py-2!"
          onClick={() => setUi({ ...NONE, creating: "tag" })}
        >
          {t.addTag}
        </button>
        <button
          type="button"
          className="wc-btn wc-btn-secondary px-4! py-2! disabled:opacity-40"
          onClick={undo}
          disabled={history.current.length === 0}
        >
          {t.undo}
        </button>
        <span className="flex-1" />
        <span
          className="wc-badge"
          style={
            !draft.policy
              ? { backgroundColor: "#0f27440f", color: "#7c8b9a" }
              : rules === 0
                ? { backgroundColor: "#dc26260f", color: "#dc2626" }
                : { backgroundColor: "#0f6e6e14", color: "#0f6e6e" }
          }
        >
          {!draft.policy ? t.badgeMesh : rules === 0 ? t.badgeNothing : t.badgeRules(rules)}
        </span>
        {draft.policy ? (
          <button
            type="button"
            className="wc-btn wc-btn-secondary px-4! py-2!"
            onClick={() => {
              change((d) => {
                d.policy = false;
                d.edges = [];
              });
              setUi(NONE);
            }}
          >
            {t.removePolicy}
          </button>
        ) : null}
      </div>

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="overflow-hidden rounded-lg border border-line">
          {ui.confirm ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-line border-b bg-[#0f6e6e0f] px-4 py-3 text-accent-strong text-body-sm">
              <span className="min-w-0 break-words">
                {rich(t.confirmFirst, {
                  pair: (
                    <b>
                      {ui.confirm.src} → {ui.confirm.dst}
                    </b>
                  ),
                })}
              </span>
              <span className="ml-auto flex gap-2">
                <button type="button" className="wc-btn wc-btn-primary px-4! py-1.5!" onClick={confirmFirst}>
                  {t.createRule}
                </button>
                <button
                  type="button"
                  className="wc-btn wc-btn-secondary px-4! py-1.5!"
                  onClick={() => setUi(NONE)}
                >
                  {t.cancel}
                </button>
              </span>
            </div>
          ) : !draft.policy ? (
            <div className="border-line border-b bg-[#0f27440a] px-4 py-3 text-body-sm text-navy">
              {t.meshBanner}
            </div>
          ) : null}
          <div className="overflow-x-auto">
            <Graph
              nodes={nodes}
              positions={positions}
              height={height}
              edges={draft.edges}
              mesh={!draft.policy}
              subtitles={subtitles}
              isolated={isolated}
              selectedEdge={ui.edge}
              selectedNode={ui.node}
              pending={ui.pending}
              onMove={(id, to) => setMoved((m) => ({ ...m, [id]: to }))}
              onMoved={() => {
                try {
                  localStorage.setItem(layoutKey, JSON.stringify(positions));
                } catch {}
              }}
              onConnect={connect}
              onSelectEdge={(id) => setUi({ ...NONE, edge: id })}
              onTapNode={(id) => {
                if (ui.pending && ui.pending !== id) {
                  const src = ui.pending;
                  setUi(NONE);
                  connect(src, id);
                } else setUi({ ...NONE, node: id });
              }}
              onTapHandle={(id) => {
                const pending = ui.pending === id ? null : id;
                setUi({ ...NONE, pending });
                if (pending) say(t.tapTarget);
              }}
              onBackground={() => setUi(NONE)}
            />
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1 border-line border-t px-4 py-2.5 text-caption text-slate">
            <span>{rich(t.legendArrow, { start: <em>{t.legendStart}</em> })}</span>
            <span>{t.legendDashed}</span>
          </div>
        </div>

        <aside
          className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 rounded-lg border border-line p-5 xl:sticky xl:top-20"
          aria-live="polite"
        >
          {panel}
        </aside>
      </div>

      {dirty || result.errors.length > 0 || result.saved ? (
        <div className="grid gap-3 rounded-lg border border-line bg-[#0f27440a] p-4">
          {dirty ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="min-w-0 flex-1 text-body-sm text-navy">
                {!draft.policy && view.policy !== null ? t.savingRemoves : t.unsaved}
              </span>
              <button type="button" className="wc-btn wc-btn-secondary" onClick={discard} disabled={busy}>
                {t.discard}
              </button>
              <button
                type="button"
                className="wc-btn wc-btn-primary disabled:opacity-50"
                onClick={save}
                disabled={busy || !preview || preview.errors.length > 0}
              >
                {t.save}
              </button>
            </div>
          ) : null}
          {preview && preview.errors.length > 0 ? (
            <ul className="wc-alert-error" role="alert">
              {preview.errors.map((error) => (
                <li key={error} className="font-mono text-caption">
                  {error}
                </li>
              ))}
            </ul>
          ) : null}
          {result.errors.length > 0 ? (
            <ul className="wc-alert-error" role="alert">
              {result.errors.map((error) => (
                <li key={error} className="font-mono text-caption">
                  {error}
                </li>
              ))}
            </ul>
          ) : null}
          {result.saved && !dirty ? (
            <p className="wc-alert-success" role="status">
              {t.saved}
            </p>
          ) : null}
        </div>
      ) : null}

      {preview && preview.warnings.length > 0 ? (
        <ul className="text-caption text-slate">
          {preview.warnings.map((warning) => (
            <li key={warning}>{t.hint(warning)}</li>
          ))}
        </ul>
      ) : null}

      <div>
        <h3 className="wc-section-title">{dirty ? t.reachDraft : t.reachTitle}</h3>
        {previewFailed ? (
          <p className="text-body-sm text-[#dc2626]">{t.previewFailed}</p>
        ) : !draft.policy ? (
          <p className="text-body-sm text-navy">{t.fullMesh}</p>
        ) : !preview?.reach ? (
          <p className="text-body-sm text-slate">{t.evaluating}</p>
        ) : (
          <ul className="max-h-[28rem] divide-y divide-line overflow-auto">
            {preview.reach.length === 0 ? (
              <li className="py-2 text-body-sm text-slate">{t.nobody}</li>
            ) : (
              preview.reach.map((pair) => (
                <li
                  key={`${pair.from}>${pair.to}`}
                  className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 py-1.5 text-body-sm"
                >
                  <span className="break-words text-navy">
                    <b className="font-semibold">{pair.from}</b>
                    <span className="px-1.5 text-accent">→</span>
                    <b className="font-semibold">{pair.to}</b>
                  </span>
                  <span className="text-right font-mono text-caption text-slate">{pair.ports}</span>
                </li>
              ))
            )}
            {cut.length > 0 ? (
              <li className="break-words py-2 text-[#dc2626] text-body-sm">{t.cutOff(cut.join(", "))}</li>
            ) : null}
          </ul>
        )}
      </div>

      {toast ? (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-navy px-4 py-2 text-body-sm text-white shadow-lg">
          {toast}
        </div>
      ) : null}
    </div>
  );
}
