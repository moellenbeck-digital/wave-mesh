import type { Metadata } from "next";
import { Inter, Space_Grotesk } from "next/font/google";
import type { ReactNode } from "react";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { fetchMe } from "@/lib/control";
import "./globals.css";

// Self-hosted by next/font, so no request leaves the browser at runtime.
const display = Space_Grotesk({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-space-grotesk",
});
const body = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: "wave-mesh Control",
  description: "Verwaltung für ein selbst gehostetes Mesh-VPN auf WireGuard-Basis.",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // The header is decoration; if the control server is unreachable the page
  // below says so properly. Failing here would replace that with a blank 500.
  const me = await fetchMe().catch(() => null);

  return (
    <html lang="de" className={`${display.variable} ${body.variable}`}>
      <body className="min-h-screen antialiased">
        <SiteHeader me={me} />
        <main className="relative z-10 flex min-h-screen flex-col pt-16">
          <div className="mx-auto w-full max-w-5xl flex-1 px-6 py-12">{children}</div>
          <SiteFooter />
        </main>
      </body>
    </html>
  );
}
