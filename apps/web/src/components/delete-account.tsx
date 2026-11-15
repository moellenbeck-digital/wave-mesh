"use client";

import { type FormEvent, useState } from "react";
import { useLocale } from "@/components/locale-provider";
import { deleteAccountMessages, failureText, nameList } from "@/i18n/delete-account";
import {
  DEFAULT_WORD,
  type DeleteFailure,
  type DeletePreview,
  hasBilling,
  isBlocked,
  mayDelete,
  readFailure,
} from "@/lib/delete-account";

/**
 * Deleting the account: what it does to every wave, the confirmation, and the
 * page after. The preview is the server's description and the form only sends
 * `POST /api/me/delete` -- every check is made again there, and a refusal comes
 * back as a code that `failureText` turns into a sentence.
 *
 * JSON like the second-factor panel: only `application/json` is taken there,
 * which no foreign form can send.
 */

/** One list of waves under a heading, or nothing when the list is empty. */
function WaveList({ title, hint, names, id }: { title: string; hint: string; names: string[]; id: string }) {
  if (names.length === 0) return null;
  return (
    <div data-testid={id}>
      <h3 className="font-medium text-body-sm text-navy">{title}</h3>
      <p className="text-caption text-slate">{hint}</p>
      <ul className="mt-2 list-disc pl-5 text-body-sm text-navy">
        {names.map((name) => (
          <li key={name}>{name}</li>
        ))}
      </ul>
    </div>
  );
}

/** What the deletion does, before anything is typed. Pure: the same preview gives the same page. */
export function DeletePreviewView({ preview }: { preview: DeletePreview }) {
  const locale = useLocale();
  const t = deleteAccountMessages(locale);
  return (
    <div className="grid gap-6">
      {isBlocked(preview) ? (
        <div className="wc-alert-error grid gap-1" role="alert" data-testid="delete-blocked">
          <p className="font-medium">{t.blockedTitle}</p>
          <p>
            {t.blockedBody(
              nameList(
                preview.blockers.map((wave) => wave.name),
                locale,
              ),
            )}
          </p>
          <ul className="list-disc pl-5">
            {preview.blockers.map((wave) => (
              <li key={wave.id}>{wave.name}</li>
            ))}
          </ul>
          <p>{t.blockedLocked}</p>
        </div>
      ) : null}

      {/* Nothing happens while a wave blocks the deletion, so the consequences are not listed as if it did. */}
      {isBlocked(preview) ? null : <Consequences preview={preview} />}
    </div>
  );
}

function Consequences({ preview }: { preview: DeletePreview }) {
  const t = deleteAccountMessages(useLocale());
  const nothing =
    preview.deleted.length === 0 && preview.handedOver.length === 0 && preview.left.length === 0;
  return (
    <>
      <section className="grid gap-4" aria-labelledby="delete-preview-title">
        <h2 id="delete-preview-title" className="wc-section-title">
          {t.previewTitle}
        </h2>
        <WaveList
          id="delete-deleted"
          title={t.deletedTitle}
          hint={t.deletedHint}
          names={preview.deleted.map((wave) => wave.name)}
        />
        <WaveList
          id="delete-handover"
          title={t.handoverTitle}
          hint={t.handoverHint}
          names={preview.handedOver.map((wave) => wave.name)}
        />
        <WaveList
          id="delete-left"
          title={t.leftTitle}
          hint={t.leftHint}
          names={preview.left.map((wave) => wave.name)}
        />
        {nothing ? <p className="text-body-sm text-slate">{t.nothingElse}</p> : null}
        {preview.devices > 0 ? (
          <p className="text-body-sm text-navy" data-testid="delete-devices">
            {t.devices(preview.devices)}
          </p>
        ) : null}
      </section>

      {hasBilling(preview) ? (
        <div className="wc-alert-error grid gap-2" role="alert" data-testid="delete-billed">
          <p className="font-medium">{t.billedTitle}</p>
          <p>{t.billedBody}</p>
          {preview.billed.length > 0 ? (
            <>
              <p>{t.billedWaves}</p>
              <ul className="list-disc pl-5">
                {preview.billed.map((wave) => (
                  <li key={wave.id}>
                    {wave.name} ({t.outcome[wave.outcome] ?? wave.outcome})
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {preview.accountSubscription ? <p>{t.billedAccount}</p> : null}
        </div>
      ) : null}
    </>
  );
}

export function DeleteAccountPanel({ preview, who }: { preview: DeletePreview; who: string }) {
  const locale = useLocale();
  const t = deleteAccountMessages(locale);
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<DeleteFailure | null>(null);
  const [done, setDone] = useState(false);
  const blocked = isBlocked(preview);

  async function send(event: FormEvent) {
    event.preventDefault();
    if (busy || !mayDelete(preview, confirm, code)) return;
    setBusy(true);
    setFailure(null);
    try {
      const res = await fetch("/api/me/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: confirm.trim(), ...(preview.twoFactor ? { code: code.trim() } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setDone(true);
      else setFailure(readFailure(data));
    } catch {
      setFailure({ kind: "unknown" });
    } finally {
      setBusy(false);
    }
  }

  // The session cookie is gone with the account: no link back into the app except the start page.
  if (done) {
    return (
      <section className="wc-card relative mt-8 rounded-lg p-8" data-testid="delete-done">
        <div className="absolute top-0 right-0 left-0 h-1 rounded-t-lg bg-accent" />
        <h1 className="font-display text-display-sm text-navy">{t.doneTitle}</h1>
        <p className="mt-3 text-body-sm text-slate">{t.doneBody}</p>
        <a href="/" className="wc-btn wc-btn-primary mt-6 inline-flex">
          {t.doneHome}
        </a>
      </section>
    );
  }

  const word = preview.word ?? DEFAULT_WORD;
  return (
    <div className="grid gap-8">
      <p className="animate-fade-in text-body-sm text-slate">{t.intro(who)}</p>
      <DeletePreviewView preview={preview} />

      <section className="wc-card relative rounded-lg p-8">
        <div className="absolute top-0 right-0 left-0 h-1 rounded-t-lg bg-accent" />
        <h2 className="wc-section-title">{t.confirmTitle}</h2>
        {failure ? (
          <p className="wc-alert-error mb-4" role="alert" data-testid="delete-error">
            {failureText(failure, preview.confirmation, locale)}
          </p>
        ) : null}
        <form id="delete-form" className="grid gap-4" onSubmit={send} aria-disabled={blocked}>
          <div>
            <label className="wc-label" htmlFor="delete-confirm">
              {preview.confirmation === "word" ? t.confirmWord(word) : t.confirmEmail}
            </label>
            <input
              id="delete-confirm"
              name="confirm"
              className="wc-input"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              type={preview.confirmation === "word" ? "text" : "email"}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              disabled={blocked}
              required
            />
          </div>
          {preview.twoFactor ? (
            <div>
              <label className="wc-label" htmlFor="delete-code">
                {t.codeLabel}
              </label>
              <input
                id="delete-code"
                name="code"
                className="wc-input font-mono tracking-widest"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                autoComplete="one-time-code"
                autoCapitalize="none"
                spellCheck={false}
                disabled={blocked}
                required
              />
              <p className="mt-1 text-caption text-slate">{t.codeHint}</p>
            </div>
          ) : null}
          <div>
            <button
              type="submit"
              disabled={blocked || busy || !mayDelete(preview, confirm, code)}
              className="wc-btn wc-btn-secondary border-[#dc262626]! text-[#dc2626]! hover:bg-[#dc26260f]!"
            >
              {busy ? t.busy : t.submit}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
