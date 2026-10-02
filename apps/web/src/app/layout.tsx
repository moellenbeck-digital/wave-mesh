import type { Metadata } from "next";
import { Inter, Space_Grotesk } from "next/font/google";
import type { ReactNode } from "react";
import { LocaleProvider } from "@/components/locale-provider";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { appMessages } from "@/i18n/app";
import { fetchMe } from "@/lib/control";
import { getLocale } from "@/lib/i18n";
import "./globals.css";

// Self-hosted by next/font, so no request leaves the browser at runtime.
const display = Space_Grotesk({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-space-grotesk",
});
const body = Inter({ subsets: ["latin"], variable: "--font-inter" });

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
