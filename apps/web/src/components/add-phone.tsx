"use client";

import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { useLocale } from "@/components/locale-provider";
import { appMessages } from "@/i18n/app";

/**
 * "Add a phone": a QR code the iPhone's camera opens the app with.
 *
 * It carries the control server's address and nothing else -- the same thing
 * `wave login <url>` takes on the desktop, in a form a camera reads. The phone
 * still asks before it connects and still needs the approval in the browser,
 * so a code anybody can photograph grants nothing. The address is this page's
 * own origin: the web interface is served under the control server's name.
 */
export function AddPhone() {
  const t = appMessages(useLocale());
  const [server, setServer] = useState("");
  const [svg, setSvg] = useState("");

  useEffect(() => {
    const origin = window.location.origin;
    setServer(origin);
    const link = `wavemesh://join?server=${encodeURIComponent(origin)}`;
    void QRCode.toString(link, { type: "svg", margin: 1, errorCorrectionLevel: "M" }).then(setSvg);
  }, []);

  return (
    <details className="mt-4">
      <summary className="cursor-pointer text-caption text-accent">{t.addPhone}</summary>
      <div className="mt-4 flex flex-wrap items-start gap-6">
        <div
          className="h-40 w-40 rounded-lg border border-line bg-white p-2"
          role="img"
          aria-label={t.addPhoneCode}
          // The SVG comes from the qrcode library, built from this page's own
          // origin; there is nothing in it a person typed.
          // biome-ignore lint/security/noDangerouslySetInnerHtml: generated SVG, no user input
          dangerouslySetInnerHTML={{ __html: svg }}
        />
        <div className="max-w-sm text-caption text-slate">
          <p>{t.addPhoneHint}</p>
          <p className="mt-2">
            {t.addPhoneManual} <code className="break-all font-mono text-navy">{server}</code>
          </p>
        </div>
      </div>
    </details>
  );
}
