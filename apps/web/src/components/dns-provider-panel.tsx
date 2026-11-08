"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { DnsProviderForm, send } from "@/components/dns-provider-form";
import { useLocale } from "@/components/locale-provider";
import { dnsMessages } from "@/i18n/dns";
import type { DnsProviderKind, DnsSettings } from "@/lib/control";
import { formatDate } from "@/lib/format";

/**
 * What the certificate page shows for a wave that has a say in dns-01: the
 * provider as a section of its own with Edit and Remove beside it, the form
 * only on request -- or at once when there is nothing yet to edit or remove.
 *
 * The server component hands over fresh settings after every
 * `router.refresh()`; this component keeps only what the server does not
 * know: whether the form is open and what was just saved. It stays mounted
 * across the refresh, so a first save leaves the form closed and the new
 * provider on display.
 *
 * Neither the page nor this component ever holds a credential: the settings
 * name the provider and the date, nothing else.
 */
export function DnsProviderPanel({ waveId, settings }: { waveId: string; settings: DnsSettings }) {
  const router = useRouter();
  const locale = useLocale();
  const t = dnsMessages(locale);
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState<DnsProviderKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const provider = settings.provider;
  const open = !provider || editing;

  async function remove() {
    if (!window.confirm(t.confirmRemove)) return;
    setBusy(true);
    setError(null);
    const { ok, payload } = await send("DELETE", `/api/waves/${encodeURIComponent(waveId)}/dns`);
    setBusy(false);
    if (!ok) {
      setError(payload.error ?? t.refused);
      return;
    }
    setEditing(false);
    setSaved(null);
    router.refresh();
  }

  return (
    <>
      {provider ? (
        <div
          id={`dns-current-${waveId}`}
          className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-line p-4"
        >
          <div>
            <span className="text-label text-slate uppercase">{t.currentLabel}</span>
            <span className="mt-1 block text-body-sm font-medium text-navy">{t.providerName(provider)}</span>
            {settings.updatedAt ? (
              <span className="block text-caption text-slate" suppressHydrationWarning>
                {t.since(formatDate(settings.updatedAt, locale))}
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-3">
            {editing ? null : (
              <button
                id={`dns-edit-${waveId}`}
                type="button"
                className="wc-btn wc-btn-secondary"
                disabled={busy}
                onClick={() => {
                  setSaved(null);
                  setEditing(true);
                }}
              >
                {t.edit}
              </button>
            )}
            <button
              id={`dns-remove-${waveId}`}
              type="button"
              className="wc-btn wc-btn-secondary"
              disabled={busy}
              onClick={remove}
            >
              {t.remove}
            </button>
          </div>
        </div>
      ) : (
        <p className="text-body-sm text-navy">{t.none}</p>
      )}

      {error ? (
        <p className="wc-alert-error mt-4 text-caption" role="alert">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p className="wc-alert-success mt-4" role="status">
          {saved === "manual" ? t.savedManual : t.saved}
        </p>
      ) : null}

      {settings.sealing ? null : <p className="mt-6 text-caption text-slate">{t.noSealing}</p>}

      {open ? (
        <div className="mt-6">
          <DnsProviderForm
            // The provider is part of the key: a removal while the form is open
            // must not leave the old choice standing in it.
            key={provider ?? "none"}
            waveId={waveId}
            settings={settings}
            onSaved={(kind) => {
              setEditing(false);
              setSaved(kind);
            }}
            onCancel={provider ? () => setEditing(false) : undefined}
          />
        </div>
      ) : null}
    </>
  );
}
