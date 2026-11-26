"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { send } from "@/components/dns-provider-form";
import { useLocale } from "@/components/locale-provider";
import { dnsMessages } from "@/i18n/dns";
import { rich } from "@/i18n/rich";
import type { PierSettings } from "@/lib/control";

/**
 * Which zone a wave's names take through the shared pier (D12): a random one
 * under the server's pier domain, or `pier.<own domain>`. The control server
 * decides what is allowed -- the page only offers what it would accept and
 * shows its refusal otherwise.
 */
export function PierZonePanel({
  waveId,
  pier,
  dnsSuffix,
  placeholder,
}: {
  waveId: string;
  pier: PierSettings;
  dnsSuffix: string;
  placeholder: boolean;
}) {
  const router = useRouter();
  const t = dnsMessages(useLocale());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = pier.names > 0;
  const domain = <code className="font-mono">{pier.sharedDomain ?? ""}</code>;
  const suffix = <code className="font-mono">{dnsSuffix}</code>;

  async function choose(mode: "shared" | "own") {
    setBusy(true);
    setError(null);
    const { ok, payload } = await send("PUT", `/api/waves/${encodeURIComponent(waveId)}/pier-zone`, { mode });
    setBusy(false);
    if (!ok) {
      setError(payload.error ?? t.refused);
      return;
    }
    router.refresh();
  }

  const option = (mode: "shared" | "own", label: React.ReactNode, available: boolean) => (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line p-4">
      <span className="text-body-sm text-navy">{label}</span>
      {pier.mode === mode ? (
        <span className="wc-badge" style={{ backgroundColor: "#0f6e6e14", color: "var(--color-accent)" }}>
          ✓
        </span>
      ) : (
        <button
          type="button"
          className="wc-btn wc-btn-secondary"
          data-action={`pier-zone-${mode}`}
          disabled={busy || locked || !available}
          onClick={() => void choose(mode)}
        >
          {t.pierChoose}
        </button>
      )}
    </li>
  );

  return (
    <div data-pier="zone">
      <h2 className="font-display text-heading-sm text-navy">{t.pierTitle}</h2>
      <p className="mt-2 text-body-sm text-slate">
        {rich(t.pierShared, { expose: <code className="font-mono">wave expose</code> })}
      </p>
      <p className="mt-4 text-body-sm text-navy">
        <span className="text-label text-slate uppercase">{t.pierZone}</span>{" "}
        {pier.zone ? <code className="font-mono">{pier.zone}</code> : rich(t.pierZonePending, { domain })}
      </p>
      <ul className="mt-4 flex flex-col gap-3">
        {pier.sharedDomain ? option("shared", rich(t.pierModeShared, { domain }), true) : null}
        {option("own", rich(t.pierModeOwn, { suffix }), !placeholder)}
      </ul>
      <p className="mt-3 text-caption text-slate">{locked ? t.pierModeLocked : t.pierModeOwnHint}</p>
      {error ? <p className="mt-2 text-caption text-[#dc2626]">{error}</p> : null}
    </div>
  );
}
