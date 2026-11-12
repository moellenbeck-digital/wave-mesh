import type { Metadata } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import { LocaleProvider } from "@/components/locale-provider";
import { PlausibleScript } from "@/components/plausible-script";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { appMessages } from "@/i18n/app";
import { fetchMe } from "@/lib/control";
import { getLocale } from "@/lib/i18n";
import "./globals.css";

// The fonts are files in this repo (src/fonts, latin subset, licences beside
// them), loaded by next/font/local. Neither the build nor the browser asks a
// font host for anything. The Google loader fetched them at build time, and
// a network hiccup there failed the whole image build.
const display = localFont({
  src: [
    { path: "../fonts/space-grotesk-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "../fonts/space-grotesk-latin-600-normal.woff2", weight: "600", style: "normal" },
    { path: "../fonts/space-grotesk-latin-700-normal.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-space-grotesk",
});
// Inter ships as one variable file covering every weight the pages use.
const body = localFont({
  src: "../fonts/inter-latin-wght-normal.woff2",
  weight: "100 900",
  style: "normal",
  variable: "--font-inter",
});

export async function generateMetadata(): Promise<Metadata> {
  return { title: "wave-mesh Control", description: appMessages(await getLocale()).metaDescription };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  // The header is decoration; if the control server is unreachable the page
  // below says so properly. Failing here would replace that with a blank 500.
  const me = await fetchMe().catch(() => null);
  const locale = await getLocale();

  return (
    <html lang={locale} className={`${display.variable} ${body.variable}`}>
      <head>
        {/* Only where ops sets the variables; see lib/plausible.ts. */}
        <PlausibleScript />
      </head>
      <body className="min-h-screen antialiased">
        {/* Around everything, so a client component anywhere -- error.tsx
            included -- renders in the language the server chose. */}
        <LocaleProvider locale={locale}>
          <SiteHeader me={me} locale={locale} />
          <main className="relative z-10 flex min-h-screen flex-col pt-16">
            <div className="mx-auto w-full max-w-5xl flex-1 px-6 py-12">{children}</div>
            <SiteFooter locale={locale} />
          </main>
        </LocaleProvider>
      </body>
    </html>
  );
}
