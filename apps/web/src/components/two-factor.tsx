"use client";

import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { type FormEvent, useEffect, useState } from "react";
import { useLocale } from "@/components/locale-provider";
import { accountMessages } from "@/i18n/account";
// Types only: `@/lib/control` reads the request's cookies on the server.
import type { TwoFactorStatus } from "@/lib/control";
import { formatDate } from "@/lib/format";

/**
 * Setting up, renewing and switching off the second factor of the password
 * login. JSON calls to the control server, like the policy editor: only
 * `application/json` is taken there, which no foreign form can send, and the
 * session cookie does not travel cross-site anyway.
 */

type Step =
  | { kind: "idle" }
  | { kind: "scan"; secret: string; uri: string; svg: string }
  | { kind: "codes"; codes: string[] };

async function post(
  path: string,
  body: unknown = {},
): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, data };
}

/** A code field: six digits from the app, or a recovery code. */
function CodeForm({
  id,
  label,
  submit,
  busy,
  onSubmit,
  danger = false,
}: {
  id: string;
  label: string;
  submit: string;
  busy: boolean;
  onSubmit: (code: string) => void;
  danger?: boolean;
}) {
  const [code, setCode] = useState("");
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (code.trim()) onSubmit(code.trim());
      }}
    >
      <div className="min-w-0 flex-1">
        <label className="wc-label" htmlFor={id}>
          {label}
        </label>
        <input
          id={id}
          className="wc-input font-mono tracking-widest"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          autoComplete="one-time-code"
          autoCapitalize="none"
          spellCheck={false}
          required
        />
      </div>
      <button
        type="submit"
        disabled={busy}
        className={`wc-btn ${danger ? "wc-btn-secondary border-[#dc262626]! text-[#dc2626]! hover:bg-[#dc26260f]!" : "wc-btn-primary"}`}
      >
        {submit}
      </button>
    </form>
  );
}

export function TwoFactorPanel({ status }: { status: TwoFactorStatus }) {
  const router = useRouter();
  const locale = useLocale();
  const t = accountMessages(locale);
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  // Leaving the page while codes are on screen would lose them for good.
  useEffect(() => {
    if (step.kind !== "codes") return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [step.kind]);

  const fail = (data: Record<string, unknown>) =>
    setError(t.errors[String(data.error)] ?? t.errors.unknown ?? null);

  async function start() {
    setBusy(true);
    setError(null);
    const { ok, data } = await post("/api/me/2fa/setup");
    setBusy(false);
    if (!ok) return fail(data);
    const uri = String(data.uri);
    // Drawn here, as an SVG: the secret never goes to a third party's QR
    // service, and an SVG stays sharp at any size the camera needs.
    const svg = await QRCode.toString(uri, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    setStep({ kind: "scan", secret: String(data.secret), uri, svg });
  }

  async function act(path: string, code: string, after: (data: Record<string, unknown>) => void) {
    setBusy(true);
    setError(null);
    const { ok, data } = await post(path, { code });
    setBusy(false);
    if (!ok) return fail(data);
    after(data);
  }

  const codes = (data: Record<string, unknown>) =>
    setStep({ kind: "codes", codes: (data.recoveryCodes as string[] | undefined) ?? [] });

  if (!status.available) return <p className="text-body-sm text-slate">{t.noPassword}</p>;

  return (
    <div className="grid gap-6">
      <p className="max-w-prose text-body-sm text-slate">{t.securityIntro}</p>

      {error ? (
        <p className="wc-alert-error" role="alert">
          {error}
        </p>
      ) : null}

      {step.kind === "codes" ? (
        <div className="grid gap-4">
          <h3 className="font-display font-semibold text-headline text-navy">{t.recoveryTitle}</h3>
          <p className="max-w-prose text-body-sm text-slate">{t.recoveryIntro}</p>
          <ul className="grid grid-cols-2 gap-2 rounded-lg bg-[#0f27440a] p-4 font-mono text-body text-navy sm:grid-cols-5">
            {step.codes.map((code) => (
              <li key={code}>{code}</li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              className="wc-btn wc-btn-secondary"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(step.codes.join("\n"))
                  .then(() => setCopied(true))
                  .catch(() => {});
              }}
            >
              {copied ? t.copied : t.copy}
            </button>
            <button
              type="button"
              className="wc-btn wc-btn-primary"
              onClick={() => {
                setStep({ kind: "idle" });
                setCopied(false);
                router.refresh();
              }}
            >
              {t.done}
            </button>
          </div>
        </div>
      ) : step.kind === "scan" ? (
        <div className="grid gap-6 md:grid-cols-[auto_minmax(0,1fr)]">
          <div className="grid gap-3">
            <h3 className="font-medium text-body-sm text-navy">{t.scanTitle}</h3>
            <div
              role="img"
              aria-label={t.scanAlt}
              className="h-48 w-48 rounded-lg border border-line bg-white p-2"
              // The SVG comes from the qrcode library, built from a URI this
              // page got from our own server -- not from anything typed.
              // biome-ignore lint/security/noDangerouslySetInnerHtml: generated QR markup, see above
              dangerouslySetInnerHTML={{ __html: step.svg }}
            />
            <p className="text-caption text-slate">{t.manualKey}</p>
            <code className="break-all font-mono text-caption text-navy">{step.secret}</code>
          </div>
          <div className="grid content-start gap-3">
            <h3 className="font-medium text-body-sm text-navy">{t.confirmTitle}</h3>
            <CodeForm
              id="2fa-confirm"
              label={t.codeLabel}
              submit={t.confirm}
              busy={busy}
              onSubmit={(code) => act("/api/me/2fa/confirm", code, codes)}
            />
            <button
              type="button"
              className="justify-self-start text-caption text-slate hover:text-navy"
              onClick={() => setStep({ kind: "idle" })}
            >
              {t.cancel}
            </button>
          </div>
        </div>
      ) : status.enabled ? (
        <div className="grid gap-6">
          <p className="text-body-sm text-navy">
            {t.statusOn(formatDate(status.enabledAt, locale))} {t.recoveryLeft(status.recoveryCodesLeft)}
          </p>
          <div className="grid gap-2">
            <p className="text-caption text-slate">{t.newCodesIntro}</p>
            <CodeForm
              id="2fa-renew"
              label={t.codeOrRecovery}
              submit={t.newCodes}
              busy={busy}
              onSubmit={(code) => act("/api/me/2fa/recovery-codes", code, codes)}
            />
          </div>
          <div className="grid gap-2">
            <p className="text-caption text-slate">{t.turnOffIntro}</p>
            <CodeForm
              id="2fa-off"
              label={t.codeOrRecovery}
              submit={t.turnOff}
              busy={busy}
              danger
              onSubmit={(code) => act("/api/me/2fa/disable", code, () => router.refresh())}
            />
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-4">
          <p className="text-body-sm text-navy">{t.statusOff}</p>
          <button type="button" className="wc-btn wc-btn-primary" onClick={start} disabled={busy}>
            {t.setUp}
          </button>
        </div>
      )}
    </div>
  );
}
