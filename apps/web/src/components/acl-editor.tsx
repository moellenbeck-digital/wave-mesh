"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
// Types only: `@/lib/control` reads the request's cookies on the server, and
// anything more than its types would pull that into the browser bundle.
import type { AclDevice } from "@/lib/control";

/**
 * The two things on the policy page that change something: the document and
 * the tags. Both are JSON calls to the control server rather than form posts,
 * because a policy is a document, not a field -- and the answer to a policy
 * that does not hold is a list of reasons, which a redirect cannot carry.
 *
 * The same origin as the page, so the session cookie comes along; what keeps
 * another page from doing the same is `SameSite=Lax` and the JSON content
 * type, which no cross-site form can send.
 */

const EXAMPLE = `{
  "acls": [
    { "src": ["user:ich@example.com"], "dst": ["*"] }
  ]
}`;

interface Problems {
  errors: string[];
  warnings: string[];
}

async function send(method: "PUT" | "DELETE", path: string, body?: unknown) {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => ({}))) as {
    errors?: string[];
    warnings?: string[];
    error?: string;
  };
  return { ok: res.ok, payload };
}

export function PolicyEditor({ waveId, policy }: { waveId: string; policy: unknown | null }) {
  const router = useRouter();
  const [text, setText] = useState(policy ? JSON.stringify(policy, null, 2) : EXAMPLE);
  const [problems, setProblems] = useState<Problems>({ errors: [], warnings: [] });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save() {
    setSaved(false);
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch (error) {
      setProblems({ errors: [`Kein gültiges JSON: ${(error as Error).message}`], warnings: [] });
      return;
    }
    setBusy(true);
    const { ok, payload } = await send("PUT", `/api/waves/${encodeURIComponent(waveId)}/acl`, document);
    setBusy(false);
    setProblems({
      errors: ok ? [] : (payload.errors ?? [payload.error ?? "Der Server hat abgelehnt."]),
      warnings: payload.warnings ?? [],
    });
    if (ok) {
      setSaved(true);
      router.refresh();
    }
  }

  async function remove() {
    // Asked, because it opens everything at once: every device reaches every
    // other again, including the ones the policy was written to keep out.
    if (!window.confirm("Policy entfernen? Danach erreicht wieder jedes Gerät jedes andere.")) return;
    setBusy(true);
    const { ok, payload } = await send("DELETE", `/api/waves/${encodeURIComponent(waveId)}/acl`);
    setBusy(false);
    if (!ok) {
      setProblems({ errors: [payload.error ?? "Der Server hat abgelehnt."], warnings: [] });
      return;
    }
    setText(EXAMPLE);
    setProblems({ errors: [], warnings: [] });
    router.refresh();
  }

  return (
    <div>
      <label className="wc-label" htmlFor={`policy-${waveId}`}>
        Policy (JSON)
      </label>
      <textarea
        id={`policy-${waveId}`}
        className="wc-input min-h-64 font-mono text-caption"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setSaved(false);
        }}
        spellCheck={false}
      />

      {problems.errors.length > 0 ? (
        <ul className="wc-alert-error mt-4" role="alert">
          {problems.errors.map((error) => (
            <li key={error} className="font-mono text-caption">
              {error}
            </li>
          ))}
        </ul>
      ) : null}
      {problems.warnings.length > 0 ? (
        <ul className="mt-4 text-caption text-slate">
          {problems.warnings.map((warning) => (
            <li key={warning}>Hinweis: {warning}</li>
          ))}
        </ul>
      ) : null}
      {saved ? (
        <p className="wc-alert-success mt-4" role="status">
          Übernommen. Verbundene Geräte haben die neue Netzkarte schon.
        </p>
      ) : null}

      <div className="mt-6 flex flex-wrap gap-3">
        <button type="button" className="wc-btn wc-btn-primary" onClick={save} disabled={busy}>
          Speichern
        </button>
        {policy ? (
          <button type="button" className="wc-btn wc-btn-secondary" onClick={remove} disabled={busy}>
            Policy entfernen
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** One device's tags, edited in place; the state belongs to the row. */
function TagRow({ waveId, device }: { waveId: string; device: AclDevice }) {
  const router = useRouter();
  const [text, setText] = useState(device.tags.join(" "));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const changed = text.trim().split(/\s+/).filter(Boolean).join(" ") !== device.tags.join(" ");

  async function save() {
    setBusy(true);
    const tags = text.trim().split(/\s+/).filter(Boolean);
    const { ok, payload } = await send(
      "PUT",
      `/api/waves/${encodeURIComponent(waveId)}/nodes/${encodeURIComponent(device.id)}/tags`,
      { tags },
    );
    setBusy(false);
    setError(ok ? null : (payload.error ?? "Der Server hat abgelehnt."));
    if (ok) router.refresh();
  }

  return (
    <li className="grid grid-cols-1 gap-x-6 gap-y-2 py-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] md:items-center">
      <div className="min-w-0">
        <span className="block truncate font-medium text-navy text-body-sm">{device.hostname}</span>
        {device.ports ? (
          <span className={`block text-caption ${device.enforced ? "text-slate" : "text-navy"}`}>
            {device.ports}
          </span>
        ) : null}
      </div>
      <div>
        <input
          className="wc-input font-mono text-caption"
          aria-label={`Tags von ${device.hostname}`}
          value={text}
          placeholder="tag:nas tag:server"
          onChange={(event) => setText(event.target.value)}
          spellCheck={false}
        />
        {error ? (
          <p className="mt-2 text-caption text-navy" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <div className="md:text-right">
        <button type="button" className="wc-btn wc-btn-secondary" onClick={save} disabled={busy || !changed}>
          Übernehmen
        </button>
      </div>
    </li>
  );
}

export function TagList({ waveId, devices }: { waveId: string; devices: AclDevice[] }) {
  if (devices.length === 0) return <p className="text-body-sm text-slate">Noch keine Geräte.</p>;
  return (
    <ul className="divide-y divide-line">
      {devices.map((device) => (
        <TagRow key={device.id} waveId={waveId} device={device} />
      ))}
    </ul>
  );
}
