"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useLocale } from "@/components/locale-provider";
import { dnsMessages } from "@/i18n/dns";
import { rich } from "@/i18n/rich";
import type { DnsProviderKind, DnsSettings } from "@/lib/control";

/**
 * Choosing how a wave answers dns-01. A JSON call rather than a form post, like
 * the policy editor: the control server tries the credential against the zone
 * before it keeps it, and when that fails the reason belongs next to the field
 * -- with what was typed still in it, not on a bare error page.
 *
 * The credential only ever travels one way. The page never receives it back,
 * so replacing it means typing it again.
 */

export async function send(method: "PUT" | "DELETE", path: string, body?: unknown) {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const payload = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: res.ok, payload };
}

export function DnsProviderForm({
  waveId,
  settings,
  onSaved,
  onCancel,
}: {
  waveId: string;
  settings: DnsSettings;
  /** Called once the control server has kept the credential; the panel closes the form then. */
  onSaved: (kind: DnsProviderKind) => void;
  /** The way back; without it the form is the only thing on the page and has nowhere to go. */
  onCancel?: () => void;
}) {
  const router = useRouter();
  const t = dnsMessages(useLocale());
  // Without the sealing key the server stores nothing but `manual`; offering
  // the others would only lead to a refusal after the token was typed.
  const choices = settings.providers.filter((kind) => settings.sealing || kind === "manual");
  const [kind, setKind] = useState<DnsProviderKind>(
    settings.provider && choices.includes(settings.provider) ? settings.provider : (choices[0] ?? "manual"),
  );
  const [token, setToken] = useState("");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [totpSecret, setTotpSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = `/api/waves/${encodeURIComponent(waveId)}/dns`;
  const cert = <code className="font-mono">wave cert</code>;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const body =
      kind === "inwx"
        ? { provider: kind, user, password, totpSecret }
        : kind === "manual"
          ? { provider: kind }
          : { provider: kind, token };
    const { ok, payload } = await send("PUT", path, body);
    setBusy(false);
    if (!ok) {
      setError(payload.error ?? t.refused);
      return;
    }
    // Gone from the page as soon as it is stored: it is not going to be shown again anyway.
    setToken("");
    setPassword("");
    setTotpSecret("");
    router.refresh();
    onSaved(kind);
  }

  return (
    <form onSubmit={save}>
      <label className="wc-label" htmlFor={`dns-kind-${waveId}`}>
        {t.providerLabel}
      </label>
      <select
        id={`dns-kind-${waveId}`}
        className="wc-input"
        value={kind}
        onChange={(event) => {
          setKind(event.target.value as DnsProviderKind);
          setError(null);
        }}
      >
        {choices.map((choice) => (
          <option key={choice} value={choice}>
            {t.providerName(choice)}
          </option>
        ))}
      </select>
      <p className="mt-2 text-caption text-slate">{rich(t.providerHint(kind), { cert })}</p>

      {kind === "cloudflare" || kind === "hetzner" || kind === "ionos" ? (
        <div className="mt-4">
          <label className="wc-label" htmlFor={`dns-token-${waveId}`}>
            {t.tokenLabel(kind)}
          </label>
          <input
            id={`dns-token-${waveId}`}
            className="wc-input font-mono"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(event) => setToken(event.target.value)}
            required
          />
        </div>
      ) : null}

      {kind === "inwx" ? (
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div>
            <label className="wc-label" htmlFor={`dns-user-${waveId}`}>
              {t.inwxUser}
            </label>
            <input
              id={`dns-user-${waveId}`}
              className="wc-input"
              autoComplete="off"
              spellCheck={false}
              value={user}
              onChange={(event) => setUser(event.target.value)}
              required
            />
          </div>
          <div>
            <label className="wc-label" htmlFor={`dns-password-${waveId}`}>
              {t.inwxPassword}
            </label>
            <input
              id={`dns-password-${waveId}`}
              className="wc-input"
              type="password"
              autoComplete="off"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>
          <div className="md:col-span-2">
            <label className="wc-label" htmlFor={`dns-totp-${waveId}`}>
              {t.inwxTotp}
            </label>
            <input
              id={`dns-totp-${waveId}`}
              className="wc-input font-mono"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={totpSecret}
              onChange={(event) => setTotpSecret(event.target.value)}
            />
          </div>
        </div>
      ) : null}

      {kind !== "manual" ? <p className="mt-3 text-caption text-slate">{t.stored}</p> : null}

      {error ? (
        <p className="wc-alert-error mt-4 text-caption" role="alert">
          {error}
        </p>
      ) : null}

      <div className="mt-6 flex flex-wrap gap-3">
        <button type="submit" className="wc-btn wc-btn-primary" disabled={busy}>
          {busy ? t.saving : t.save}
        </button>
        {onCancel ? (
          <button
            id={`dns-cancel-${waveId}`}
            type="button"
            className="wc-btn wc-btn-secondary"
            onClick={onCancel}
            disabled={busy}
          >
            {t.cancel}
          </button>
        ) : null}
      </div>
    </form>
  );
}
