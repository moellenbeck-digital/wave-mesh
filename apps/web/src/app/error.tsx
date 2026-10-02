"use client";

import { useLocale } from "@/components/locale-provider";
import { appMessages } from "@/i18n/app";

/**
 * Nearly every failure here is the control server not answering -- the pages
 * are thin wrappers around its API. Say that instead of a bare stack trace.
 */
export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  const t = appMessages(useLocale());
  return (
    <div className="mx-auto max-w-lg text-center">
      <h1 className="font-display text-display-sm text-navy">{t.errorTitle}</h1>
      <p className="mt-3 text-body text-slate">{t.errorText}</p>
      <button type="button" className="wc-btn wc-btn-primary mt-8" onClick={reset}>
        {t.errorRetry}
      </button>
    </div>
  );
}
