"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useLocale } from "@/components/locale-provider";
import { aclMessages } from "@/i18n/acl";

/**
 * The policy as a document, for whoever would rather type it than draw it (the
 * graph in `acl-graph` is the other way in). A JSON call to the control server
 * rather than a form post, because a policy is a document, not a field -- and
 * the answer to a policy that does not hold is a list of reasons, which a
 * redirect cannot carry.
 *
 * The same origin as the page, so the session cookie comes along; what keeps
 * another page from doing the same is `SameSite=Lax` and the JSON content
 * type, which no cross-site form can send.
 */

const example = (user: string) => `{
  "acls": [
    { "src": ["user:${user}"], "dst": ["*"] }
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
  const t = aclMessages(useLocale());
  // The example names a user in the reader's language; it is only ever a starting point.
  const blank = example(t.exampleUser);
  const [text, setText] = useState(policy ? JSON.stringify(policy, null, 2) : blank);
  const [problems, setProblems] = useState<Problems>({ errors: [], warnings: [] });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save() {
    setSaved(false);
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch (error) {
      setProblems({ errors: [t.invalidJson((error as Error).message)], warnings: [] });
      return;
    }
    setBusy(true);
    const { ok, payload } = await send("PUT", `/api/waves/${encodeURIComponent(waveId)}/acl`, document);
    setBusy(false);
    setProblems({
      errors: ok ? [] : (payload.errors ?? [payload.error ?? t.refused]),
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
    if (!window.confirm(t.confirmRemove)) return;
    setBusy(true);
    const { ok, payload } = await send("DELETE", `/api/waves/${encodeURIComponent(waveId)}/acl`);
    setBusy(false);
    if (!ok) {
      setProblems({ errors: [payload.error ?? t.refused], warnings: [] });
      return;
    }
    setText(blank);
    setProblems({ errors: [], warnings: [] });
    router.refresh();
  }

  return (
    <div>
      <label className="wc-label" htmlFor={`policy-${waveId}`}>
        {t.policyLabel}
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
            <li key={warning}>{t.hint(warning)}</li>
          ))}
        </ul>
      ) : null}
      {saved ? (
        <p className="wc-alert-success mt-4" role="status">
          {t.applied}
        </p>
      ) : null}

      <div className="mt-6 flex flex-wrap gap-3">
        <button type="button" className="wc-btn wc-btn-primary" onClick={save} disabled={busy}>
          {t.save}
        </button>
        {policy ? (
          <button type="button" className="wc-btn wc-btn-secondary" onClick={remove} disabled={busy}>
            {t.removePolicy}
          </button>
        ) : null}
      </div>
    </div>
  );
}
